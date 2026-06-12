from __future__ import annotations

import json
import socket
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any, Iterator

from fastapi.testclient import TestClient

from app.main import create_app
from app.playground import playground_base_url_from_env

import pytest

PLAYGROUND_READ_ONLY_DETAIL = (
    "The playground is disabled: the server is running in read-only local data mode (BIR_DATA_DIR)"
)

CHAT_COMPLETION = {
    "id": "chatcmpl-1",
    "model": "llama3.2:1b",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Hello from the stub model."},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19},
}

StubRoutes = dict[tuple[str, str], tuple[int, dict[str, Any]]]
StubRequest = dict[str, Any]


@contextmanager
def stub_upstream(routes: StubRoutes) -> Iterator[tuple[str, list[StubRequest]]]:
    """Serve canned JSON responses on a local port and record incoming requests."""

    requests: list[StubRequest] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self._handle("GET")

        def do_POST(self) -> None:
            self._handle("POST")

        def _handle(self, method: str) -> None:
            content_length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(content_length) if content_length else b""
            requests.append(
                {
                    "method": method,
                    "path": self.path,
                    "body": json.loads(body) if body else None,
                }
            )
            status, payload = routes.get((method, self.path), (404, {"error": {"message": "route not found"}}))
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def unreachable_base_url() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}"


def make_playground_test_client(tmp_path: Path, base_url: str) -> tuple[TestClient, Path]:
    event_store_path = tmp_path / "events.jsonl"
    app = create_app(event_store_path=event_store_path, playground_base_url=base_url)
    return TestClient(app), event_store_path


def make_chat_request(**overrides: object) -> dict[str, object]:
    chat_request: dict[str, object] = {
        "model": "llama3.2:1b",
        "messages": [{"role": "user", "content": "Say hello."}],
    }
    chat_request.update(overrides)
    return chat_request


def test_chat_forwards_to_upstream_and_returns_reply_with_stats(tmp_path: Path) -> None:
    with stub_upstream({("POST", "/v1/chat/completions"): (200, CHAT_COMPLETION)}) as (base_url, requests):
        client, _ = make_playground_test_client(tmp_path, base_url)

        response = client.post(
            "/v1/playground/chat",
            json=make_chat_request(
                system_prompt="Answer briefly.",
                temperature=0.2,
                session_id="session-1",
            ),
        )

    assert response.status_code == 200
    reply = response.json()
    assert reply["message"] == {"role": "assistant", "content": "Hello from the stub model."}
    assert reply["model"] == "llama3.2:1b"
    assert reply["input_tokens"] == 12
    assert reply["output_tokens"] == 7
    assert reply["total_tokens"] == 19
    assert reply["latency_ms"] >= 0
    assert reply["trace_id"].startswith("playground-")
    assert len(requests) == 1
    assert requests[0]["path"] == "/v1/chat/completions"
    assert requests[0]["body"] == {
        "model": "llama3.2:1b",
        "messages": [
            {"role": "system", "content": "Answer briefly."},
            {"role": "user", "content": "Say hello."},
        ],
        "stream": False,
        "temperature": 0.2,
    }


def test_chat_records_trace_that_round_trips_through_trace_endpoints(tmp_path: Path) -> None:
    with stub_upstream({("POST", "/v1/chat/completions"): (200, CHAT_COMPLETION)}) as (base_url, _):
        client, _ = make_playground_test_client(tmp_path, base_url)

        chat_response = client.post(
            "/v1/playground/chat",
            json=make_chat_request(system_prompt="Answer briefly.", session_id="session-1"),
        )

    trace_id = chat_response.json()["trace_id"]
    traces_response = client.get("/v1/traces", params={"event_type": "generation"})
    detail_response = client.get(f"/v1/traces/{trace_id}")

    assert traces_response.status_code == 200
    assert [trace["id"] for trace in traces_response.json()] == [trace_id]
    assert detail_response.status_code == 200
    trace = detail_response.json()
    assert trace["name"] == "playground.chat"
    assert trace["status"] == "success"
    assert [event["type"] for event in trace["events"]] == ["trace", "generation"]
    root_event, generation_event = trace["events"]
    assert root_event["metadata"]["source"] == "playground"
    assert root_event["metadata"]["session_id"] == "session-1"
    assert generation_event["name"] == "playground.llm"
    assert generation_event["parent_id"] == trace_id
    assert generation_event["model"] == "llama3.2:1b"
    assert generation_event["usage"] == {"input_tokens": 12, "output_tokens": 7, "total_tokens": 19}
    assert generation_event["metadata"]["session_id"] == "session-1"
    assert generation_event["metadata"]["latency_ms"] >= 0
    assert generation_event["input"] == {
        "messages": [
            {"role": "system", "content": "Answer briefly."},
            {"role": "user", "content": "Say hello."},
        ]
    }
    assert generation_event["output"] == "Hello from the stub model."


def test_chat_redacts_secret_like_values_before_recording(tmp_path: Path) -> None:
    with stub_upstream({("POST", "/v1/chat/completions"): (200, CHAT_COMPLETION)}) as (base_url, _):
        client, event_store_path = make_playground_test_client(tmp_path, base_url)

        response = client.post(
            "/v1/playground/chat",
            json=make_chat_request(
                messages=[{"role": "user", "content": "My api_key=sk-versecret leaked, what now?"}],
            ),
        )

    assert response.status_code == 200
    raw_store = event_store_path.read_text(encoding="utf-8")
    assert "sk-versecret" not in raw_store


def test_chat_returns_502_when_upstream_is_unreachable(tmp_path: Path) -> None:
    client, event_store_path = make_playground_test_client(tmp_path, unreachable_base_url())

    response = client.post("/v1/playground/chat", json=make_chat_request())

    assert response.status_code == 502
    assert "Could not reach a model server" in response.json()["detail"]
    assert "BIR_PLAYGROUND_BASE_URL" in response.json()["detail"]
    assert not event_store_path.exists()


def test_chat_returns_502_with_upstream_error_message(tmp_path: Path) -> None:
    error_payload = {"error": {"message": 'model "missing-model" not found'}}
    with stub_upstream({("POST", "/v1/chat/completions"): (404, error_payload)}) as (base_url, _):
        client, event_store_path = make_playground_test_client(tmp_path, base_url)

        response = client.post("/v1/playground/chat", json=make_chat_request(model="missing-model"))

    assert response.status_code == 502
    assert "HTTP 404" in response.json()["detail"]
    assert 'model "missing-model" not found' in response.json()["detail"]
    assert not event_store_path.exists()


def test_chat_returns_502_for_malformed_upstream_completion(tmp_path: Path) -> None:
    with stub_upstream({("POST", "/v1/chat/completions"): (200, {"choices": []})}) as (base_url, _):
        client, event_store_path = make_playground_test_client(tmp_path, base_url)

        response = client.post("/v1/playground/chat", json=make_chat_request())

    assert response.status_code == 502
    assert "unexpected chat completion payload" in response.json()["detail"]
    assert not event_store_path.exists()


def test_chat_rejects_invalid_request_shape(tmp_path: Path) -> None:
    client, event_store_path = make_playground_test_client(tmp_path, unreachable_base_url())

    empty_messages = client.post("/v1/playground/chat", json=make_chat_request(messages=[]))
    bad_role = client.post(
        "/v1/playground/chat",
        json=make_chat_request(messages=[{"role": "tool", "content": "hi"}]),
    )
    bad_temperature = client.post("/v1/playground/chat", json=make_chat_request(temperature=9.5))

    assert empty_messages.status_code == 422
    assert bad_role.status_code == 422
    assert bad_temperature.status_code == 422
    assert not event_store_path.exists()


def test_models_lists_openai_compatible_models_sorted(tmp_path: Path) -> None:
    models_payload = {"object": "list", "data": [{"id": "zephyr:7b"}, {"id": "llama3.2:1b"}]}
    with stub_upstream({("GET", "/v1/models"): (200, models_payload)}) as (base_url, _):
        client, _ = make_playground_test_client(tmp_path, base_url)

        response = client.get("/v1/playground/models")

    assert response.status_code == 200
    assert response.json() == {"models": ["llama3.2:1b", "zephyr:7b"]}


def test_models_falls_back_to_ollama_tags(tmp_path: Path) -> None:
    tags_payload = {"models": [{"name": "llama3.2:1b"}]}
    with stub_upstream({("GET", "/api/tags"): (200, tags_payload)}) as (base_url, requests):
        client, _ = make_playground_test_client(tmp_path, base_url)

        response = client.get("/v1/playground/models")

    assert response.status_code == 200
    assert response.json() == {"models": ["llama3.2:1b"]}
    assert [request["path"] for request in requests] == ["/v1/models", "/api/tags"]


def test_models_returns_502_when_upstream_is_unreachable(tmp_path: Path) -> None:
    client, _ = make_playground_test_client(tmp_path, unreachable_base_url())

    response = client.get("/v1/playground/models")

    assert response.status_code == 502
    assert "Could not reach a model server" in response.json()["detail"]


def test_status_reports_reachable_upstream(tmp_path: Path) -> None:
    models_payload = {"object": "list", "data": [{"id": "llama3.2:1b"}]}
    with stub_upstream({("GET", "/v1/models"): (200, models_payload)}) as (base_url, _):
        client, _ = make_playground_test_client(tmp_path, base_url)

        response = client.get("/v1/playground/status")

    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "upstream_base_url": base_url,
        "upstream_reachable": True,
        "detail": None,
    }


def test_status_reports_unreachable_upstream_with_guidance(tmp_path: Path) -> None:
    base_url = unreachable_base_url()
    client, _ = make_playground_test_client(tmp_path, base_url)

    response = client.get("/v1/playground/status")

    assert response.status_code == 200
    status = response.json()
    assert status["enabled"] is True
    assert status["upstream_reachable"] is False
    assert base_url in status["detail"]
    assert "BIR_PLAYGROUND_BASE_URL" in status["detail"]


def test_read_only_local_mode_disables_playground(tmp_path: Path) -> None:
    data_dir = tmp_path / ".bir"
    data_dir.mkdir()
    client = TestClient(create_app(local_data_dir=data_dir))

    status_response = client.get("/v1/playground/status")
    models_response = client.get("/v1/playground/models")
    chat_response = client.post("/v1/playground/chat", json=make_chat_request())

    assert status_response.status_code == 200
    status = status_response.json()
    assert status["enabled"] is False
    assert status["detail"] == PLAYGROUND_READ_ONLY_DETAIL
    assert status["upstream_reachable"] is None
    assert models_response.status_code == 403
    assert models_response.json() == {"detail": PLAYGROUND_READ_ONLY_DETAIL}
    assert chat_response.status_code == 403
    assert chat_response.json() == {"detail": PLAYGROUND_READ_ONLY_DETAIL}
    assert not (data_dir / "traces.jsonl").exists()


def test_playground_base_url_comes_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BIR_PLAYGROUND_BASE_URL", raising=False)
    assert playground_base_url_from_env() == "http://127.0.0.1:11434"

    monkeypatch.setenv("BIR_PLAYGROUND_BASE_URL", "http://127.0.0.1:9999/")
    assert playground_base_url_from_env() == "http://127.0.0.1:9999"
