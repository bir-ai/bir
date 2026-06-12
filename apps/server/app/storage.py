"""JSONL event storage and read-only local data access for the Bir server."""

from __future__ import annotations

import json
from pathlib import Path
from threading import Lock

from pydantic import ValidationError

from .jsonl import iter_jsonl_lines_tolerating_torn_tail
from .schemas import EventStatus, EventType, LoadedTrace, TraceEventPayload

EVENT_SORT_PRIORITY = {
    "trace": 0,
    "span": 1,
    "generation": 1,
    "tool_call": 1,
    "score": 2,
}


class TraceEventReader:
    """Shared trace queries over a `load_events()` implementation."""

    def load_events(self) -> list[TraceEventPayload]:
        """Load all available events in file order."""

        raise NotImplementedError

    def load_traces(
        self,
        *,
        status: EventStatus | None = None,
        name: str | None = None,
        event_type: EventType | None = None,
    ) -> list[LoadedTrace]:
        """Load complete traces, optionally filtered by root status, name, or event type."""

        events_by_trace_id: dict[str, list[TraceEventPayload]] = {}
        for event in self.load_events():
            events_by_trace_id.setdefault(event.trace_id, []).append(event)

        name_filter = name.strip().lower() if name is not None else None
        traces: list[LoadedTrace] = []
        for trace_id, events in events_by_trace_id.items():
            trace = _loaded_trace(trace_id, events)
            if trace is not None and _matches_filters(
                trace,
                status=status,
                name_filter=name_filter,
                event_type=event_type,
            ):
                traces.append(trace)
        return sorted(traces, key=lambda trace: (trace.start_time, trace.id))

    def load_trace(self, trace_id: str) -> LoadedTrace | None:
        """Load one complete trace by ID."""

        events = [event for event in self.load_events() if event.trace_id == trace_id]
        return _loaded_trace(trace_id, events)


class JsonlEventStore(TraceEventReader):
    """Persist and query validated trace events from a local JSONL file.

    Event IDs are indexed in memory after the first duplicate check so each
    append stays O(1) instead of rescanning the file. The store assumes it is
    the only writer of its JSONL file while the process is running.
    """

    def __init__(self, path: str | Path) -> None:
        """Create a store backed by the given JSONL path."""

        self.path = Path(path)
        self._lock = Lock()
        self._event_ids: set[str] | None = None

    def append(self, event: TraceEventPayload) -> bool:
        """Append an event unless its ID already exists."""

        with self._lock:
            event_ids = self._load_event_ids()
            if event.id in event_ids:
                return False

            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = event.model_dump(mode="json", exclude_none=False)
            with self.path.open("a", encoding="utf-8") as events_file:
                events_file.write(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False))
                events_file.write("\n")
            event_ids.add(event.id)
            return True

    def has_event(self, event_id: str) -> bool:
        """Return whether the store already contains an event ID."""

        with self._lock:
            return event_id in self._load_event_ids()

    def _load_event_ids(self) -> set[str]:
        if self._event_ids is not None:
            return self._event_ids

        event_ids: set[str] = set()
        if self.path.exists():
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
                    event_id = payload.get("id")
                    if isinstance(event_id, str):
                        event_ids.add(event_id)

        self._event_ids = event_ids
        return event_ids

    def load_events(self) -> list[TraceEventPayload]:
        """Load all persisted events in file order."""

        with self._lock:
            if not self.path.exists():
                return []

            events: list[TraceEventPayload] = []
            with self.path.open("r", encoding="utf-8") as events_file:
                for line_number, line in enumerate(events_file, start=1):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    events.append(_parse_event_line(self.path, line_number, stripped))
            return events


class LocalJsonlEventReader(TraceEventReader):
    """Read-only view over a trace JSONL file owned by another writer (the SDK).

    The file is re-parsed only when its mtime or size changes. A final line
    without a trailing newline may be a write still in progress, so an
    unparseable tail is skipped instead of raising; it surfaces on the next
    read after the write completes.
    """

    def __init__(self, path: str | Path) -> None:
        """Create a reader over the given JSONL path."""

        self.path = Path(path)
        self._lock = Lock()
        self._cached_signature: tuple[int, int] | None = None
        self._cached_events: list[TraceEventPayload] = []

    def load_events(self) -> list[TraceEventPayload]:
        """Load all complete events, re-parsing the file only when it changed."""

        with self._lock:
            try:
                stat_result = self.path.stat()
            except FileNotFoundError:
                self._cached_signature = None
                self._cached_events = []
                return []

            # Stat before reading so a write that races the read invalidates
            # the cache again on the next request instead of going unnoticed.
            signature = (stat_result.st_mtime_ns, stat_result.st_size)
            if signature != self._cached_signature:
                self._cached_events = self._read_events()
                self._cached_signature = signature
            return list(self._cached_events)

    def _read_events(self) -> list[TraceEventPayload]:
        return [
            _parse_event_line(self.path, line_number, stripped)
            for line_number, stripped in iter_jsonl_lines_tolerating_torn_tail(self.path)
        ]


def _parse_event_line(path: Path, line_number: int, stripped: str) -> TraceEventPayload:
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in event store {path} at line {line_number}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"Event store {path} line {line_number} must contain a JSON object")
    try:
        return TraceEventPayload.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(f"Invalid event in store {path} at line {line_number}") from exc


def _loaded_trace(trace_id: str, events: list[TraceEventPayload]) -> LoadedTrace | None:
    sorted_events = sorted(events, key=_event_sort_key)
    root = next((event for event in sorted_events if event.type == "trace" and event.id == trace_id), None)
    if root is None:
        return None
    return LoadedTrace(
        id=trace_id,
        name=root.name,
        start_time=root.start_time,
        end_time=root.end_time,
        status=root.status,
        events=sorted_events,
    )


def _matches_filters(
    trace: LoadedTrace,
    *,
    status: EventStatus | None,
    name_filter: str | None,
    event_type: EventType | None,
) -> bool:
    if status is not None and trace.status != status:
        return False
    if name_filter and name_filter not in trace.name.lower():
        return False
    if event_type is not None and not any(event.type == event_type for event in trace.events):
        return False
    return True


def _event_sort_key(event: TraceEventPayload) -> tuple[str, int, str, str]:
    start_time = event.start_time.isoformat()
    end_time = event.end_time.isoformat()
    return (start_time, EVENT_SORT_PRIORITY.get(event.type, 99), end_time, event.id)
