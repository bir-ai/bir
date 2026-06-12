"""FastAPI application factory and routes for Bir ingestion."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .experiments import JsonlExperimentStore, LocalExperimentReader
from .playground import PlaygroundClient, PlaygroundUpstreamError, playground_base_url_from_env, run_chat
from .schemas import (
    ExperimentIngestPayload,
    ExperimentSummaryPayload,
    HealthResponse,
    IngestEventBatchResponse,
    IngestExperimentResponse,
    IngestEventResponse,
    LoadedExperiment,
    LoadedTrace,
    EventStatus,
    EventType,
    PlaygroundChatRequest,
    PlaygroundChatResponse,
    PlaygroundModelsResponse,
    PlaygroundStatusResponse,
    TraceEventPayload,
)
from .storage import JsonlEventStore, LocalJsonlEventReader, TraceEventReader

DEFAULT_EVENT_STORE_PATH = Path(".bir/server-events.jsonl")
DEFAULT_EXPERIMENT_STORE_PATH = Path(".bir/experiments")
DEFAULT_CORS_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")
READ_ONLY_LOCAL_MODE_DETAIL = (
    "Ingestion is disabled: the server is running in read-only local data mode (BIR_DATA_DIR)"
)
PLAYGROUND_READ_ONLY_DETAIL = (
    "The playground is disabled: the server is running in read-only local data mode (BIR_DATA_DIR)"
)


def create_app(
    *,
    event_store_path: str | Path | None = None,
    experiment_store_path: str | Path | None = None,
    local_data_dir: str | Path | None = None,
    playground_base_url: str | None = None,
) -> FastAPI:
    """Create a Bir ingestion server with local JSONL-backed stores.

    When ``local_data_dir`` (or the ``BIR_DATA_DIR`` environment variable)
    points at a project's ``.bir`` directory, the server runs in read-only
    local data mode: it reads ``traces.jsonl`` written by the SDK and rejects
    ingestion. Explicit store paths keep the server in ingestion mode even
    when ``BIR_DATA_DIR`` is set, so embedding callers and tests stay hermetic.

    The playground proxies chat turns to the OpenAI-compatible model server at
    ``playground_base_url`` (or the ``BIR_PLAYGROUND_BASE_URL`` environment
    variable, defaulting to a local Ollama) and records each exchange in the
    event store, so read-only local data mode also disables the playground.
    """

    if local_data_dir is not None:
        data_dir = Path(local_data_dir)
    elif event_store_path is None and experiment_store_path is None:
        data_dir = _local_data_dir_from_env()
    else:
        data_dir = None

    app = FastAPI(title="Bir Ingestion Server", version="0.1.0")
    # The dashboard calls the API straight from the browser, so allow its
    # local origins by default; everything else stays opt-in via env.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins_from_env(),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        allow_private_network=True,
    )
    app.state.read_only_local_mode = data_dir is not None
    app.state.playground_client = PlaygroundClient(playground_base_url or playground_base_url_from_env())
    if data_dir is not None:
        app.state.event_store = LocalJsonlEventReader(data_dir / "traces.jsonl")
        app.state.experiment_store = LocalExperimentReader(data_dir / "experiments")
    else:
        app.state.event_store = JsonlEventStore(event_store_path or _event_store_path_from_env())
        app.state.experiment_store = JsonlExperimentStore(experiment_store_path or _experiment_store_path_from_env())

    @app.exception_handler(RequestValidationError)
    def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": _safe_validation_errors(exc)})

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.post("/v1/events", response_model=IngestEventResponse, status_code=201)
    def ingest_event(event: TraceEventPayload, request: Request, response: Response) -> IngestEventResponse:
        store = _get_writable_event_store(request)
        accepted = 1 if store.append(event) else 0
        if accepted == 0:
            response.status_code = 200
        return IngestEventResponse(accepted=accepted, id=event.id)

    @app.post("/v1/events/batch", response_model=IngestEventBatchResponse, status_code=201)
    def ingest_event_batch(
        events: list[TraceEventPayload],
        request: Request,
        response: Response,
    ) -> IngestEventBatchResponse:
        store = _get_writable_event_store(request)
        accepted_ids = [event.id for event in events if store.append(event)]
        if not accepted_ids:
            response.status_code = 200
        return IngestEventBatchResponse(accepted=len(accepted_ids), event_ids=accepted_ids)

    @app.get("/v1/events", response_model=list[TraceEventPayload])
    def list_events(request: Request) -> list[TraceEventPayload]:
        store = _get_event_store(request)
        return store.load_events()

    @app.get("/v1/traces", response_model=list[LoadedTrace])
    def list_traces(
        request: Request,
        status: EventStatus | None = Query(default=None),
        name: str | None = Query(default=None),
        event_type: EventType | None = Query(default=None),
    ) -> list[LoadedTrace]:
        store = _get_event_store(request)
        return store.load_traces(status=status, name=name, event_type=event_type)

    @app.get("/v1/traces/{trace_id}", response_model=LoadedTrace)
    def get_trace(trace_id: str, request: Request) -> LoadedTrace:
        store = _get_event_store(request)
        trace = store.load_trace(trace_id)
        if trace is None:
            raise HTTPException(status_code=404, detail="Trace not found")
        return trace

    @app.get("/v1/playground/status", response_model=PlaygroundStatusResponse)
    def playground_status(request: Request) -> PlaygroundStatusResponse:
        client = _get_playground_client(request)
        if getattr(request.app.state, "read_only_local_mode", False):
            return PlaygroundStatusResponse(
                enabled=False,
                upstream_base_url=client.base_url,
                upstream_reachable=None,
                detail=PLAYGROUND_READ_ONLY_DETAIL,
            )
        reachable = client.is_reachable()
        return PlaygroundStatusResponse(
            enabled=True,
            upstream_base_url=client.base_url,
            upstream_reachable=reachable,
            detail=None
            if reachable
            else (
                f"Could not reach a model server at {client.base_url}. "
                "Start your local model server (for example Ollama) or set BIR_PLAYGROUND_BASE_URL."
            ),
        )

    @app.get("/v1/playground/models", response_model=PlaygroundModelsResponse)
    def playground_models(request: Request) -> PlaygroundModelsResponse:
        _reject_playground_in_read_only_local_mode(request)
        client = _get_playground_client(request)
        try:
            return PlaygroundModelsResponse(models=client.list_models())
        except PlaygroundUpstreamError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/v1/playground/chat", response_model=PlaygroundChatResponse)
    def playground_chat(chat: PlaygroundChatRequest, request: Request) -> PlaygroundChatResponse:
        _reject_playground_in_read_only_local_mode(request)
        store = _get_writable_event_store(request)
        client = _get_playground_client(request)
        try:
            chat_response, events = run_chat(client, chat)
        except PlaygroundUpstreamError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        for event in events:
            store.append(event)
        return chat_response

    @app.post("/v1/experiments", response_model=IngestExperimentResponse, status_code=201)
    def ingest_experiment(
        experiment: ExperimentIngestPayload,
        request: Request,
        response: Response,
    ) -> IngestExperimentResponse:
        store = _get_writable_experiment_store(request)
        accepted = 1 if store.save_experiment(experiment) else 0
        if accepted == 0:
            response.status_code = 200
        return IngestExperimentResponse(accepted=accepted, id=experiment.summary.experiment_id)

    @app.get("/v1/experiments", response_model=list[ExperimentSummaryPayload])
    def list_experiments(request: Request) -> list[ExperimentSummaryPayload]:
        store = _get_experiment_store(request)
        try:
            return store.list_experiments()
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    @app.get("/v1/experiments/{experiment_id}", response_model=LoadedExperiment)
    def get_experiment(experiment_id: str, request: Request) -> LoadedExperiment:
        store = _get_experiment_store(request)
        try:
            experiment = store.load_experiment(experiment_id)
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        if experiment is None:
            raise HTTPException(status_code=404, detail="Experiment not found")
        return experiment

    return app


def _event_store_path_from_env() -> Path:
    configured_path = os.environ.get("BIR_SERVER_EVENT_STORE")
    if configured_path:
        return Path(configured_path)
    return DEFAULT_EVENT_STORE_PATH


def _experiment_store_path_from_env() -> Path:
    configured_path = os.environ.get("BIR_EXPERIMENT_STORE")
    if configured_path:
        return Path(configured_path)
    return DEFAULT_EXPERIMENT_STORE_PATH


def _cors_origins_from_env() -> list[str]:
    configured_origins = os.environ.get("BIR_CORS_ORIGINS")
    if configured_origins:
        return [origin.strip() for origin in configured_origins.split(",") if origin.strip()]
    return list(DEFAULT_CORS_ORIGINS)


def _local_data_dir_from_env() -> Path | None:
    configured_path = os.environ.get("BIR_DATA_DIR")
    if configured_path:
        return Path(configured_path)
    return None


def _reject_in_read_only_local_mode(request: Request) -> None:
    if getattr(request.app.state, "read_only_local_mode", False):
        raise HTTPException(status_code=403, detail=READ_ONLY_LOCAL_MODE_DETAIL)


def _reject_playground_in_read_only_local_mode(request: Request) -> None:
    if getattr(request.app.state, "read_only_local_mode", False):
        raise HTTPException(status_code=403, detail=PLAYGROUND_READ_ONLY_DETAIL)


def _get_playground_client(request: Request) -> PlaygroundClient:
    client = request.app.state.playground_client
    if not isinstance(client, PlaygroundClient):
        raise RuntimeError("Bir playground client is not configured")
    return client


def _get_event_store(request: Request) -> TraceEventReader:
    store = request.app.state.event_store
    if not isinstance(store, TraceEventReader):
        raise RuntimeError("Bir event store is not configured")
    return store


def _get_writable_event_store(request: Request) -> JsonlEventStore:
    _reject_in_read_only_local_mode(request)
    store = request.app.state.event_store
    if not isinstance(store, JsonlEventStore):
        raise RuntimeError("Bir event store is not configured")
    return store


def _get_experiment_store(request: Request) -> JsonlExperimentStore | LocalExperimentReader:
    store = request.app.state.experiment_store
    if not isinstance(store, (JsonlExperimentStore, LocalExperimentReader)):
        raise RuntimeError("Bir experiment store is not configured")
    return store


def _get_writable_experiment_store(request: Request) -> JsonlExperimentStore:
    _reject_in_read_only_local_mode(request)
    store = request.app.state.experiment_store
    if not isinstance(store, JsonlExperimentStore):
        raise RuntimeError("Bir experiment store is not configured")
    return store


def _safe_validation_errors(exc: RequestValidationError) -> list[dict[str, Any]]:
    return [
        {
            "type": error.get("type"),
            "loc": error.get("loc"),
            "msg": error.get("msg"),
        }
        for error in exc.errors()
    ]


app = create_app()
