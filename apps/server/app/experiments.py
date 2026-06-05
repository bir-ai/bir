from __future__ import annotations

import json
import re
from pathlib import Path
from threading import Lock
from typing import Any

from pydantic import ValidationError

from .schemas import ExperimentExampleResultPayload, ExperimentIngestPayload, ExperimentSummaryPayload, LoadedExperiment


class JsonlExperimentStore:
    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)
        self._lock = Lock()

    def list_experiments(self) -> list[ExperimentSummaryPayload]:
        with self._lock:
            if not self.directory.exists():
                return []

            summaries = [
                self._load_summary(summary_path)
                for summary_path in self.directory.glob("*.summary.json")
                if summary_path.is_file()
            ]
            return sorted(summaries, key=lambda summary: (summary.start_time, summary.experiment_id), reverse=True)

    def load_experiment(self, experiment_id: str) -> LoadedExperiment | None:
        with self._lock:
            summary_path = self._summary_path_for_experiment(experiment_id)
            if summary_path is None:
                return None

            summary = self._load_summary(summary_path)
            result_path = self._resolve_result_path(summary.result_path)
            results = self._load_results(result_path, summary.experiment_id, summary.name)
            return LoadedExperiment(**summary.model_dump(mode="python"), results=results)

    def save_experiment(self, experiment: ExperimentIngestPayload) -> bool:
        with self._lock:
            if self._summary_path_for_experiment(experiment.summary.experiment_id) is not None:
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

    def _summary_path_for_experiment(self, experiment_id: str) -> Path | None:
        if not self.directory.exists():
            return None

        for summary_path in self.directory.glob("*.summary.json"):
            if not summary_path.is_file():
                continue
            summary = self._load_summary(summary_path)
            if summary.experiment_id == experiment_id:
                return summary_path
        return None

    def _load_summary(self, path: Path) -> ExperimentSummaryPayload:
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
                try:
                    payload = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Invalid JSON in experiment {path} at line {line_number}") from exc
                if not isinstance(payload, dict):
                    raise ValueError(f"Experiment {path} line {line_number} must contain a JSON object")
                _validate_experiment_row_metadata(payload, path, line_number, experiment_id, experiment_name)
                try:
                    results.append(ExperimentExampleResultPayload.model_validate(payload))
                except ValidationError as exc:
                    raise ValueError(f"Invalid experiment result in {path} at line {line_number}") from exc
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
