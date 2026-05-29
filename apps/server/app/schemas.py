from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0"
EventType = Literal["trace", "span", "generation", "tool_call", "score"]
EventStatus = Literal["success", "error"]


class TraceEventPayload(BaseModel):
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
        return {key: _validate_number(value, f"usage.{key}") for key, value in usage.items()}

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
        _validate_json_value(self.metadata, "metadata")
        _validate_json_value(self.input, "input")
        _validate_json_value(self.output, "output")
        if self.__pydantic_extra__:
            for key, value in self.__pydantic_extra__.items():
                _validate_json_value(value, key)
        return self


class HealthResponse(BaseModel):
    status: Literal["ok"]


class IngestEventResponse(BaseModel):
    accepted: int
    id: str


class LoadedTrace(BaseModel):
    id: str
    name: str
    start_time: datetime
    end_time: datetime
    status: EventStatus
    events: list[TraceEventPayload]


def _validate_number(value: Any, field: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be an int or float")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{field} must be finite")
    return value


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
