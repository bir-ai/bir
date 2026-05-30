from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]
SDK_SRC = ROOT / "packages" / "python-sdk" / "src"
sys.path.insert(0, str(SDK_SRC))
CONTRACT_EVENTS_PATH = ROOT / "tests" / "fixtures" / "valid-events.jsonl"
CONTRACT_SCHEMA_PATH = ROOT / "tests" / "fixtures" / "event-schema-v1.json"

from bir import configure, generation, load_traces, observe, score, span, tool_call
from bir._sdk import _reset_config_for_tests

from app.main import create_app
from app.schemas import TraceEventPayload
from app.storage import JsonlEventStore


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


def load_contract_events() -> list[dict[str, object]]:
    return [json.loads(line) for line in CONTRACT_EVENTS_PATH.read_text(encoding="utf-8").splitlines()]


def load_contract_schema() -> dict[str, object]:
    payload = json.loads(CONTRACT_SCHEMA_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TypeError("expected event schema to be a JSON object")
    return payload


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


def test_server_event_contract_matches_schema_artifact() -> None:
    schema = load_contract_schema()
    properties = schema["properties"]
    if not isinstance(properties, dict):
        raise TypeError("expected schema properties to be an object")

    event_type = properties["type"]
    event_status = properties["status"]
    schema_version = properties["schema_version"]
    if not isinstance(event_type, dict) or not isinstance(event_status, dict) or not isinstance(schema_version, dict):
        raise TypeError("expected schema property definitions to be objects")

    assert schema["required"] == [
        "schema_version",
        "id",
        "trace_id",
        "parent_id",
        "name",
        "type",
        "start_time",
        "end_time",
        "status",
        "metadata",
        "input",
        "output",
        "error",
    ]
    assert schema_version["const"] == "1.0"
    assert event_type["enum"] == ["trace", "span", "generation", "tool_call", "score"]
    assert event_status["enum"] == ["success", "error"]


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


def test_concurrent_duplicate_event_id_appends_once(tmp_path: Path) -> None:
    event_store_path = tmp_path / "events.jsonl"
    store = JsonlEventStore(event_store_path)
    event = TraceEventPayload.model_validate(make_event())

    with ThreadPoolExecutor(max_workers=16) as executor:
        results = list(executor.map(store.append, [event] * 32))

    stored_events = [json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines()]
    assert results.count(True) == 1
    assert results.count(False) == 31
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


def test_rejects_child_event_without_parent_id(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(id="span-1", type="span", parent_id=None),
    )

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


def test_rejects_bool_score_value(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            id="score-1",
            type="score",
            parent_id="trace-1",
            value=True,
        ),
    )

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_rejects_missing_score_value(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            id="score-1",
            type="score",
            parent_id="trace-1",
        ),
    )

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_rejects_bool_usage_value(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            id="generation-1",
            type="generation",
            parent_id="trace-1",
            usage={"input_tokens": True},
        ),
    )

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


def test_ingests_schema_contract_fixtures(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    for event in load_contract_events():
        response = client.post("/v1/events", json=event)
        assert response.status_code == 201
        assert response.json() == {"accepted": 1, "id": event["id"]}

    traces_response = client.get("/v1/traces")

    assert traces_response.status_code == 200
    traces = traces_response.json()
    assert len(traces) == 1
    assert traces[0]["id"] == "trace-fixture-1"
    assert [event["type"] for event in traces[0]["events"]] == [
        "trace",
        "span",
        "tool_call",
        "generation",
        "score",
    ]
    assert traces[0]["events"][3]["model"] == "demo-model"
    assert traces[0]["events"][3]["usage"] == {"input_tokens": 12, "output_tokens": 24, "total_tokens": 36}
    assert traces[0]["events"][4]["value"] == 0.82


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

        sdk_trace = load_traces(trace_path)[0]
        assert [event.type for event in sdk_trace.events] == [
            "trace",
            "span",
            "tool_call",
            "generation",
            "score",
        ]

        for event in sdk_trace.events:
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
