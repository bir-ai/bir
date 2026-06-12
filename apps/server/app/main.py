"""FastAPI application factory and routes for Bir ingestion."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .experiments import JsonlExperimentStore, LocalExperimentReader
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
    TraceEventPayload,
)
from .storage import JsonlEventStore, LocalJsonlEventReader, TraceEventReader

DEFAULT_EVENT_STORE_PATH = Path(".bir/server-events.jsonl")
DEFAULT_EXPERIMENT_STORE_PATH = Path(".bir/experiments")
READ_ONLY_LOCAL_MODE_DETAIL = (
    "Ingestion is disabled: the server is running in read-only local data mode (BIR_DATA_DIR)"
)


def create_app(
    *,
    event_store_path: str | Path | None = None,
    experiment_store_path: str | Path | None = None,
    local_data_dir: str | Path | None = None,
) -> FastAPI:
    """Create a Bir ingestion server with local JSONL-backed stores.

    When ``local_data_dir`` (or the ``BIR_DATA_DIR`` environment variable)
    points at a project's ``.bir`` directory, the server runs in read-only
    local data mode: it reads ``traces.jsonl`` written by the SDK and rejects
    ingestion. Explicit store paths keep the server in ingestion mode even
    when ``BIR_DATA_DIR`` is set, so embedding callers and tests stay hermetic.
    """

    if local_data_dir is not None:
        data_dir = Path(local_data_dir)
    elif event_store_path is None and experiment_store_path is None:
        data_dir = _local_data_dir_from_env()
    else:
        data_dir = None

    app = FastAPI(title="Bir Ingestion Server", version="0.1.0")
    app.state.read_only_local_mode = data_dir is not None
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


def _local_data_dir_from_env() -> Path | None:
    configured_path = os.environ.get("BIR_DATA_DIR")
    if configured_path:
        return Path(configured_path)
    return None


def _reject_in_read_only_local_mode(request: Request) -> None:
    if getattr(request.app.state, "read_only_local_mode", False):
        raise HTTPException(status_code=403, detail=READ_ONLY_LOCAL_MODE_DETAIL)


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
