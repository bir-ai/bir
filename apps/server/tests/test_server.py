from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]
SDK_SRC = ROOT / "packages" / "python-sdk" / "src"
sys.path.insert(0, str(SDK_SRC))

from bir import configure, generation, load_events, observe, score, span, tool_call
from bir._sdk import _reset_config_for_tests

from app.main import create_app


def make_event(**overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "schema_version": "1.0",
        "id": "trace-1",
        "trace_id": "trace-1",
        "parent_id": None,
        "name": "answer",
        "type": "trace",
        "start_time": "2026-01-01T00:00:00+00:00",
        "end_time": "2026-01-01T00:00:01+00:00",
        "status": "success",
        "metadata": {},
        "input": None,
        "output": None,
        "error": None,
    }
    event.update(overrides)
    return event


def make_client(tmp_path: Path) -> tuple[TestClient, Path]:
    event_store_path = tmp_path / "events.jsonl"
    return TestClient(create_app(event_store_path=event_store_path)), event_store_path


def test_health_returns_ok(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ingests_valid_event_to_jsonl(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post("/v1/events", json=make_event())

    assert response.status_code == 201
    assert response.json() == {"accepted": 1, "id": "trace-1"}
    stored_events = [json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines()]
    assert len(stored_events) == 1
    assert stored_events[0]["id"] == "trace-1"
    assert stored_events[0]["schema_version"] == "1.0"


def test_duplicate_event_id_is_idempotent(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    first_response = client.post("/v1/events", json=make_event())
    second_response = client.post("/v1/events", json=make_event())

    assert first_response.status_code == 201
    assert first_response.json() == {"accepted": 1, "id": "trace-1"}
    assert second_response.status_code == 200
    assert second_response.json() == {"accepted": 0, "id": "trace-1"}
    stored_events = [json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines()]
    assert len(stored_events) == 1
    assert stored_events[0]["id"] == "trace-1"


def test_rejects_invalid_event_payload(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post("/v1/events", json=make_event(type="score"))

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_rejects_trace_with_parent_id(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post("/v1/events", json=make_event(parent_id="parent-1"))

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_rejects_missing_required_event_field(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)
    event = make_event()
    del event["metadata"]

    response = client.post("/v1/events", json=event)

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_rejects_non_finite_json_values(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)
    payload = json.dumps(make_event(output={"value": float("nan")}), allow_nan=True)

    response = client.post("/v1/events", content=payload, headers={"content-type": "application/json"})

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_lists_events(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    client.post("/v1/events", json=make_event())

    response = client.get("/v1/events")

    assert response.status_code == 200
    events = response.json()
    assert len(events) == 1
    assert events[0]["id"] == "trace-1"


def test_lists_traces_with_root_first_event_order(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    score_event = make_event(
        id="score-1",
        trace_id="trace-1",
        parent_id="trace-1",
        name="helpfulness",
        type="score",
        start_time="2026-01-01T00:00:00+00:00",
        end_time="2026-01-01T00:00:00+00:00",
        value=0.9,
    )
    trace_event = make_event()

    score_response = client.post("/v1/events", json=score_event)
    trace_response = client.post("/v1/events", json=trace_event)
    response = client.get("/v1/traces")

    assert score_response.status_code == 201
    assert trace_response.status_code == 201
    assert response.status_code == 200
    traces = response.json()
    assert len(traces) == 1
    assert traces[0]["id"] == "trace-1"
    assert [event["type"] for event in traces[0]["events"]] == ["trace", "score"]


def test_ingests_sdk_generated_events(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    trace_path = tmp_path / "sdk-traces.jsonl"
    configure(trace_path=trace_path, capture_inputs=True, capture_outputs=True)

    try:

        @observe()
        def answer(question: str) -> str:
            with span("retrieve_context"):
                with tool_call("search_docs", input={"query": question}) as tool:
                    tool.set_output(["doc-1"])
            with generation("local.llm", model="demo", input={"question": question}) as gen:
                gen.set_output("ok")
                gen.set_usage(input_tokens=1, output_tokens=2)
            score("helpfulness", 0.9)
            return "ok"

        answer("hello")

        for event in load_events(trace_path):
            response = client.post("/v1/events", json=event.raw)
            assert response.status_code == 201
            assert response.json()["accepted"] == 1

        traces_response = client.get("/v1/traces")
        assert traces_response.status_code == 200
        traces = traces_response.json()
        assert len(traces) == 1
        assert traces[0]["name"] == "answer"
        assert [event["type"] for event in traces[0]["events"]] == [
            "trace",
            "span",
            "tool_call",
            "generation",
            "score",
        ]
    finally:
        _reset_config_for_tests()
