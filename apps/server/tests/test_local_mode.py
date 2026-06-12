from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.storage import LocalJsonlEventReader

from test_server import CONTRACT_EVENTS_PATH, make_event, make_experiment_result, make_experiment_summary

READ_ONLY_DETAIL = "Ingestion is disabled: the server is running in read-only local data mode (BIR_DATA_DIR)"


def make_local_client(tmp_path: Path) -> tuple[TestClient, Path]:
    data_dir = tmp_path / ".bir"
    data_dir.mkdir()
    return TestClient(create_app(local_data_dir=data_dir)), data_dir


def event_line(**overrides: object) -> str:
    return json.dumps(make_event(**overrides), sort_keys=True, separators=(",", ":")) + "\n"


def append_text(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8") as trace_file:
        trace_file.write(text)


def write_filter_fixture_events(traces_path: Path) -> None:
    events = [
        make_event(
            id="trace-success",
            trace_id="trace-success",
            name="answer_question",
            start_time="2026-01-01T00:00:00+00:00",
            end_time="2026-01-01T00:00:01+00:00",
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
    traces_path.write_text(
        "".join(json.dumps(event, sort_keys=True) + "\n" for event in events),
        encoding="utf-8",
    )


def test_local_mode_serves_sdk_written_trace_file(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    shutil.copyfile(CONTRACT_EVENTS_PATH, data_dir / "traces.jsonl")

    events_response = client.get("/v1/events")
    traces_response = client.get("/v1/traces")
    detail_response = client.get("/v1/traces/trace-fixture-1")

    assert events_response.status_code == 200
    assert len(events_response.json()) == 5
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
    assert detail_response.status_code == 200
    assert detail_response.json()["name"] == "answer_question"


def test_local_mode_returns_empty_lists_for_missing_trace_file(tmp_path: Path) -> None:
    client, _ = make_local_client(tmp_path)

    assert client.get("/v1/events").json() == []
    assert client.get("/v1/traces").json() == []
    assert client.get("/v1/traces/missing").status_code == 404


def test_local_mode_sees_events_appended_between_requests(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    traces_path = data_dir / "traces.jsonl"
    append_text(traces_path, event_line())

    first_response = client.get("/v1/traces")
    append_text(traces_path, event_line(id="trace-2", trace_id="trace-2", name="second"))
    second_response = client.get("/v1/traces")

    assert first_response.status_code == 200
    assert [trace["id"] for trace in first_response.json()] == ["trace-1"]
    assert second_response.status_code == 200
    assert [trace["id"] for trace in second_response.json()] == ["trace-1", "trace-2"]


def test_local_mode_skips_torn_final_line_until_write_completes(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    traces_path = data_dir / "traces.jsonl"
    second_line = event_line(id="trace-2", trace_id="trace-2", name="second")
    split_at = len(second_line) // 2
    append_text(traces_path, event_line())
    append_text(traces_path, second_line[:split_at])

    torn_response = client.get("/v1/traces")
    append_text(traces_path, second_line[split_at:])
    completed_response = client.get("/v1/traces")

    assert torn_response.status_code == 200
    assert [trace["id"] for trace in torn_response.json()] == ["trace-1"]
    assert completed_response.status_code == 200
    assert [trace["id"] for trace in completed_response.json()] == ["trace-1", "trace-2"]


def test_local_mode_includes_complete_final_line_without_newline(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    traces_path = data_dir / "traces.jsonl"
    append_text(traces_path, event_line() + event_line(id="trace-2", trace_id="trace-2", name="second").rstrip("\n"))

    response = client.get("/v1/traces")

    assert response.status_code == 200
    assert [trace["id"] for trace in response.json()] == ["trace-1", "trace-2"]


def test_local_reader_skips_torn_multibyte_tail(tmp_path: Path) -> None:
    traces_path = tmp_path / "traces.jsonl"
    traces_path.write_bytes(event_line().encode("utf-8") + '{"name":"café'.encode("utf-8")[:-1])
    reader = LocalJsonlEventReader(traces_path)

    events = reader.load_events()

    assert [event.id for event in events] == ["trace-1"]


def test_local_reader_raises_for_malformed_complete_lines(tmp_path: Path) -> None:
    first_path = tmp_path / "first.jsonl"
    first_path.write_text("not json\n" + event_line(), encoding="utf-8")
    last_path = tmp_path / "last.jsonl"
    last_path.write_text(event_line() + "not json\n", encoding="utf-8")

    with pytest.raises(ValueError, match=r"Invalid JSON in event store .* at line 1"):
        LocalJsonlEventReader(first_path).load_events()
    with pytest.raises(ValueError, match=r"Invalid JSON in event store .* at line 2"):
        LocalJsonlEventReader(last_path).load_events()


def test_local_reader_does_not_reparse_unchanged_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    traces_path = tmp_path / "traces.jsonl"
    append_text(traces_path, event_line())
    reader = LocalJsonlEventReader(traces_path)
    assert [event.id for event in reader.load_events()] == ["trace-1"]

    def fail_read() -> list[object]:
        raise AssertionError("unchanged file must not be re-parsed")

    monkeypatch.setattr(reader, "_read_events", fail_read)

    assert [event.id for event in reader.load_events()] == ["trace-1"]


def test_local_mode_trace_filters(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    write_filter_fixture_events(data_dir / "traces.jsonl")

    status_response = client.get("/v1/traces", params={"status": "error"})
    name_response = client.get("/v1/traces", params={"name": "QUESTION"})
    event_type_response = client.get("/v1/traces", params={"event_type": "tool_call"})

    assert status_response.status_code == 200
    assert [trace["id"] for trace in status_response.json()] == ["trace-error"]
    assert name_response.status_code == 200
    assert [trace["id"] for trace in name_response.json()] == ["trace-success"]
    assert event_type_response.status_code == 200
    assert [trace["id"] for trace in event_type_response.json()] == ["trace-tool"]


def test_local_mode_rejects_ingestion(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    traces_path = data_dir / "traces.jsonl"
    append_text(traces_path, event_line())
    original_content = traces_path.read_text(encoding="utf-8")

    event_response = client.post("/v1/events", json=make_event(id="trace-2", trace_id="trace-2"))
    batch_response = client.post("/v1/events/batch", json=[make_event(id="trace-3", trace_id="trace-3")])

    assert event_response.status_code == 403
    assert event_response.json() == {"detail": READ_ONLY_DETAIL}
    assert batch_response.status_code == 403
    assert batch_response.json() == {"detail": READ_ONLY_DETAIL}
    assert traces_path.read_text(encoding="utf-8") == original_content


def test_local_mode_rejects_experiment_ingestion(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)

    response = client.post(
        "/v1/experiments",
        json={"summary": make_experiment_summary(), "results": [make_experiment_result()]},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": READ_ONLY_DETAIL}
    assert not (data_dir / "experiments").exists()


def write_sdk_experiment(
    data_dir: Path,
    summary: dict[str, object],
    results: list[dict[str, object]],
) -> Path:
    """Write experiment artifacts the way the SDK does.

    The summary's result_path stays relative to the project root while the
    result file sits next to the summary with the same stem.
    """

    experiments_dir = data_dir / "experiments"
    experiments_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{summary['name']}-{summary['experiment_id']}"
    result_path = experiments_dir / f"{stem}.jsonl"
    result_path.write_text(
        "".join(json.dumps(result, sort_keys=True) + "\n" for result in results),
        encoding="utf-8",
    )
    summary_path = experiments_dir / f"{stem}.summary.json"
    summary_path.write_text(json.dumps(summary, sort_keys=True) + "\n", encoding="utf-8")
    return result_path


def make_sdk_experiment_summary(**overrides: object) -> dict[str, object]:
    summary = make_experiment_summary(**overrides)
    summary["result_path"] = f".bir/experiments/{summary['name']}-{summary['experiment_id']}.jsonl"
    return summary


def test_local_mode_lists_sdk_experiments_newest_first(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    write_sdk_experiment(data_dir, make_sdk_experiment_summary(), [make_experiment_result()])
    write_sdk_experiment(
        data_dir,
        make_sdk_experiment_summary(
            experiment_id="experiment-2",
            name="prompt-v2",
            start_time="2026-01-02T00:00:00+00:00",
            end_time="2026-01-02T00:00:01+00:00",
        ),
        [make_experiment_result(experiment_id="experiment-2", experiment_name="prompt-v2", id="result-2")],
    )

    response = client.get("/v1/experiments")

    assert response.status_code == 200
    summaries = response.json()
    assert [summary["experiment_id"] for summary in summaries] == ["experiment-2", "experiment-1"]
    assert summaries[1]["aggregate_scores"] == {"contains": 1.0}


def test_local_mode_gets_experiment_detail_from_sibling_result_file(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    write_sdk_experiment(data_dir, make_sdk_experiment_summary(), [make_experiment_result(trace_id="trace-1")])

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 200
    experiment = response.json()
    assert experiment["experiment_id"] == "experiment-1"
    assert experiment["result_path"] == ".bir/experiments/prompt-v1-experiment-1.jsonl"
    assert len(experiment["results"]) == 1
    assert experiment["results"][0]["example_id"] == "q1"
    assert experiment["results"][0]["trace_id"] == "trace-1"


def test_local_mode_experiment_detail_returns_404_for_missing_experiment(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    write_sdk_experiment(data_dir, make_sdk_experiment_summary(), [make_experiment_result()])

    response = client.get("/v1/experiments/missing-experiment")

    assert response.status_code == 404
    assert response.json() == {"detail": "Experiment not found"}


def test_local_mode_skips_torn_final_experiment_result_line_until_completed(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    result_path = write_sdk_experiment(data_dir, make_sdk_experiment_summary(), [make_experiment_result()])
    second_line = json.dumps(make_experiment_result(id="result-2", example_id="q2"), sort_keys=True) + "\n"
    split_at = len(second_line) // 2
    append_text(result_path, second_line[:split_at])

    torn_response = client.get("/v1/experiments/experiment-1")
    append_text(result_path, second_line[split_at:])
    completed_response = client.get("/v1/experiments/experiment-1")

    assert torn_response.status_code == 200
    assert [result["id"] for result in torn_response.json()["results"]] == ["result-1"]
    assert completed_response.status_code == 200
    assert [result["id"] for result in completed_response.json()["results"]] == ["result-1", "result-2"]


def test_local_mode_experiment_detail_errors_when_sibling_result_file_is_missing(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    result_path = write_sdk_experiment(data_dir, make_sdk_experiment_summary(), [make_experiment_result()])
    result_path.unlink()

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 500
    assert "does not exist" in response.json()["detail"]


def test_local_mode_experiment_detail_errors_for_mismatched_result_row(tmp_path: Path) -> None:
    client, data_dir = make_local_client(tmp_path)
    write_sdk_experiment(
        data_dir,
        make_sdk_experiment_summary(),
        [make_experiment_result(experiment_id="other-experiment")],
    )

    response = client.get("/v1/experiments/experiment-1")

    assert response.status_code == 500
    assert "different experiment_id" in response.json()["detail"]


def test_bir_data_dir_env_enables_local_mode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data_dir = tmp_path / ".bir"
    data_dir.mkdir()
    append_text(data_dir / "traces.jsonl", event_line())
    monkeypatch.setenv("BIR_DATA_DIR", str(data_dir))
    client = TestClient(create_app())

    traces_response = client.get("/v1/traces")
    ingest_response = client.post("/v1/events", json=make_event(id="trace-2", trace_id="trace-2"))

    assert traces_response.status_code == 200
    assert [trace["id"] for trace in traces_response.json()] == ["trace-1"]
    assert ingest_response.status_code == 403


def test_explicit_store_paths_ignore_bir_data_dir_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BIR_DATA_DIR", str(tmp_path / ".bir"))
    event_store_path = tmp_path / "events.jsonl"
    client = TestClient(create_app(event_store_path=event_store_path))

    response = client.post("/v1/events", json=make_event())

    assert response.status_code == 201
    assert event_store_path.exists()
