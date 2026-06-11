# Bir Server

Minimal FastAPI ingestion server for Bir trace events.

## API

- `GET /health`
- `POST /v1/events`
- `POST /v1/events/batch`
- `GET /v1/events`
- `GET /v1/traces`
- `GET /v1/traces/{trace_id}`
- `POST /v1/experiments`
- `GET /v1/experiments`
- `GET /v1/experiments/{experiment_id}`

Events are validated with Pydantic and persisted as JSONL. By default, the
server writes to `.bir/server-events.jsonl`. Override that path with:

```bash
export BIR_SERVER_EVENT_STORE=tmp/server-events.jsonl
```

Experiments can be uploaded from SDK-created `.summary.json` and `.jsonl`
result files. By default, the server stores them in `.bir/experiments`.
Override that directory with:

```bash
export BIR_EXPERIMENT_STORE=tmp/experiments
```

Ingesting an event with an ID that is already present is idempotent: the server
returns `accepted: 0` and does not append a duplicate row. `POST /v1/events/batch`
accepts a JSON list of events, applies the same validation, redaction, and
duplicate handling per event, and returns the accepted count plus accepted event
IDs. The SDK's `send_events()` uses the batch endpoint and falls back to
per-event posting when the server does not provide it.

Generation token usage and cost values must be non-negative finite numbers.
Retrieval document `rank` values must be non-negative integers, and retrieval
document `score` values must be non-negative finite numbers.

Before accepted events are written, the server applies best-effort redaction to
common secret-like keys and text patterns in event metadata, input, output,
error, and extra payload fields. Capture should still stay opt-in because
redaction is not a substitute for reviewing what applications send.

The Python SDK can send locally recorded events to the server:

```python
from bir import send_events

send_events("http://127.0.0.1:8000")
```

The Python SDK can also send one completed local experiment to the server:

```python
from bir.evals import send_experiment

send_experiment(".bir/experiments/prompt-v1-<experiment-id>.jsonl")
```

Uploaded experiments are exposed as summary rows through `/v1/experiments` and
as summary plus per-example result rows through
`/v1/experiments/{experiment_id}`. Duplicate experiment uploads are idempotent
and do not overwrite the existing stored artifact.

## Development

```bash
python3 -m pip install -e ".[dev]"
pytest
uvicorn app.main:app --reload
```
