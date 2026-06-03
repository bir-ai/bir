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

from bir import configure, generation, load_traces, observe, retrieval, score, span
from bir._sdk import _reset_config_for_tests, _safe_capture, _safe_error

from app.main import create_app
from app.redaction import redact_secret_text, redact_value
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


def make_client_with_experiments(tmp_path: Path) -> tuple[TestClient, Path]:
    event_store_path = tmp_path / "events.jsonl"
    experiment_store_path = tmp_path / "experiments"
    return (
        TestClient(create_app(event_store_path=event_store_path, experiment_store_path=experiment_store_path)),
        experiment_store_path,
    )


def make_experiment_summary(**overrides: object) -> dict[str, object]:
    summary: dict[str, object] = {
        "schema_version": "1.0",
        "experiment_id": "experiment-1",
        "name": "prompt-v1",
        "start_time": "2026-01-01T00:00:00+00:00",
        "end_time": "2026-01-01T00:00:01+00:00",
        "status": "success",
        "example_count": 1,
        "error_count": 0,
        "aggregate_scores": {"contains": 1.0},
        "result_path": "prompt-v1-experiment-1.jsonl",
    }
    summary.update(overrides)
    return summary


def make_experiment_result(**overrides: object) -> dict[str, object]:
    result: dict[str, object] = {
        "experiment_id": "experiment-1",
        "experiment_name": "prompt-v1",
        "id": "result-1",
        "example_id": "q1",
        "input": {"question": "What is Bir?"},
        "expected": "An observability SDK",
        "output": "Bir is an observability SDK.",
        "scores": [{"name": "contains", "value": 1.0, "metadata": {"expected": "observability"}}],
        "start_time": "2026-01-01T00:00:00+00:00",
        "end_time": "2026-01-01T00:00:01+00:00",
        "duration_ms": 1000.0,
        "status": "success",
        "error": None,
    }
    result.update(overrides)
    return result


def write_experiment(experiment_store_path: Path, *, summary: dict[str, object], results: list[dict[str, object]]) -> None:
    experiment_store_path.mkdir(parents=True, exist_ok=True)
    result_path = experiment_store_path / str(summary["result_path"])
    result_path.write_text(
        "".join(json.dumps(result, sort_keys=True) + "\n" for result in results),
        encoding="utf-8",
    )
    summary_path = experiment_store_path / f"{summary['name']}-{summary['experiment_id']}.summary.json"
    summary_path.write_text(json.dumps(summary, sort_keys=True) + "\n", encoding="utf-8")


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


def test_list_experiments_returns_empty_list_for_missing_directory(tmp_path: Path) -> None:
    client, _ = make_client_with_experiments(tmp_path)

    response = client.get("/v1/experiments")

    assert response.status_code == 200
    assert response.json() == []


def test_lists_experiment_summaries_newest_first(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    older = make_experiment_summary(
        experiment_id="experiment-1",
        name="prompt-v1",
        start_time="2026-01-01T00:00:00+00:00",
        end_time="2026-01-01T00:00:01+00:00",
        result_path="prompt-v1-experiment-1.jsonl",
    )
    newer = make_experiment_summary(
        experiment_id="experiment-2",
        name="prompt-v2",
        start_time="2026-01-02T00:00:00+00:00",
        end_time="2026-01-02T00:00:01+00:00",
        result_path="prompt-v2-experiment-2.jsonl",
    )
    write_experiment(experiment_store_path, summary=older, results=[make_experiment_result()])
    write_experiment(
        experiment_store_path,
        summary=newer,
        results=[
            make_experiment_result(
                experiment_id="experiment-2",
                experiment_name="prompt-v2",
                id="result-2",
            )
        ],
    )

    response = client.get("/v1/experiments")

    assert response.status_code == 200
    summaries = response.json()
    assert [summary["experiment_id"] for summary in summaries] == ["experiment-2", "experiment-1"]
    assert summaries[0]["aggregate_scores"] == {"contains": 1.0}


def test_gets_experiment_detail_with_result_rows(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    summary = make_experiment_summary()
    result = make_experiment_result()
    write_experiment(experiment_store_path, summary=summary, results=[result])

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 200
    experiment = response.json()
    assert experiment["experiment_id"] == "experiment-1"
    assert experiment["name"] == "prompt-v1"
    assert experiment["aggregate_scores"] == {"contains": 1.0}
    assert len(experiment["results"]) == 1
    assert experiment["results"][0]["example_id"] == "q1"
    assert experiment["results"][0]["scores"] == [
        {"name": "contains", "value": 1.0, "metadata": {"expected": "observability"}}
    ]


def test_get_experiment_returns_404_for_missing_experiment(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    write_experiment(experiment_store_path, summary=make_experiment_summary(), results=[make_experiment_result()])

    response = client.get("/v1/experiments/missing-experiment")

    assert response.status_code == 404
    assert response.json() == {"detail": "Experiment not found"}


def test_rejects_invalid_experiment_summary_with_controlled_error(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    experiment_store_path.mkdir(parents=True, exist_ok=True)
    (experiment_store_path / "bad.summary.json").write_text(
        json.dumps(make_experiment_summary(aggregate_scores={"contains": True})),
        encoding="utf-8",
    )

    response = client.get("/v1/experiments")

    assert response.status_code == 500
    assert "Invalid experiment summary" in response.json()["detail"]


def test_rejects_invalid_experiment_result_with_controlled_error(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    summary = make_experiment_summary()
    write_experiment(
        experiment_store_path,
        summary=summary,
        results=[make_experiment_result(scores=[{"name": "contains", "value": True, "metadata": {}}])],
    )

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 500
    assert "Invalid experiment result" in response.json()["detail"]


def test_rejects_absolute_experiment_result_path_with_controlled_error(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    experiment_store_path.mkdir(parents=True, exist_ok=True)
    summary = make_experiment_summary(result_path=str(tmp_path / "outside.jsonl"))
    summary_path = experiment_store_path / f"{summary['name']}-{summary['experiment_id']}.summary.json"
    summary_path.write_text(json.dumps(summary, sort_keys=True) + "\n", encoding="utf-8")

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 500
    assert "result_path" in response.json()["detail"]


def test_rejects_experiment_result_path_traversal_with_controlled_error(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    experiment_store_path.mkdir(parents=True, exist_ok=True)
    summary = make_experiment_summary(result_path="../outside.jsonl")
    summary_path = experiment_store_path / f"{summary['name']}-{summary['experiment_id']}.summary.json"
    summary_path.write_text(json.dumps(summary, sort_keys=True) + "\n", encoding="utf-8")

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 500
    assert "result_path" in response.json()["detail"]


def test_ingests_valid_event_to_jsonl(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post("/v1/events", json=make_event())

    assert response.status_code == 201
    assert response.json() == {"accepted": 1, "id": "trace-1"}
    stored_events = [json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines()]
    assert len(stored_events) == 1
    assert stored_events[0]["id"] == "trace-1"
    assert stored_events[0]["schema_version"] == "1.0"


def test_ingestion_redacts_secret_like_values_before_persisting(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            metadata={
                "provider": "openai",
                "authorization": "Bearer metadata-secret",
                "note": "client_secret=metadata-client-secret",
            },
            input={
                "api_key": "sk-inputsecret",
                "messages": ["Authorization: Bearer message-secret"],
            },
            output={
                "token": "output-token",
                "text": "secret=response-secret",
            },
            error="provider failed authorization: Bearer error-secret",
            provider_payload={"password": "extra-password", "text": "use sk-extrasecret"},
        ),
    )

    assert response.status_code == 201
    raw_store = event_store_path.read_text(encoding="utf-8")
    for secret in (
        "metadata-secret",
        "metadata-client-secret",
        "sk-inputsecret",
        "message-secret",
        "output-token",
        "response-secret",
        "error-secret",
        "extra-password",
        "sk-extrasecret",
    ):
        assert secret not in raw_store

    stored_event = json.loads(raw_store)
    assert stored_event["metadata"] == {
        "authorization": "[redacted]",
        "note": "client_secret=[redacted]",
        "provider": "openai",
    }
    assert stored_event["input"] == {
        "api_key": "[redacted]",
        "messages": ["Authorization: Bearer [redacted]"],
    }
    assert stored_event["output"] == {
        "text": "secret=[redacted]",
        "token": "[redacted]",
    }
    assert stored_event["error"] == "provider failed authorization: Bearer [redacted]"
    assert stored_event["provider_payload"] == {"password": "[redacted]", "text": "use [redacted]"}


def test_list_endpoints_return_redacted_events(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            input={"authorization": "Bearer input-secret"},
            output={"text": "api_key=output-secret"},
        ),
    )
    events_response = client.get("/v1/events")
    traces_response = client.get("/v1/traces")

    assert response.status_code == 201
    assert events_response.status_code == 200
    assert traces_response.status_code == 200
    assert events_response.json()[0]["input"] == {"authorization": "[redacted]"}
    assert events_response.json()[0]["output"] == {"text": "api_key=[redacted]"}
    assert traces_response.json()[0]["events"][0]["input"] == {"authorization": "[redacted]"}
    assert traces_response.json()[0]["events"][0]["output"] == {"text": "api_key=[redacted]"}


def test_sdk_and_server_redaction_match_for_common_secret_shapes() -> None:
    payload = {
        "api_key": "sk-inputsecret",
        "headers": ["Authorization: Bearer message-secret"],
        "nested": {
            "client_secret": "metadata-client-secret",
            "note": "token=response-token",
        },
    }
    error = RuntimeError("provider failed authorization: Bearer error-secret")

    assert _safe_capture(payload) == redact_value(payload)
    assert _safe_error(error) == redact_secret_text(str(error))
    assert "inputsecret" not in str(_safe_capture(payload))
    assert "error-secret" not in _safe_error(error)


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


def test_rejects_negative_usage_value(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            id="generation-1",
            type="generation",
            parent_id="trace-1",
            usage={"input_tokens": -1},
        ),
    )

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_accepts_generation_cost_with_default_currency(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            id="generation-1",
            type="generation",
            parent_id="trace-1",
            cost={"input_cost": 0.000012, "output_cost": 0.000048, "total_cost": 0.00006},
        ),
    )

    assert response.status_code == 201
    events_response = client.get("/v1/events")
    assert events_response.status_code == 200
    event = events_response.json()[0]
    assert event["cost"] == {"input_cost": 0.000012, "output_cost": 0.000048, "total_cost": 0.00006}
    assert event["currency"] == "USD"


def test_rejects_bool_cost_value(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            id="generation-1",
            type="generation",
            parent_id="trace-1",
            cost={"input_cost": True},
        ),
    )

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_rejects_negative_cost_value(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events",
        json=make_event(
            id="generation-1",
            type="generation",
            parent_id="trace-1",
            cost={"input_cost": -0.01},
        ),
    )

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_rejects_invalid_retrieval_document_numeric_fields(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    negative_rank = client.post(
        "/v1/events",
        json=make_event(
            id="tool-1",
            type="tool_call",
            parent_id="trace-1",
            metadata={"kind": "retrieval"},
            output={"documents": [{"id": "doc-1", "rank": -1}]},
        ),
    )
    bool_rank = client.post(
        "/v1/events",
        json=make_event(
            id="tool-2",
            type="tool_call",
            parent_id="trace-1",
            metadata={"kind": "retrieval"},
            output={"documents": [{"id": "doc-1", "rank": True}]},
        ),
    )
    negative_score = client.post(
        "/v1/events",
        json=make_event(
            id="tool-3",
            type="tool_call",
            parent_id="trace-1",
            metadata={"kind": "retrieval"},
            output={"documents": [{"id": "doc-1", "score": -0.1}]},
        ),
    )

    assert negative_rank.status_code == 422
    assert bool_rank.status_code == 422
    assert negative_score.status_code == 422
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


def test_gets_trace_detail_with_root_first_event_order(tmp_path: Path) -> None:
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
    response = client.get("/v1/traces/trace-1")

    assert score_response.status_code == 201
    assert trace_response.status_code == 201
    assert response.status_code == 200
    trace = response.json()
    assert trace["id"] == "trace-1"
    assert trace["name"] == "answer"
    assert [event["type"] for event in trace["events"]] == ["trace", "score"]


def test_get_trace_detail_returns_404_for_missing_trace(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.get("/v1/traces/missing-trace")

    assert response.status_code == 404
    assert response.json() == {"detail": "Trace not found"}


def test_get_trace_detail_returns_404_for_events_without_root_trace(tmp_path: Path) -> None:
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

    ingest_response = client.post("/v1/events", json=score_event)
    response = client.get("/v1/traces/trace-1")

    assert ingest_response.status_code == 201
    assert response.status_code == 404
    assert response.json() == {"detail": "Trace not found"}


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
    assert traces[0]["events"][3]["cost"] == {
        "input_cost": 0.000012,
        "output_cost": 0.000048,
        "total_cost": 0.00006,
    }
    assert traces[0]["events"][2]["output"] == {
        "documents": [
            {
                "id": "doc-1",
                "rank": 1,
                "score": 0.82,
                "source": "docs",
                "text": "Bir records local traces with JSONL.",
            }
        ]
    }
    assert traces[0]["events"][3]["currency"] == "USD"
    assert traces[0]["events"][4]["value"] == 0.82

    trace_response = client.get("/v1/traces/trace-fixture-1")

    assert trace_response.status_code == 200
    trace = trace_response.json()
    assert trace["id"] == "trace-fixture-1"
    assert [event["type"] for event in trace["events"]] == [
        "trace",
        "span",
        "tool_call",
        "generation",
        "score",
    ]


def test_ingests_sdk_generated_events(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    trace_path = tmp_path / "sdk-traces.jsonl"
    configure(trace_path=trace_path, capture_inputs=True, capture_outputs=True)

    try:

        @observe()
        def answer(question: str) -> str:
            with span("retrieve_context"):
                with retrieval("search_docs", query=question) as result:
                    result.add_document(id="doc-1", text="local context")
            with generation("local.llm", model="demo", input={"question": question}) as gen:
                gen.set_output("ok")
                gen.set_usage(input_tokens=1, output_tokens=2)
                gen.set_cost(input_cost=0.000001, output_cost=0.000002)
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
