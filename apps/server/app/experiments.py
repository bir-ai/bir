"""JSONL experiment artifact storage for the Bir ingestion server."""

from __future__ import annotations

import json
import re
from pathlib import Path
from threading import Lock
from typing import Any

from pydantic import ValidationError

from .jsonl import iter_jsonl_lines_tolerating_torn_tail
from .schemas import ExperimentExampleResultPayload, ExperimentIngestPayload, ExperimentSummaryPayload, LoadedExperiment

_SUMMARY_SUFFIX = ".summary.json"


class LocalExperimentReader:
    """Read-only view over SDK-written experiment artifacts in a `.bir` directory.

    SDK summaries record `result_path` relative to the project root (for
    example `.bir/experiments/run.jsonl`), so the reader does not resolve it
    the way JsonlExperimentStore does. It relies instead on the SDK invariant
    that a result file sits next to its summary with the same stem
    (`<stem>.summary.json` / `<stem>.jsonl`). The SDK writes the summary when
    a run finishes, so a listed experiment is normally complete; a torn final
    result line can only appear in a narrow crash window and is skipped like
    the local trace reader does.
    """

    def __init__(self, directory: str | Path) -> None:
        """Create a reader rooted at the given experiment directory."""

        self.directory = Path(directory)

    def list_experiments(self) -> list[ExperimentSummaryPayload]:
        """Load SDK-written experiment summaries in newest-first order."""

        return _list_summaries(self.directory)

    def load_experiment(self, experiment_id: str) -> LoadedExperiment | None:
        """Load an SDK-written experiment summary and its sibling result rows."""

        summary_path = _find_summary_path(self.directory, experiment_id)
        if summary_path is None:
            return None

        summary = _load_summary_file(summary_path)
        result_path = _sibling_result_path(summary_path)
        if not result_path.exists():
            raise ValueError(f"Experiment result file {result_path} does not exist")
        results = [
            _parse_result_line(result_path, line_number, stripped, summary.experiment_id, summary.name)
            for line_number, stripped in iter_jsonl_lines_tolerating_torn_tail(result_path)
        ]
        return LoadedExperiment(**summary.model_dump(mode="python"), results=results)


class JsonlExperimentStore:
    """Persist and query experiment summaries and result rows from local files."""

    def __init__(self, directory: str | Path) -> None:
        """Create a store rooted at the given experiment directory."""

        self.directory = Path(directory)
        self._lock = Lock()

    def list_experiments(self) -> list[ExperimentSummaryPayload]:
        """Load experiment summaries in newest-first order."""

        with self._lock:
            return _list_summaries(self.directory)

    def load_experiment(self, experiment_id: str) -> LoadedExperiment | None:
        """Load an experiment summary and result rows by experiment ID."""

        with self._lock:
            summary_path = _find_summary_path(self.directory, experiment_id)
            if summary_path is None:
                return None

            summary = _load_summary_file(summary_path)
            result_path = self._resolve_result_path(summary.result_path)
            results = self._load_results(result_path, summary.experiment_id, summary.name)
            return LoadedExperiment(**summary.model_dump(mode="python"), results=results)

    def save_experiment(self, experiment: ExperimentIngestPayload) -> bool:
        """Persist an uploaded experiment unless its ID already exists."""

        with self._lock:
            if _find_summary_path(self.directory, experiment.summary.experiment_id) is not None:
                return False

            self.directory.mkdir(parents=True, exist_ok=True)
            result_name = _safe_artifact_name(experiment.summary.name, experiment.summary.experiment_id)
            result_path = self.directory / f"{result_name}.jsonl"
            summary_path = self.directory / f"{result_name}.summary.json"
            relative_result_path = result_path.name
            summary = experiment.summary.model_copy(update={"result_path": relative_result_path})

            with result_path.open("w", encoding="utf-8") as result_file:
                for result in experiment.results:
                    record = {
                        "experiment_id": summary.experiment_id,
                        "experiment_name": summary.name,
                        **result.model_dump(mode="json", exclude_none=False),
                    }
                    result_file.write(json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False))
                    result_file.write("\n")

            summary_path.write_text(
                json.dumps(summary.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n",
                encoding="utf-8",
            )
            return True

    def _load_results(
        self,
        path: Path,
        experiment_id: str,
        experiment_name: str,
    ) -> list[ExperimentExampleResultPayload]:
        if not path.exists():
            raise ValueError(f"Experiment result file {path} does not exist")

        results: list[ExperimentExampleResultPayload] = []
        with path.open("r", encoding="utf-8") as result_file:
            for line_number, line in enumerate(result_file, start=1):
                stripped = line.strip()
                if not stripped:
                    continue
                results.append(_parse_result_line(path, line_number, stripped, experiment_id, experiment_name))
        return results

    def _resolve_result_path(self, result_path: str) -> Path:
        path = Path(result_path)
        if path.is_absolute():
            raise ValueError("Experiment result_path must be relative to the experiment store")

        store_directory = self.directory.resolve(strict=False)
        candidate = (store_directory / path).resolve(strict=False)
        try:
            candidate.relative_to(store_directory)
        except ValueError as exc:
            raise ValueError("Experiment result_path must stay within the experiment store") from exc
        return candidate


def _list_summaries(directory: Path) -> list[ExperimentSummaryPayload]:
    if not directory.exists():
        return []

    summaries = [
        _load_summary_file(summary_path)
        for summary_path in directory.glob(f"*{_SUMMARY_SUFFIX}")
        if summary_path.is_file()
    ]
    return sorted(summaries, key=lambda summary: (summary.start_time, summary.experiment_id), reverse=True)


def _find_summary_path(directory: Path, experiment_id: str) -> Path | None:
    if not directory.exists():
        return None

    for summary_path in directory.glob(f"*{_SUMMARY_SUFFIX}"):
        if not summary_path.is_file():
            continue
        summary = _load_summary_file(summary_path)
        if summary.experiment_id == experiment_id:
            return summary_path
    return None


def _load_summary_file(path: Path) -> ExperimentSummaryPayload:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in experiment summary {path}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"Experiment summary {path} must contain a JSON object")
    try:
        return ExperimentSummaryPayload.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(f"Invalid experiment summary {path}") from exc


def _parse_result_line(
    path: Path,
    line_number: int,
    stripped: str,
    experiment_id: str,
    experiment_name: str,
) -> ExperimentExampleResultPayload:
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in experiment {path} at line {line_number}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"Experiment {path} line {line_number} must contain a JSON object")
    _validate_experiment_row_metadata(payload, path, line_number, experiment_id, experiment_name)
    try:
        return ExperimentExampleResultPayload.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(f"Invalid experiment result in {path} at line {line_number}") from exc


def _sibling_result_path(summary_path: Path) -> Path:
    return summary_path.with_name(summary_path.name.removesuffix(_SUMMARY_SUFFIX) + ".jsonl")


def _validate_experiment_row_metadata(
    payload: dict[str, Any],
    path: Path,
    line_number: int,
    experiment_id: str,
    experiment_name: str,
) -> None:
    row_experiment_id = payload.get("experiment_id")
    row_experiment_name = payload.get("experiment_name")
    if row_experiment_id != experiment_id:
        raise ValueError(f"Experiment {path} line {line_number} contains a different experiment_id")
    if row_experiment_name != experiment_name:
        raise ValueError(f"Experiment {path} line {line_number} contains a different experiment_name")


def _safe_artifact_name(name: str, experiment_id: str) -> str:
    safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name.strip()).strip("-") or "experiment"
    safe_experiment_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", experiment_id.strip()).strip("-") or "experiment"
    return f"{safe_name}-{safe_experiment_id}"
