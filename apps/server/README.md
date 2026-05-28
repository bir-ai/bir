# Bir Server

Minimal FastAPI ingestion server for Bir trace events.

## API

- `GET /health`
- `POST /v1/events`
- `GET /v1/events`
- `GET /v1/traces`

Events are validated with Pydantic and persisted as JSONL. By default, the
server writes to `.bir/server-events.jsonl`. Override that path with:

```bash
export BIR_SERVER_EVENT_STORE=tmp/server-events.jsonl
```

Ingesting an event with an ID that is already present is idempotent: the server
returns `accepted: 0` and does not append a duplicate row.

The Python SDK can send locally recorded events to the server:

```python
from bir import send_events

send_events("http://127.0.0.1:8000")
```

## Development

```bash
python3 -m pip install -e ".[dev]"
pytest
uvicorn app.main:app --reload
```
