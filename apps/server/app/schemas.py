"""Pydantic request and response schemas for the Bir ingestion server."""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .redaction import redact_secret_text, redact_value

SCHEMA_VERSION = "1.0"
EventType = Literal["trace", "span", "generation", "tool_call", "score"]
EventStatus = Literal["success", "error"]


class TraceEventPayload(BaseModel):
    """Validated trace event payload accepted by the ingestion API."""

    model_config = ConfigDict(extra="allow")

    schema_version: Literal["1.0"]
    id: str = Field(min_length=1)
    trace_id: str = Field(min_length=1)
    parent_id: str | None
    name: str = Field(min_length=1)
    type: EventType
    start_time: datetime
    end_time: datetime
    status: EventStatus
    metadata: dict[str, Any]
    input: Any
    output: Any
    error: str | None
    value: int | float | None = None
    model: str | None = None
    usage: dict[str, int | float] | None = None
    cost: dict[str, int | float] | None = None
    currency: str | None = None

    @field_validator("value", mode="before")
    @classmethod
    def validate_score_value(cls, value: Any) -> int | float | None:
        if value is None:
            return None
        return _validate_number(value, "value")

    @field_validator("usage", mode="before")
    @classmethod
    def validate_usage(cls, usage: Any) -> Any:
        if usage is None:
            return None
        if not isinstance(usage, dict):
            return usage
        return {key: _validate_non_negative_number(value, f"usage.{key}") for key, value in usage.items()}

    @field_validator("cost", mode="before")
    @classmethod
    def validate_cost(cls, cost: Any) -> Any:
        if cost is None:
            return None
        if not isinstance(cost, dict):
            return cost
        return {key: _validate_non_negative_number(value, f"cost.{key}") for key, value in cost.items()}

    @model_validator(mode="after")
    def validate_event_shape(self) -> TraceEventPayload:
        if self.end_time < self.start_time:
            raise ValueError("end_time must be greater than or equal to start_time")
        if self.type == "trace":
            if self.id != self.trace_id:
                raise ValueError("trace event id must match trace_id")
            if self.parent_id is not None:
                raise ValueError("trace event parent_id must be null")
        elif self.parent_id is None:
            raise ValueError(f"{self.type} event requires parent_id")
        if self.type == "score" and self.value is None:
            raise ValueError("score event requires value")
        if self.cost is not None and self.currency is None:
            self.currency = "USD"
        _validate_retrieval_document_numbers(self.type, self.metadata, self.output)
        _validate_json_value(self.metadata, "metadata")
        _validate_json_value(self.input, "input")
        _validate_json_value(self.output, "output")
        if self.__pydantic_extra__:
            for key, value in self.__pydantic_extra__.items():
                _validate_json_value(value, key)
        self.metadata = redact_value(self.metadata)
        self.input = redact_value(self.input)
        self.output = redact_value(self.output)
        if self.error is not None:
            self.error = redact_secret_text(self.error)
        if self.__pydantic_extra__:
            for key, value in list(self.__pydantic_extra__.items()):
                self.__pydantic_extra__[key] = redact_value(value, key=key)
        return self


class HealthResponse(BaseModel):
    """Health check response body."""

    status: Literal["ok"]


class IngestEventResponse(BaseModel):
    """Response returned after ingesting a trace event."""

    accepted: int
    id: str


class IngestExperimentResponse(BaseModel):
    """Response returned after ingesting an experiment."""

    accepted: int
    id: str


class LoadedTrace(BaseModel):
    """Trace detail response with the root trace metadata and ordered events."""

    id: str
    name: str
    start_time: datetime
    end_time: datetime
    status: EventStatus
    events: list[TraceEventPayload]


class EvalScorePayload(BaseModel):
    """Validated evaluator score payload."""

    name: str = Field(min_length=1)
    value: int | float
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("value", mode="before")
    @classmethod
    def validate_value(cls, value: Any) -> int | float:
        return _validate_number(value, "value")

    @model_validator(mode="after")
    def validate_score_shape(self) -> EvalScorePayload:
        _validate_json_value(self.metadata, "metadata")
        self.metadata = redact_value(self.metadata)
        return self


class ExperimentExampleResultPayload(BaseModel):
    """Validated result row for one experiment example."""

    id: str = Field(min_length=1)
    example_id: str = Field(min_length=1)
    trace_id: str | None = Field(default=None, min_length=1)
    input: Any
    expected: Any
    output: Any
    scores: list[EvalScorePayload]
    start_time: datetime
    end_time: datetime
    duration_ms: int | float | None = None
    status: EventStatus
    error: str | None

    @field_validator("duration_ms", mode="before")
    @classmethod
    def validate_duration(cls, value: Any) -> int | float | None:
        if value is None:
            return None
        return _validate_number(value, "duration_ms")

    @model_validator(mode="after")
    def validate_result_shape(self) -> ExperimentExampleResultPayload:
        if self.end_time < self.start_time:
            raise ValueError("end_time must be greater than or equal to start_time")
        _validate_json_value(self.input, "input")
        _validate_json_value(self.expected, "expected")
        _validate_json_value(self.output, "output")
        self.input = redact_value(self.input)
        self.expected = redact_value(self.expected)
        self.output = redact_value(self.output)
        if self.error is not None:
            self.error = redact_secret_text(self.error)
        return self


class ExperimentSummaryPayload(BaseModel):
    """Validated summary metadata for an experiment result file."""

    schema_version: Literal["1.0"]
    experiment_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    start_time: datetime
    end_time: datetime
    status: EventStatus
    example_count: int = Field(ge=0)
    error_count: int = Field(ge=0)
    aggregate_scores: dict[str, int | float]
    result_path: str = Field(min_length=1)

    @field_validator("aggregate_scores", mode="before")
    @classmethod
    def validate_aggregate_scores(cls, scores: Any) -> Any:
        if not isinstance(scores, dict):
            return scores
        return {key: _validate_number(value, f"aggregate_scores.{key}") for key, value in scores.items()}

    @model_validator(mode="after")
    def validate_summary_shape(self) -> ExperimentSummaryPayload:
        if self.end_time < self.start_time:
            raise ValueError("end_time must be greater than or equal to start_time")
        return self


class LoadedExperiment(ExperimentSummaryPayload):
    """Experiment detail response with summary fields and result rows."""

    results: list[ExperimentExampleResultPayload]


class ExperimentIngestPayload(BaseModel):
    """Payload used to upload an experiment summary and result rows."""

    summary: ExperimentSummaryPayload
    results: list[ExperimentExampleResultPayload]


def _validate_number(value: Any, field: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be an int or float")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{field} must be finite")
    return value


def _validate_non_negative_number(value: Any, field: str) -> int | float:
    numeric_value = _validate_number(value, field)
    if numeric_value < 0:
        raise ValueError(f"{field} must be non-negative")
    return numeric_value


def _validate_non_negative_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an int")
    if value < 0:
        raise ValueError(f"{field} must be non-negative")
    return value


def _validate_retrieval_document_numbers(event_type: str, metadata: dict[str, Any], output: Any) -> None:
    if event_type != "tool_call" or metadata.get("kind") != "retrieval":
        return
    if not isinstance(output, dict):
        return
    documents = output.get("documents")
    if not isinstance(documents, list):
        return
    for index, document in enumerate(documents):
        if not isinstance(document, dict):
            continue
        if document.get("rank") is not None:
            _validate_non_negative_int(document["rank"], f"output.documents[{index}].rank")
        if document.get("score") is not None:
            _validate_non_negative_number(document["score"], f"output.documents[{index}].score")


def _validate_json_value(value: Any, field: str) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        _validate_number(value, field)
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_value(item, f"{field}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{field} keys must be strings")
            _validate_json_value(item, f"{field}.{key}")
        return
    raise ValueError(f"{field} must be JSON-compatible")
