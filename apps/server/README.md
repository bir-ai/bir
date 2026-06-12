# Bir Server

Minimal FastAPI ingestion server for Bir trace events.

## API

- `GET /health`
- `POST /v1/events`
- `POST /v1/events/batch`
- `GET /v1/events`
- `GET /v1/traces`
- `GET /v1/traces/{trace_id}`
- `GET /v1/playground/status`
- `GET /v1/playground/models`
- `POST /v1/playground/chat`
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

## Playground

The Playground endpoints proxy one non-streaming chat turn to a local
OpenAI-compatible model server and record that turn as ordinary Bir trace
events in the same JSONL event store as uploaded SDK traces.

- `GET /v1/playground/status` reports whether Playground writes are enabled and
  whether the upstream model server can be reached.
- `GET /v1/playground/models` lists model names, preferring upstream
  `/v1/models` and falling back to Ollama's `/api/tags`.
- `POST /v1/playground/chat` accepts `model`, `messages`, optional
  `system_prompt`, optional `temperature`, and optional `session_id`, forwards
  the call to `/v1/chat/completions`, records a `playground.chat` trace plus a
  `playground.llm` generation event, and returns the assistant message,
  `trace_id`, token counts, and latency.

The upstream base URL defaults to local Ollama:

```bash
export BIR_PLAYGROUND_BASE_URL=http://127.0.0.1:11434
```

Set that variable to point at LM Studio, vLLM, or another compatible server.
Playground inputs and outputs are captured intentionally because every chat turn
is an explicit user action for prompt inspection. The same best-effort redaction
used for ingested events still applies before events are written.

## CORS

The dashboard calls the API directly from the browser, so the server allows
its local origins (`http://localhost:3000` and `http://127.0.0.1:3000`) by
default. Override the allowed origins with a comma-separated list:

```bash
export BIR_CORS_ORIGINS="http://localhost:3000,http://dashboard.example:4173"
```

Setting `BIR_CORS_ORIGINS` replaces the defaults instead of extending them.

## Read-only local data mode

Point the server at a project's `.bir` directory to browse SDK-written traces
without uploading them:

```bash
export BIR_DATA_DIR=/path/to/your/project/.bir
uvicorn app.main:app --reload
```

In this mode the server reads `$BIR_DATA_DIR/traces.jsonl` (the file the SDK
writes) directly. The file is re-parsed only when it changes, and a final line
that the SDK is still appending is skipped until the write completes. All read
endpoints work normally; `POST /v1/events`, `POST /v1/events/batch`, and
`POST /v1/experiments` return `403` because the server does not own the data
files.

Playground endpoints are also disabled in read-only local data mode. Status
requests return `enabled: false`; model and chat requests return `403`.

Experiments endpoints read SDK-written artifacts from
`$BIR_DATA_DIR/experiments/` directly, so `run_experiment()` results show up
without a `send_experiment()` upload. SDK summaries record `result_path`
relative to the project root, so the server locates result rows through the
sibling file that shares the summary's stem
(`<stem>.summary.json` / `<stem>.jsonl`), matching how the SDK pairs them.

When `BIR_DATA_DIR` is unset, the server runs exactly as before with its own
ingestion store. Passing an explicit `event_store_path` or
`experiment_store_path` to `create_app()` also keeps the server in ingestion
mode even when `BIR_DATA_DIR` is set.

## Development

```bash
python3 -m pip install -e ".[dev]"
pytest
uvicorn app.main:app --reload
```
