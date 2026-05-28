from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError

from .schemas import LoadedTrace, TraceEventPayload

EVENT_SORT_PRIORITY = {
    "trace": 0,
    "span": 1,
    "generation": 1,
    "tool_call": 1,
    "score": 2,
}


class JsonlEventStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def append(self, event: TraceEventPayload) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = event.model_dump(mode="json", exclude_none=False)
        with self.path.open("a", encoding="utf-8") as events_file:
            events_file.write(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False))
            events_file.write("\n")

    def load_events(self) -> list[TraceEventPayload]:
        if not self.path.exists():
            return []

        events: list[TraceEventPayload] = []
        with self.path.open("r", encoding="utf-8") as events_file:
            for line_number, line in enumerate(events_file, start=1):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    payload = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Invalid JSON in event store {self.path} at line {line_number}") from exc
                if not isinstance(payload, dict):
                    raise ValueError(f"Event store {self.path} line {line_number} must contain a JSON object")
                try:
                    events.append(TraceEventPayload.model_validate(payload))
                except ValidationError as exc:
                    raise ValueError(f"Invalid event in store {self.path} at line {line_number}") from exc
        return events

    def load_traces(self) -> list[LoadedTrace]:
        events_by_trace_id: dict[str, list[TraceEventPayload]] = {}
        for event in self.load_events():
            events_by_trace_id.setdefault(event.trace_id, []).append(event)

        traces: list[LoadedTrace] = []
        for trace_id, events in events_by_trace_id.items():
            sorted_events = sorted(events, key=_event_sort_key)
            root = next((event for event in sorted_events if event.type == "trace" and event.id == trace_id), None)
            if root is None:
                continue
            traces.append(
                LoadedTrace(
                    id=trace_id,
                    name=root.name,
                    start_time=root.start_time,
                    end_time=root.end_time,
                    status=root.status,
                    events=sorted_events,
                )
            )
        return sorted(traces, key=lambda trace: (trace.start_time, trace.id))


def _event_sort_key(event: TraceEventPayload) -> tuple[str, int, str, str]:
    start_time = event.start_time.isoformat()
    end_time = event.end_time.isoformat()
    return (start_time, EVENT_SORT_PRIORITY.get(event.type, 99), end_time, event.id)
