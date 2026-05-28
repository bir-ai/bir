from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .schemas import HealthResponse, IngestEventResponse, LoadedTrace, TraceEventPayload
from .storage import JsonlEventStore

DEFAULT_EVENT_STORE_PATH = Path(".bir/server-events.jsonl")


def create_app(*, event_store_path: str | Path | None = None) -> FastAPI:
    app = FastAPI(title="Bir Ingestion Server", version="0.1.0")
    app.state.event_store = JsonlEventStore(event_store_path or _event_store_path_from_env())

    @app.exception_handler(RequestValidationError)
    def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": _safe_validation_errors(exc)})

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.post("/v1/events", response_model=IngestEventResponse, status_code=201)
    def ingest_event(event: TraceEventPayload, request: Request, response: Response) -> IngestEventResponse:
        store = _get_event_store(request)
        accepted = 1 if store.append(event) else 0
        if accepted == 0:
            response.status_code = 200
        return IngestEventResponse(accepted=accepted, id=event.id)

    @app.get("/v1/events", response_model=list[TraceEventPayload])
    def list_events(request: Request) -> list[TraceEventPayload]:
        store = _get_event_store(request)
        return store.load_events()

    @app.get("/v1/traces", response_model=list[LoadedTrace])
    def list_traces(request: Request) -> list[LoadedTrace]:
        store = _get_event_store(request)
        return store.load_traces()

    return app


def _event_store_path_from_env() -> Path:
    configured_path = os.environ.get("BIR_SERVER_EVENT_STORE")
    if configured_path:
        return Path(configured_path)
    return DEFAULT_EVENT_STORE_PATH


def _get_event_store(request: Request) -> JsonlEventStore:
    store = request.app.state.event_store
    if not isinstance(store, JsonlEventStore):
        raise RuntimeError("Bir event store is not configured")
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
