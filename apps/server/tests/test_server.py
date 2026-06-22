from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]
# bir is installed as a published package (declared in apps/server dev
# dependencies); the SDK source lives in the separate bir repository.
CONTRACT_EVENTS_PATH = ROOT / "tests" / "fixtures" / "valid-events.jsonl"
CONTRACT_SCHEMA_PATH = ROOT / "tests" / "fixtures" / "event-schema-v1.json"

from bir import configure, generation, load_traces, observe, retrieval, score, span
from bir._sdk import _reset_config_for_tests, _safe_capture, _safe_error

import app.storage as storage
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


def assert_event_matches_contract_schema(event: dict[str, object], schema: dict[str, object]) -> None:
    """Check the schema rules exercised by canonical server-written events."""

    required = schema["required"]
    properties = schema["properties"]
    if not isinstance(required, list) or not isinstance(properties, dict):
        raise TypeError("expected schema required/properties definitions")
    assert set(required).issubset(event)

    json_types = {
        "null": lambda value: value is None,
        "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
        "object": lambda value: isinstance(value, dict),
        "string": lambda value: isinstance(value, str),
    }
    for key, value in event.items():
        definition = properties.get(key)
        if not isinstance(definition, dict) or "type" not in definition:
            continue
        declared_types = definition["type"]
        if isinstance(declared_types, str):
            declared_types = [declared_types]
        if not isinstance(declared_types, list):
            raise TypeError(f"expected schema type declaration for {key}")
        assert any(json_types[str(json_type)](value) for json_type in declared_types), (
            f"{key}={value!r} does not match shared schema types {declared_types}"
        )

    if event["type"] == "trace":
        assert event["parent_id"] is None
    else:
        assert isinstance(event["parent_id"], str) and event["parent_id"]
    if event["type"] == "score":
        assert isinstance(event.get("value"), (int, float)) and not isinstance(event["value"], bool)


def post_filter_fixture_events(client: TestClient) -> None:
    events = [
        make_event(
            id="trace-success",
            trace_id="trace-success",
            name="answer_question",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:01+00:00",
            metadata={"service": {"name": "rag-api", "environment": "production"}},
        ),
        make_event(
            id="generation-success",
            trace_id="trace-success",
            parent_id="trace-success",
            name="local.llm",
            type="generation",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:01+00:00",
        ),
        make_event(
            id="trace-error",
            trace_id="trace-error",
            name="failing_workflow",
            status="error",
            start_time="2026-01-02T00:00:00+00:00",
            end_time="2026-01-02T00:00:01+00:00",
            error="failed",
            metadata={"service": {"name": "billing-api", "environment": "staging"}},
        ),
        make_event(
            id="span-error",
            trace_id="trace-error",
            parent_id="trace-error",
            name="failing_step",
            type="span",
            status="error",
            start_time="2026-01-02T00:00:00+00:00",
            end_time="2026-01-02T00:00:01+00:00",
            error="failed",
        ),
        make_event(
            id="trace-tool",
            trace_id="trace-tool",
            name="classify",
            start_time="2026-01-03T00:00:00+00:00",
            end_time="2026-01-03T00:00:01+00:00",
        ),
        make_event(
            id="tool-call",
            trace_id="trace-tool",
            parent_id="trace-tool",
            name="lookup",
            type="tool_call",
            start_time="2026-01-03T00:00:00+00:00",
            end_time="2026-01-03T00:00:01+00:00",
        ),
    ]
    for event in events:
        response = client.post("/v1/events", json=event)
        assert response.status_code == 201


def test_cors_allows_default_dashboard_origin(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.get("/v1/traces", headers={"origin": "http://localhost:3000"})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_cors_ignores_unknown_origin(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.get("/v1/traces", headers={"origin": "http://evil.example"})

    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_cors_preflight_allows_dashboard_get(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.options(
        "/v1/traces",
        headers={
            "origin": "http://127.0.0.1:3000",
            "access-control-request-method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
    assert "GET" in response.headers["access-control-allow-methods"]


def test_cors_preflight_allows_private_network_dashboard_requests(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.options(
        "/v1/playground/chat",
        headers={
            "origin": "http://localhost:3000",
            "access-control-request-method": "POST",
            "access-control-request-headers": "accept,content-type",
            "access-control-request-private-network": "true",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert response.headers["access-control-allow-private-network"] == "true"


def test_cors_origins_are_configurable_via_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BIR_CORS_ORIGINS", "http://dashboard.example:4173, http://other.example")
    client, _ = make_client(tmp_path)

    allowed = client.get("/v1/traces", headers={"origin": "http://dashboard.example:4173"})
    default_origin = client.get("/v1/traces", headers={"origin": "http://localhost:3000"})

    assert allowed.headers["access-control-allow-origin"] == "http://dashboard.example:4173"
    assert "access-control-allow-origin" not in default_origin.headers


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
    result = make_experiment_result(trace_id="trace-1")
    write_experiment(experiment_store_path, summary=summary, results=[result])

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 200
    experiment = response.json()
    assert experiment["experiment_id"] == "experiment-1"
    assert experiment["name"] == "prompt-v1"
    assert experiment["aggregate_scores"] == {"contains": 1.0}
    assert len(experiment["results"]) == 1
    assert experiment["results"][0]["example_id"] == "q1"
    assert experiment["results"][0]["trace_id"] == "trace-1"
    assert experiment["results"][0]["scores"] == [
        {"name": "contains", "value": 1.0, "metadata": {"expected": "observability"}}
    ]


def test_ingests_experiment_and_exposes_it_through_get_endpoints(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    summary = make_experiment_summary(result_path="/tmp/client-controlled.jsonl")
    result = make_experiment_result(trace_id="trace-1")

    response = client.post("/v1/experiments", json={"summary": summary, "results": [result]})

    assert response.status_code == 201
    assert response.json() == {"accepted": 1, "id": "experiment-1"}
    result_path = experiment_store_path / "prompt-v1-experiment-1.jsonl"
    summary_path = experiment_store_path / "prompt-v1-experiment-1.summary.json"
    assert result_path.exists()
    assert summary_path.exists()
    stored_summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert stored_summary["result_path"] == "prompt-v1-experiment-1.jsonl"

    list_response = client.get("/v1/experiments")
    detail_response = client.get("/v1/experiments/experiment-1")

    assert list_response.status_code == 200
    assert list_response.json()[0]["experiment_id"] == "experiment-1"
    assert list_response.json()[0]["result_path"] == "prompt-v1-experiment-1.jsonl"
    assert detail_response.status_code == 200
    experiment = detail_response.json()
    assert experiment["experiment_id"] == "experiment-1"
    assert experiment["results"][0]["example_id"] == "q1"
    assert experiment["results"][0]["trace_id"] == "trace-1"


def test_duplicate_experiment_upload_is_idempotent(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    payload = {"summary": make_experiment_summary(), "results": [make_experiment_result()]}

    first_response = client.post("/v1/experiments", json=payload)
    result_path = experiment_store_path / "prompt-v1-experiment-1.jsonl"
    original_result_store = result_path.read_text(encoding="utf-8")
    second_payload = {
        "summary": make_experiment_summary(result_path="../different.jsonl"),
        "results": [make_experiment_result(output="different output")],
    }
    second_response = client.post("/v1/experiments", json=second_payload)

    assert first_response.status_code == 201
    assert first_response.json() == {"accepted": 1, "id": "experiment-1"}
    assert second_response.status_code == 200
    assert second_response.json() == {"accepted": 0, "id": "experiment-1"}
    assert result_path.read_text(encoding="utf-8") == original_result_store
    assert len(list(experiment_store_path.glob("*.summary.json"))) == 1


def test_rejects_malformed_experiment_upload(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    payload = {
        "summary": make_experiment_summary(),
        "results": [make_experiment_result(scores=[{"name": "contains", "value": True, "metadata": {}}])],
    }

    response = client.post("/v1/experiments", json=payload)

    assert response.status_code == 422
    assert not experiment_store_path.exists()


def test_experiment_upload_redacts_secret_like_values_before_persisting(tmp_path: Path) -> None:
    client, experiment_store_path = make_client_with_experiments(tmp_path)
    result = make_experiment_result(
        input={"api_key": "sk-inputsecret"},
        expected="token=expected-secret",
        output={"text": "authorization: Bearer output-secret"},
        scores=[{"name": "contains", "value": 1.0, "metadata": {"client_secret": "metadata-secret"}}],
        error="provider failed password=error-secret",
    )

    response = client.post("/v1/experiments", json={"summary": make_experiment_summary(), "results": [result]})

    assert response.status_code == 201
    raw_store = "".join(path.read_text(encoding="utf-8") for path in experiment_store_path.iterdir())
    for secret in ("sk-inputsecret", "expected-secret", "output-secret", "metadata-secret", "error-secret"):
        assert secret not in raw_store
    detail_response = client.get("/v1/experiments/experiment-1")
    uploaded_result = detail_response.json()["results"][0]
    assert uploaded_result["input"] == {"api_key": "[redacted]"}
    assert uploaded_result["expected"] == "token=[redacted]"
    assert uploaded_result["output"] == {"text": "authorization: [redacted] [redacted]"}
    assert uploaded_result["scores"][0]["metadata"] == {"client_secret": "[redacted]"}
    assert uploaded_result["error"] == "provider failed password=[redacted]"


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


def test_ingests_event_batch_to_jsonl(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)
    events = [
        make_event(),
        make_event(id="span-1", trace_id="trace-1", parent_id="trace-1", name="step", type="span"),
    ]

    response = client.post("/v1/events/batch", json=events)

    assert response.status_code == 201
    assert response.json() == {"accepted": 2, "event_ids": ["trace-1", "span-1"]}
    stored_events = [json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines()]
    assert [event["id"] for event in stored_events] == ["trace-1", "span-1"]


def test_event_batch_skips_duplicate_event_ids(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)
    first_response = client.post("/v1/events", json=make_event())

    batch_response = client.post(
        "/v1/events/batch",
        json=[
            make_event(),
            make_event(id="span-1", trace_id="trace-1", parent_id="trace-1", name="step", type="span"),
            make_event(id="span-1", trace_id="trace-1", parent_id="trace-1", name="step", type="span"),
        ],
    )

    assert first_response.status_code == 201
    assert batch_response.status_code == 201
    assert batch_response.json() == {"accepted": 1, "event_ids": ["span-1"]}
    stored_events = [json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines()]
    assert [event["id"] for event in stored_events] == ["trace-1", "span-1"]


def test_event_batch_with_only_duplicates_returns_200(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    first_response = client.post("/v1/events/batch", json=[make_event()])

    second_response = client.post("/v1/events/batch", json=[make_event()])

    assert first_response.status_code == 201
    assert second_response.status_code == 200
    assert second_response.json() == {"accepted": 0, "event_ids": []}


def test_rejects_invalid_event_in_batch_without_persisting(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events/batch",
        json=[make_event(), make_event(id="bad-1", trace_id="bad-1", type="score")],
    )

    assert response.status_code == 422
    assert not event_store_path.exists()


def test_event_batch_redacts_secret_like_values_before_persisting(tmp_path: Path) -> None:
    client, event_store_path = make_client(tmp_path)

    response = client.post(
        "/v1/events/batch",
        json=[
            make_event(
                metadata={"authorization": "Bearer batch-secret"},
                input={"api_key": "sk-batchsecret"},
                error="failed authorization: Bearer batch-error-secret",
            )
        ],
    )

    assert response.status_code == 201
    raw_store = event_store_path.read_text(encoding="utf-8")
    for secret in ("batch-secret", "sk-batchsecret", "batch-error-secret"):
        assert secret not in raw_store
    stored_event = json.loads(raw_store)
    assert stored_event["metadata"] == {"authorization": "[redacted]"}
    assert stored_event["input"] == {"api_key": "[redacted]"}
    assert stored_event["error"] == "failed authorization: Bearer [redacted]"


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
    for nullable_field, value_type in {
        "value": "number",
        "model": "string",
        "usage": "object",
        "cost": "object",
        "currency": "string",
    }.items():
        definition = properties[nullable_field]
        assert isinstance(definition, dict)
        assert definition["type"] == [value_type, "null"]

    score_rule = schema["allOf"][-1]
    assert isinstance(score_rule, dict)
    assert score_rule["then"] == {
        "required": ["value"],
        "properties": {"value": {"type": "number"}},
    }


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


def test_new_store_instance_detects_duplicates_in_existing_file(tmp_path: Path) -> None:
    event_store_path = tmp_path / "events.jsonl"
    event = TraceEventPayload.model_validate(make_event())

    first_store = JsonlEventStore(event_store_path)
    assert first_store.append(event) is True

    second_store = JsonlEventStore(event_store_path)
    assert second_store.has_event("trace-1") is True
    assert second_store.append(event) is False

    new_event = TraceEventPayload.model_validate(make_event(id="span-1", type="span", parent_id="trace-1"))
    assert second_store.append(new_event) is True
    stored_events = [json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines()]
    assert [stored["id"] for stored in stored_events] == ["trace-1", "span-1"]


def test_load_events_caches_parsed_events_for_unchanged_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = JsonlEventStore(tmp_path / "events.jsonl")
    store.append(TraceEventPayload.model_validate(make_event()))
    store.append(TraceEventPayload.model_validate(make_event(id="span-1", type="span", parent_id="trace-1")))

    parse_calls = 0
    original_parse = storage._parse_event_line

    def counting_parse(path: Path, line_number: int, stripped: str) -> TraceEventPayload:
        nonlocal parse_calls
        parse_calls += 1
        return original_parse(path, line_number, stripped)

    monkeypatch.setattr(storage, "_parse_event_line", counting_parse)

    first = store.load_events()
    parses_after_first = parse_calls
    second = store.load_events()

    assert [event.id for event in first] == ["trace-1", "span-1"]
    assert [event.id for event in second] == ["trace-1", "span-1"]
    # The first load parses each line once; the unchanged second load reuses the cache.
    assert parses_after_first == 2
    assert parse_calls == parses_after_first


def test_load_events_reflects_appends_and_stays_idempotent(tmp_path: Path) -> None:
    store = JsonlEventStore(tmp_path / "events.jsonl")
    assert store.append(TraceEventPayload.model_validate(make_event())) is True

    assert [event.id for event in store.load_events()] == ["trace-1"]

    # An event appended after a load is visible on the next load_events().
    span = TraceEventPayload.model_validate(make_event(id="span-1", type="span", parent_id="trace-1"))
    assert store.append(span) is True
    assert [event.id for event in store.load_events()] == ["trace-1", "span-1"]

    # A duplicate id is rejected and does not change what loads.
    duplicate = TraceEventPayload.model_validate(make_event(id="span-1", type="span", parent_id="trace-1"))
    assert store.append(duplicate) is False
    assert [event.id for event in store.load_events()] == ["trace-1", "span-1"]


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


def test_persists_optional_fields_as_explicit_nulls(tmp_path: Path) -> None:
    # The SDK omits optional keys it did not set, but the server persists every
    # event with model_dump(exclude_none=False). The canonical persisted shape
    # therefore spells value/model/usage/cost/currency as explicit JSON nulls. Pin
    # it so a serialization change cannot drift it silently. See
    # docs/IMPLEMENTATION_ROADMAP.md Stage 2.
    client, event_store_path = make_client(tmp_path)

    score_event = make_event(
        id="score-1",
        parent_id="trace-1",
        name="helpfulness",
        type="score",
        start_time="2026-01-01T00:00:00+00:00",
        end_time="2026-01-01T00:00:00+00:00",
        value=0.82,
    )
    generation_event = make_event(
        id="generation-1",
        parent_id="trace-1",
        name="local.llm",
        type="generation",
        usage={"input_tokens": 5, "output_tokens": 7, "total_tokens": 12},
        cost={"input_cost": 0.000005, "output_cost": 0.000014, "total_cost": 0.000019},
    )
    # The posted payloads are SDK-shaped: optional keys they did not set are absent.
    for omitted in ("model", "usage", "cost", "currency"):
        assert omitted not in score_event
    assert "model" not in generation_event
    assert "currency" not in generation_event

    assert client.post("/v1/events", json=score_event).status_code == 201
    assert client.post("/v1/events", json=generation_event).status_code == 201

    stored_events = {
        event["id"]: event
        for event in (json.loads(line) for line in event_store_path.read_text(encoding="utf-8").splitlines())
    }
    stored_score = stored_events["score-1"]
    assert stored_score["value"] == 0.82
    assert stored_score["model"] is None
    assert stored_score["usage"] is None
    assert stored_score["cost"] is None
    assert stored_score["currency"] is None
    stored_generation = stored_events["generation-1"]
    assert stored_generation["value"] is None
    assert stored_generation["model"] is None
    assert stored_generation["usage"] == {"input_tokens": 5, "output_tokens": 7, "total_tokens": 12}
    assert stored_generation["cost"] == {"input_cost": 0.000005, "output_cost": 0.000014, "total_cost": 0.000019}
    # Cost without an explicit currency persists with the default USD.
    assert stored_generation["currency"] == "USD"

    # Exercise the shared schema against real output from JsonlEventStore, not a
    # hand-built object or a property-name comparison. Both canonical lines must
    # satisfy the contract, including all five nullable optional fields.
    contract_schema = load_contract_schema()
    assert_event_matches_contract_schema(stored_score, contract_schema)
    assert_event_matches_contract_schema(stored_generation, contract_schema)

    # Reading back through the API re-validates the persisted payload and keeps the
    # explicit null keys for every optional field.
    events_response = client.get("/v1/events")
    assert events_response.status_code == 200
    by_id = {event["id"]: event for event in events_response.json()}
    for optional_key in ("value", "model", "usage", "cost", "currency"):
        assert optional_key in by_id["score-1"]
        assert optional_key in by_id["generation-1"]
    assert by_id["score-1"]["value"] == 0.82
    assert by_id["score-1"]["model"] is None
    assert by_id["generation-1"]["model"] is None
    assert by_id["generation-1"]["currency"] == "USD"


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


def test_filters_traces_by_status(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"status": "error"})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-error"]


def test_filters_traces_by_case_insensitive_root_name(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"name": "QUESTION"})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-success"]


def test_filters_traces_by_contained_event_type(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"event_type": "generation"})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-success"]


def test_filters_traces_by_case_insensitive_service(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"service": "RAG"})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-success"]


def test_filters_traces_by_environment(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"environment": "staging"})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-error"]


def test_blank_service_filter_is_ignored(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"service": "   "})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-success", "trace-error", "trace-tool"]


def test_combines_trace_filters(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"status": "success", "event_type": "tool_call"})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-tool"]


def test_blank_trace_name_filter_is_ignored(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    post_filter_fixture_events(client)

    response = client.get("/v1/traces", params={"name": "   "})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-success", "trace-error", "trace-tool"]


def test_rejects_invalid_trace_filter_values(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    status_response = client.get("/v1/traces", params={"status": "failed"})
    event_type_response = client.get("/v1/traces", params={"event_type": "unknown"})

    assert status_response.status_code == 422
    assert event_type_response.status_code == 422


def test_limits_traces_to_most_recent_n(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    for index in range(5):
        event = make_event(
            id=f"trace-{index}",
            trace_id=f"trace-{index}",
            start_time=f"2026-01-0{index + 1}T00:00:00+00:00",
            end_time=f"2026-01-0{index + 1}T00:00:01+00:00",
        )
        assert client.post("/v1/events", json=event).status_code == 201

    response = client.get("/v1/traces", params={"limit": 2})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-3", "trace-4"]


def test_filters_apply_before_limit(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    events = [
        make_event(
            id="success-old",
            trace_id="success-old",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:01+00:00",
        ),
        make_event(
            id="success-mid",
            trace_id="success-mid",
            start_time="2026-01-02T00:00:00+00:00",
            end_time="2026-01-02T00:00:01+00:00",
        ),
        make_event(
            id="error-newest",
            trace_id="error-newest",
            status="error",
            start_time="2026-01-03T00:00:00+00:00",
            end_time="2026-01-03T00:00:01+00:00",
            error="failed",
        ),
        make_event(
            id="success-new",
            trace_id="success-new",
            start_time="2026-01-04T00:00:00+00:00",
            end_time="2026-01-04T00:00:01+00:00",
        ),
    ]
    for event in events:
        assert client.post("/v1/events", json=event).status_code == 201

    response = client.get("/v1/traces", params={"status": "success", "limit": 2})

    assert response.status_code == 200
    traces = response.json()
    # The error trace is the newest overall, but the success filter drops it
    # before the limit selects the two most recent survivors.
    assert [trace["id"] for trace in traces] == ["success-mid", "success-new"]


def test_rejects_non_positive_limit(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    zero_response = client.get("/v1/traces", params={"limit": 0})
    negative_response = client.get("/v1/traces", params={"limit": -3})

    assert zero_response.status_code == 422
    assert negative_response.status_code == 422


def test_sorts_traces_by_slowest_root_duration(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    durations = {"trace-fast": 1, "trace-slow": 3, "trace-mid": 2}
    for trace_id, seconds in durations.items():
        event = make_event(
            id=trace_id,
            trace_id=trace_id,
            start_time="2026-01-01T00:00:00+00:00",
            end_time=f"2026-01-01T00:00:0{seconds}+00:00",
        )
        assert client.post("/v1/events", json=event).status_code == 201

    response = client.get("/v1/traces", params={"sort": "slowest"})

    assert response.status_code == 200
    traces = response.json()
    assert [trace["id"] for trace in traces] == ["trace-slow", "trace-mid", "trace-fast"]


def test_slowest_sort_with_limit_returns_top_n_slowest(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    durations = {"trace-fast": 1, "trace-slow": 4, "trace-mid": 2, "trace-slower": 3}
    for trace_id, seconds in durations.items():
        event = make_event(
            id=trace_id,
            trace_id=trace_id,
            start_time="2026-01-01T00:00:00+00:00",
            end_time=f"2026-01-01T00:00:0{seconds}+00:00",
        )
        assert client.post("/v1/events", json=event).status_code == 201

    response = client.get("/v1/traces", params={"sort": "slowest", "limit": 2})

    assert response.status_code == 200
    traces = response.json()
    # The two slowest survive the limit, still in slowest-first order.
    assert [trace["id"] for trace in traces] == ["trace-slow", "trace-slower"]


def test_slowest_sort_keeps_filters(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    events = [
        make_event(
            id="success-slowest",
            trace_id="success-slowest",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:05+00:00",
        ),
        make_event(
            id="error-mid",
            trace_id="error-mid",
            status="error",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:03+00:00",
            error="failed",
        ),
        make_event(
            id="error-fast",
            trace_id="error-fast",
            status="error",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:01+00:00",
            error="failed",
        ),
    ]
    for event in events:
        assert client.post("/v1/events", json=event).status_code == 201

    response = client.get("/v1/traces", params={"status": "error", "sort": "slowest"})

    assert response.status_code == 200
    traces = response.json()
    # The success trace is slowest overall, but the status filter drops it before
    # the slowest ordering ranks the surviving error traces.
    assert [trace["id"] for trace in traces] == ["error-mid", "error-fast"]


def test_rejects_invalid_trace_sort_value(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    response = client.get("/v1/traces", params={"sort": "newest"})

    assert response.status_code == 422


def test_filters_traces_by_min_duration(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    durations_ms = {"trace-fast": 100, "trace-mid": 250, "trace-slow": 500}
    for trace_id, ms in durations_ms.items():
        event = make_event(
            id=trace_id,
            trace_id=trace_id,
            start_time="2026-01-01T00:00:00+00:00",
            end_time=f"2026-01-01T00:00:00.{ms:03d}+00:00",
        )
        assert client.post("/v1/events", json=event).status_code == 201

    response = client.get("/v1/traces", params={"min_duration_ms": 250})

    assert response.status_code == 200
    traces = response.json()
    # The 250ms boundary is kept (>=); only the 100ms trace falls below it. Equal
    # start times leave the survivors in id order under the default recent sort.
    assert [trace["id"] for trace in traces] == ["trace-mid", "trace-slow"]


def test_min_duration_combines_with_status_sort_and_limit(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)
    events = [
        make_event(
            id="error-fast",
            trace_id="error-fast",
            status="error",
            error="failed",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:00.100+00:00",
        ),
        make_event(
            id="error-mid",
            trace_id="error-mid",
            status="error",
            error="failed",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:00.300+00:00",
        ),
        make_event(
            id="error-slow",
            trace_id="error-slow",
            status="error",
            error="failed",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:00.500+00:00",
        ),
        make_event(
            id="success-slowest",
            trace_id="success-slowest",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:01+00:00",
        ),
    ]
    for event in events:
        assert client.post("/v1/events", json=event).status_code == 201

    response = client.get(
        "/v1/traces",
        params={"status": "error", "min_duration_ms": 200, "sort": "slowest", "limit": 1},
    )

    assert response.status_code == 200
    traces = response.json()
    # success-slowest is slowest overall but dropped by status; error-fast is
    # dropped by the 200ms threshold; slowest ordering then ranks error-slow ahead
    # of error-mid, and limit=1 keeps just the slowest survivor.
    assert [trace["id"] for trace in traces] == ["error-slow"]


def test_rejects_non_positive_min_duration(tmp_path: Path) -> None:
    client, _ = make_client(tmp_path)

    zero_response = client.get("/v1/traces", params={"min_duration_ms": 0})
    negative_response = client.get("/v1/traces", params={"min_duration_ms": -5})

    assert zero_response.status_code == 422
    assert negative_response.status_code == 422


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
    assert trace["events"][0]["metadata"] == {
        "service": {"name": "rag-api", "environment": "production"}
    }
    assert trace["events"][3]["metadata"] == {
        "provider": "local",
        "prompt": {
            "name": "answer_question",
            "version": "v1",
            "template_sha256": "83ae0f830c7c24dbe19a8c08a882747e09a11257a5153d4a1ac46c9a0ab4374a",
        },
    }


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
