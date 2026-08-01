"""JSONL event storage and read-only local data access for the Bir server."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from heapq import heappush, heapreplace
from pathlib import Path
from threading import Lock
from typing import TypedDict

from pydantic import ValidationError

from .jsonl import iter_jsonl_lines_tolerating_torn_tail
from .schemas import (
    EventStatus,
    EventType,
    LoadedTrace,
    TraceEventPayload,
    TraceIntegrationSummaryPayload,
    TraceModelSummaryPayload,
    TraceProviderSummaryPayload,
    TraceSort,
    TraceSummaryPayload,
)

EVENT_SORT_PRIORITY = {
    "trace": 0,
    "span": 1,
    "generation": 1,
    "tool_call": 1,
    "score": 2,
}
EVENT_TYPE_BITS: dict[EventType, int] = {
    "trace": 1 << 0,
    "span": 1 << 1,
    "generation": 1 << 2,
    "tool_call": 1 << 3,
    "score": 1 << 4,
}


class _BreakdownTotals(TypedDict):
    generation_count: int
    total_tokens: int | float
    input_tokens: int | float
    output_tokens: int | float
    total_cost: int | float


@dataclass(slots=True)
class _TraceRootSummary:
    """Root fields needed for filtering, ordering, and summary aggregation."""

    id: str
    name: str
    start_time: datetime
    end_time: datetime
    status: EventStatus
    source: str | None
    service: str | None
    environment: str | None
    event_sort_key: tuple[str, int, str, str]


@dataclass(slots=True)
class _TraceSummaryState:
    """Compact per-trace aggregate that does not retain parsed event models."""

    root: _TraceRootSummary | None = None
    event_count: int = 0
    event_type_bits: int = 0
    generation_count: int = 0
    total_tokens: int | float = 0
    total_cost: int | float = 0
    currencies: set[str] | None = None
    models: dict[str, _BreakdownTotals] | None = None
    providers: dict[str, _BreakdownTotals] | None = None
    integrations: dict[str, _BreakdownTotals] | None = None


class TraceEventReader:
    """Shared trace queries over a lazy internal event iterator."""

    def _iter_events(self) -> Iterator[TraceEventPayload]:
        """Yield available events in file order without an intermediate list."""

        raise NotImplementedError

    def load_events(self) -> list[TraceEventPayload]:
        """Load all available events in file order for the public list response."""

        return list(self._iter_events())

    def load_traces(
        self,
        *,
        status: EventStatus | None = None,
        name: str | None = None,
        event_type: EventType | None = None,
        source: str | None = None,
        service: str | None = None,
        environment: str | None = None,
        min_duration_ms: float | None = None,
        sort: TraceSort = "recent",
        limit: int | None = None,
        before_start_time: datetime | None = None,
        before_id: str | None = None,
    ) -> list[LoadedTrace]:
        """Load complete traces, optionally filtered by root status, name, event type, source, or service.

        ``source`` matches the root trace ``metadata.source`` exactly after
        trimming the query value. It is intended for product-owned sources such
        as Playground without broadening the free-text root-name filter.

        ``service`` and ``environment`` match the ``metadata.service`` block the
        SDK records on trace roots from ``configure(service_name=, environment=)``,
        using the same case-insensitive substring matching as ``name``.

        ``min_duration_ms`` keeps only traces whose root duration
        (``end_time - start_time``) is at least that many milliseconds, so slow
        traces can be isolated; like the other filters it is applied before
        ordering and ``limit`` and combines with them using AND.

        ``sort`` chooses the ordering. ``"recent"`` (the default) sorts ascending
        by ``start_time`` then ``id``, so with ``limit`` the most recent N are the
        tail slice. ``"slowest"`` sorts by root-trace duration descending (ties
        fall back to recency then ``id``), so with ``limit`` the slowest N are the
        head slice.

        ``before_start_time`` with optional ``before_id`` pages backward through
        the default recent order. It is applied after filtering and before the
        limit, so ``limit`` keeps the most recent traces older than that cursor.
        ``limit`` keeps only that many traces after filtering, cursoring, and
        ordering, so the local experience stays usable as the store grows.
        """

        if limit is not None and limit > 0 and event_type is None:
            return self._load_bounded_traces(
                status=status,
                name=name,
                source=source,
                service=service,
                environment=environment,
                min_duration_ms=min_duration_ms,
                sort=sort,
                limit=limit,
                before_start_time=before_start_time,
                before_id=before_id,
            )

        traces = self._load_filtered_traces(
            status=status,
            name=name,
            event_type=event_type,
            source=source,
            service=service,
            environment=environment,
            min_duration_ms=min_duration_ms,
        )
        if sort == "slowest":
            # Slowest first by root-trace duration; ties fall back to recency then
            # id so the order stays deterministic. reverse=True flips every key, so
            # the slowest N are the head slice under ``limit``.
            ordered = sorted(
                traces,
                key=lambda trace: (trace.end_time - trace.start_time, trace.start_time, trace.id),
                reverse=True,
            )
            if limit is not None:
                return ordered[:limit]
            return ordered
        ordered = sorted(traces, key=lambda trace: (trace.start_time, trace.id))
        if before_start_time is not None:
            if before_id is not None:
                ordered = [trace for trace in ordered if (trace.start_time, trace.id) < (before_start_time, before_id)]
            else:
                ordered = [trace for trace in ordered if trace.start_time < before_start_time]
        # The newest traces sort last, so the most recent N are the tail slice.
        if limit is not None:
            return ordered[-limit:]
        return ordered

    def summarize_traces(
        self,
        *,
        status: EventStatus | None = None,
        name: str | None = None,
        event_type: EventType | None = None,
        source: str | None = None,
        service: str | None = None,
        environment: str | None = None,
        min_duration_ms: float | None = None,
    ) -> TraceSummaryPayload:
        """Summarize the complete filtered result set without browse limits."""

        return _summarize_events(
            self._iter_events(),
            status=status,
            name=name,
            event_type=event_type,
            source=source,
            service=service,
            environment=environment,
            min_duration_ms=min_duration_ms,
        )

    def _load_bounded_traces(
        self,
        *,
        status: EventStatus | None,
        name: str | None,
        source: str | None,
        service: str | None,
        environment: str | None,
        min_duration_ms: float | None,
        sort: TraceSort,
        limit: int,
        before_start_time: datetime | None,
        before_id: str | None,
    ) -> list[LoadedTrace]:
        """Select roots with a bounded heap, then retain events only for them.

        This optimization is used when every active filter can be decided from
        a root event. ``event_type`` browsing uses the general grouping path
        because events may be arbitrarily interleaved with their root.
        """

        name_filter = name.strip().lower() if name is not None else None
        source_filter = source.strip() if source is not None else None
        service_filter = service.strip().lower() if service is not None else None
        environment_filter = environment.strip().lower() if environment is not None else None

        if sort == "slowest":
            slowest: list[tuple[timedelta, datetime, str]] = []
            for event in self._iter_events():
                if not _is_matching_root_event(
                    event,
                    status=status,
                    name_filter=name_filter,
                    source_filter=source_filter,
                    service_filter=service_filter,
                    environment_filter=environment_filter,
                    min_duration_ms=min_duration_ms,
                ):
                    continue
                candidate = (event.end_time - event.start_time, event.start_time, event.id)
                if len(slowest) < limit:
                    heappush(slowest, candidate)
                elif candidate > slowest[0]:
                    heapreplace(slowest, candidate)
            selected_ids = [candidate[2] for candidate in sorted(slowest, reverse=True)]
        else:
            recent: list[tuple[datetime, str]] = []
            for event in self._iter_events():
                if not _is_matching_root_event(
                    event,
                    status=status,
                    name_filter=name_filter,
                    source_filter=source_filter,
                    service_filter=service_filter,
                    environment_filter=environment_filter,
                    min_duration_ms=min_duration_ms,
                ):
                    continue
                candidate = (event.start_time, event.id)
                if before_start_time is not None:
                    if before_id is not None:
                        if candidate >= (before_start_time, before_id):
                            continue
                    elif event.start_time >= before_start_time:
                        continue
                if len(recent) < limit:
                    heappush(recent, candidate)
                elif candidate > recent[0]:
                    heapreplace(recent, candidate)
            selected_ids = [candidate[1] for candidate in sorted(recent)]

        if not selected_ids:
            return []
        events_by_trace_id: dict[str, list[TraceEventPayload]] = {trace_id: [] for trace_id in selected_ids}
        for event in self._iter_events():
            trace_events = events_by_trace_id.get(event.trace_id)
            if trace_events is not None:
                trace_events.append(event)

        traces_by_id = {
            trace_id: trace
            for trace_id, events in events_by_trace_id.items()
            if (trace := _loaded_trace(trace_id, events)) is not None
        }
        return [traces_by_id[trace_id] for trace_id in selected_ids if trace_id in traces_by_id]

    def _load_filtered_traces(
        self,
        *,
        status: EventStatus | None,
        name: str | None,
        event_type: EventType | None,
        source: str | None,
        service: str | None,
        environment: str | None,
        min_duration_ms: float | None,
    ) -> list[LoadedTrace]:
        """Reconstruct and filter traces for both browse and aggregate queries."""

        events_by_trace_id: dict[str, list[TraceEventPayload]] = {}
        for event in self._iter_events():
            events_by_trace_id.setdefault(event.trace_id, []).append(event)

        name_filter = name.strip().lower() if name is not None else None
        source_filter = source.strip() if source is not None else None
        service_filter = service.strip().lower() if service is not None else None
        environment_filter = environment.strip().lower() if environment is not None else None
        traces: list[LoadedTrace] = []
        for trace_id, events in events_by_trace_id.items():
            trace = _loaded_trace(trace_id, events)
            if trace is not None and _matches_filters(
                trace,
                status=status,
                name_filter=name_filter,
                event_type=event_type,
                source_filter=source_filter,
                service_filter=service_filter,
                environment_filter=environment_filter,
                min_duration_ms=min_duration_ms,
            ):
                traces.append(trace)
        return traces

    def load_trace(self, trace_id: str) -> LoadedTrace | None:
        """Load one complete trace by ID."""

        events = [event for event in self._iter_events() if event.trace_id == trace_id]
        return _loaded_trace(trace_id, events)


class JsonlEventStore(TraceEventReader):
    """Persist and query validated trace events from a local JSONL file.

    The writable server owns this file, so it keeps one parsed-event cache and
    derives the duplicate-ID index from that same parse. Device/inode metadata
    is part of the signature so external atomic replacement, deletion, and
    recreation cannot leave either cache attached to the old file.
    """

    def __init__(self, path: str | Path) -> None:
        """Create a store backed by the given JSONL path."""

        self.path = Path(path)
        self._lock = Lock()
        self._cache_initialized = False
        self._event_ids: set[str] = set()
        self._cached_signature: tuple[int, int, int, int, int] | None = None
        self._cached_events: list[TraceEventPayload] = []

    def append(self, event: TraceEventPayload) -> bool:
        """Append an event unless its ID already exists."""

        with self._lock:
            self._refresh_cache()
            if event.id in self._event_ids:
                return False

            self.path.parent.mkdir(parents=True, exist_ok=True)
            # exclude_none=False is deliberate: a persisted line spells optional
            # fields (value/model/usage/cost/currency) as explicit JSON nulls. That
            # explicit-null form is Bir's canonical persisted shape (the SDK instead
            # omits keys it did not set); both forms load on either reader. Do not
            # switch to exclude_none=True. See docs/IMPLEMENTATION_ROADMAP.md Stage 2.
            payload = event.model_dump(mode="json", exclude_none=False)
            with self.path.open("a", encoding="utf-8") as events_file:
                events_file.write(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False))
                events_file.write("\n")
            self._event_ids.add(event.id)
            self._cached_events.append(event)
            self._cached_signature = self._current_signature()
            return True

    def has_event(self, event_id: str) -> bool:
        """Return whether the store already contains an event ID."""

        with self._lock:
            self._refresh_cache()
            return event_id in self._event_ids

    def _iter_events(self) -> Iterator[TraceEventPayload]:
        """Yield cached writable events without making a second event-list copy."""

        with self._lock:
            self._refresh_cache()
            yield from self._cached_events

    def _current_signature(self) -> tuple[int, int, int, int, int]:
        stat_result = self.path.stat()
        return (
            stat_result.st_dev,
            stat_result.st_ino,
            stat_result.st_mtime_ns,
            stat_result.st_ctime_ns,
            stat_result.st_size,
        )

    def _refresh_cache(self) -> None:
        try:
            signature = self._current_signature()
        except FileNotFoundError:
            self._cache_initialized = True
            self._cached_signature = None
            self._cached_events = []
            self._event_ids = set()
            return

        if self._cache_initialized and signature == self._cached_signature:
            return

        # Recheck after parsing. An append or atomic replacement that races the
        # read must not associate events from one snapshot with another file's
        # signature; retrying also makes the latest stable snapshot visible now.
        events: list[TraceEventPayload] = []
        for _ in range(3):
            events = self._read_events()
            try:
                refreshed_signature = self._current_signature()
            except FileNotFoundError:
                self._cache_initialized = True
                self._cached_signature = None
                self._cached_events = []
                self._event_ids = set()
                return
            if refreshed_signature == signature:
                self._cache_initialized = True
                self._cached_signature = refreshed_signature
                self._cached_events = events
                self._event_ids = {event.id for event in events}
                return
            signature = refreshed_signature

        # A continuously changing external writer is outside the writable
        # store's ownership contract. Keep the last complete parse useful, but
        # force another refresh instead of claiming it matches a stable file.
        self._cache_initialized = True
        self._cached_signature = None
        self._cached_events = events
        self._event_ids = {event.id for event in events}

    def _read_events(self) -> list[TraceEventPayload]:
        return list(_iter_event_file(self.path, tolerate_torn_tail=False))


class LocalJsonlEventReader(TraceEventReader):
    """Read-only view over a trace JSONL file owned by another writer (the SDK).

    Parsed events are deliberately not cached: SDK stores can be large, and a
    process-lifetime Pydantic-object mirror made even bounded browse responses
    retain the complete store. Each operation opens the current path, so SDK
    appends, prune's atomic replacement, deletion, and recreation are visible
    without stale-signature edge cases. A torn final line surfaces once a later
    operation observes the completed write.
    """

    def __init__(self, path: str | Path) -> None:
        """Create a reader over the given JSONL path."""

        self.path = Path(path)
        self._lock = Lock()

    def _iter_events(self) -> Iterator[TraceEventPayload]:
        """Yield complete SDK events lazily from the file currently at the path."""

        with self._lock:
            try:
                yield from _iter_event_file(self.path, tolerate_torn_tail=True)
            except FileNotFoundError:
                return


def _iter_event_file(path: Path, *, tolerate_torn_tail: bool) -> Iterator[TraceEventPayload]:
    """Yield validated events from one store with the requested tail policy."""

    if tolerate_torn_tail:
        lines = iter_jsonl_lines_tolerating_torn_tail(path)
    else:
        lines = _iter_strict_jsonl_lines(path)
    for line_number, stripped in lines:
        yield _parse_event_line(path, line_number, stripped)


def _iter_strict_jsonl_lines(path: Path) -> Iterator[tuple[int, str]]:
    """Yield nonblank text lines, including an invalid unterminated tail."""

    with path.open("r", encoding="utf-8") as events_file:
        for line_number, line in enumerate(events_file, start=1):
            stripped = line.strip()
            if stripped:
                yield line_number, stripped


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


def _is_matching_root_event(
    event: TraceEventPayload,
    *,
    status: EventStatus | None,
    name_filter: str | None,
    source_filter: str | None,
    service_filter: str | None,
    environment_filter: str | None,
    min_duration_ms: float | None,
) -> bool:
    if event.type != "trace" or event.id != event.trace_id:
        return False
    return _root_matches_filters(
        _root_summary(event),
        status=status,
        name_filter=name_filter,
        event_type=None,
        event_type_bits=EVENT_TYPE_BITS["trace"],
        source_filter=source_filter,
        service_filter=service_filter,
        environment_filter=environment_filter,
        min_duration_ms=min_duration_ms,
    )


def _root_summary(event: TraceEventPayload) -> _TraceRootSummary:
    source = event.metadata.get("source")
    service = event.metadata.get("service")
    service_name: str | None = None
    service_environment: str | None = None
    if isinstance(service, dict):
        raw_name = service.get("name")
        raw_environment = service.get("environment")
        service_name = raw_name if isinstance(raw_name, str) else None
        service_environment = raw_environment if isinstance(raw_environment, str) else None
    return _TraceRootSummary(
        id=event.id,
        name=event.name,
        start_time=event.start_time,
        end_time=event.end_time,
        status=event.status,
        source=source if isinstance(source, str) else None,
        service=service_name,
        environment=service_environment,
        event_sort_key=_event_sort_key(event),
    )


def _root_matches_filters(
    root: _TraceRootSummary,
    *,
    status: EventStatus | None,
    name_filter: str | None,
    event_type: EventType | None,
    event_type_bits: int,
    source_filter: str | None,
    service_filter: str | None,
    environment_filter: str | None,
    min_duration_ms: float | None,
) -> bool:
    if status is not None and root.status != status:
        return False
    if name_filter and name_filter not in root.name.lower():
        return False
    if event_type is not None and not event_type_bits & EVENT_TYPE_BITS[event_type]:
        return False
    if source_filter and root.source != source_filter:
        return False
    if service_filter and (root.service is None or service_filter not in root.service.lower()):
        return False
    if environment_filter and (root.environment is None or environment_filter not in root.environment.lower()):
        return False
    if min_duration_ms is not None:
        duration_ms = (root.end_time - root.start_time).total_seconds() * 1000
        if duration_ms < min_duration_ms:
            return False
    return True


def _matches_filters(
    trace: LoadedTrace,
    *,
    status: EventStatus | None,
    name_filter: str | None,
    event_type: EventType | None,
    source_filter: str | None,
    service_filter: str | None,
    environment_filter: str | None,
    min_duration_ms: float | None,
) -> bool:
    if status is not None and trace.status != status:
        return False
    if name_filter and name_filter not in trace.name.lower():
        return False
    if event_type is not None and not any(event.type == event_type for event in trace.events):
        return False
    if source_filter:
        source = _trace_source(trace)
        if source != source_filter:
            return False
    if service_filter or environment_filter:
        service_name, service_environment = _trace_service(trace)
        if service_filter and (service_name is None or service_filter not in service_name.lower()):
            return False
        if environment_filter and (
            service_environment is None or environment_filter not in service_environment.lower()
        ):
            return False
    if min_duration_ms is not None:
        duration_ms = (trace.end_time - trace.start_time).total_seconds() * 1000
        if duration_ms < min_duration_ms:
            return False
    return True


def _trace_source(trace: LoadedTrace) -> str | None:
    root = next((event for event in trace.events if event.type == "trace" and event.id == trace.id), None)
    if root is None:
        return None
    source = root.metadata.get("source")
    return source if isinstance(source, str) else None


def _trace_service(trace: LoadedTrace) -> tuple[str | None, str | None]:
    root = next((event for event in trace.events if event.type == "trace" and event.id == trace.id), None)
    if root is None:
        return (None, None)
    service = root.metadata.get("service")
    if not isinstance(service, dict):
        return (None, None)
    name = service.get("name")
    environment = service.get("environment")
    return (
        name if isinstance(name, str) else None,
        environment if isinstance(environment, str) else None,
    )


def _summarize_events(
    events: Iterator[TraceEventPayload],
    *,
    status: EventStatus | None,
    name: str | None,
    event_type: EventType | None,
    source: str | None,
    service: str | None,
    environment: str | None,
    min_duration_ms: float | None,
) -> TraceSummaryPayload:
    """Summarize one event stream without constructing complete trace models."""

    states: dict[str, _TraceSummaryState] = {}
    for event in events:
        state = states.get(event.trace_id)
        if state is None:
            state = _TraceSummaryState()
            states[event.trace_id] = state
        state.event_count += 1
        state.event_type_bits |= EVENT_TYPE_BITS[event.type]
        if event.type == "trace" and event.id == event.trace_id:
            root = _root_summary(event)
            if state.root is None or root.event_sort_key < state.root.event_sort_key:
                state.root = root
        if event.type != "generation":
            continue

        state.generation_count += 1
        tokens = _generation_tokens(event)
        input_tokens = _usage_value(event, "input_tokens")
        output_tokens = _usage_value(event, "output_tokens")
        cost = _generation_cost(event)
        state.total_tokens += tokens
        state.total_cost += cost
        if event.cost is not None and "total_cost" in event.cost and event.currency:
            if state.currencies is None:
                state.currencies = set()
            state.currencies.add(event.currency)
        if state.models is None:
            state.models = {}
        if state.providers is None:
            state.providers = {}
        _add_breakdown(state.models, event.model or "unknown", tokens, input_tokens, output_tokens, cost)
        _add_breakdown(state.providers, _generation_provider(event), tokens, input_tokens, output_tokens, cost)
        integration = _generation_integration(event)
        if integration is not None:
            if state.integrations is None:
                state.integrations = {}
            _add_breakdown(state.integrations, integration, tokens, input_tokens, output_tokens, cost)

    name_filter = name.strip().lower() if name is not None else None
    source_filter = source.strip() if source is not None else None
    service_filter = service.strip().lower() if service is not None else None
    environment_filter = environment.strip().lower() if environment is not None else None
    trace_count = 0
    event_count = 0
    generation_count = 0
    error_count = 0
    total_tokens: int | float = 0
    total_cost: int | float = 0
    currencies: set[str] = set()
    durations_ms: list[float] = []
    models: dict[str, _BreakdownTotals] = {}
    providers: dict[str, _BreakdownTotals] = {}
    integrations: dict[str, _BreakdownTotals] = {}

    for state in states.values():
        root = state.root
        if root is None or not _root_matches_filters(
            root,
            status=status,
            name_filter=name_filter,
            event_type=event_type,
            event_type_bits=state.event_type_bits,
            source_filter=source_filter,
            service_filter=service_filter,
            environment_filter=environment_filter,
            min_duration_ms=min_duration_ms,
        ):
            continue
        trace_count += 1
        event_count += state.event_count
        generation_count += state.generation_count
        error_count += root.status == "error"
        total_tokens += state.total_tokens
        total_cost += state.total_cost
        if state.currencies is not None:
            currencies.update(state.currencies)
        durations_ms.append((root.end_time - root.start_time).total_seconds() * 1000)
        if state.models is not None:
            _merge_breakdowns(models, state.models)
        if state.providers is not None:
            _merge_breakdowns(providers, state.providers)
        if state.integrations is not None:
            _merge_breakdowns(integrations, state.integrations)

    durations_ms.sort()
    model_payloads = [
        TraceModelSummaryPayload(model=key, **values)
        for key, values in sorted(models.items(), key=lambda item: (-item[1]["generation_count"], item[0]))
    ]
    provider_payloads = [
        TraceProviderSummaryPayload(provider=key, **values)
        for key, values in sorted(providers.items(), key=lambda item: (-item[1]["generation_count"], item[0]))
    ]
    integration_payloads = [
        TraceIntegrationSummaryPayload(integration=key, **values)
        for key, values in sorted(integrations.items(), key=lambda item: (-item[1]["generation_count"], item[0]))
    ]
    return TraceSummaryPayload(
        trace_count=trace_count,
        event_count=event_count,
        generation_count=generation_count,
        error_count=error_count,
        total_tokens=total_tokens,
        total_cost=total_cost,
        currency=next(iter(currencies)) if len(currencies) == 1 else None,
        p50_latency_ms=_percentile(durations_ms, 50),
        p95_latency_ms=_percentile(durations_ms, 95),
        models=model_payloads,
        providers=provider_payloads,
        integrations=integration_payloads,
    )


def _merge_breakdowns(target: dict[str, _BreakdownTotals], source: dict[str, _BreakdownTotals]) -> None:
    for key, values in source.items():
        bucket = target.setdefault(
            key,
            {
                "generation_count": 0,
                "total_tokens": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "total_cost": 0,
            },
        )
        bucket["generation_count"] += values["generation_count"]
        bucket["total_tokens"] += values["total_tokens"]
        bucket["input_tokens"] += values["input_tokens"]
        bucket["output_tokens"] += values["output_tokens"]
        bucket["total_cost"] += values["total_cost"]


def _usage_value(event: TraceEventPayload, key: str) -> int | float:
    if event.usage is None:
        return 0
    return event.usage.get(key, 0)


def _generation_tokens(event: TraceEventPayload) -> int | float:
    if event.usage is None:
        return 0
    if "total_tokens" in event.usage:
        return event.usage["total_tokens"]
    return _usage_value(event, "input_tokens") + _usage_value(event, "output_tokens")


def _generation_cost(event: TraceEventPayload) -> int | float:
    if event.cost is None:
        return 0
    return event.cost.get("total_cost", 0)


def _generation_provider(event: TraceEventPayload) -> str:
    provider = event.metadata.get("provider")
    if isinstance(provider, str) and provider:
        return provider
    if _generation_integration(event) is not None:
        return "unknown"
    prefix, separator, _ = event.name.partition(".")
    return prefix if separator and prefix else "unknown"


def _generation_integration(event: TraceEventPayload) -> str | None:
    integration = event.metadata.get("integration")
    if isinstance(integration, str) and integration:
        return integration
    return None


def _add_breakdown(
    buckets: dict[str, _BreakdownTotals],
    key: str,
    tokens: int | float,
    input_tokens: int | float,
    output_tokens: int | float,
    cost: int | float,
) -> None:
    bucket = buckets.setdefault(
        key,
        {
            "generation_count": 0,
            "total_tokens": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_cost": 0,
        },
    )
    bucket["generation_count"] += 1
    bucket["total_tokens"] += tokens
    bucket["input_tokens"] += input_tokens
    bucket["output_tokens"] += output_tokens
    bucket["total_cost"] += cost


def _percentile(sorted_values: list[float], percentile_rank: int) -> float:
    if not sorted_values:
        return 0
    rank = -(-percentile_rank * len(sorted_values) // 100)
    return sorted_values[min(len(sorted_values) - 1, max(0, rank - 1))]


def _event_sort_key(event: TraceEventPayload) -> tuple[str, int, str, str]:
    start_time = event.start_time.isoformat()
    end_time = event.end_time.isoformat()
    return (start_time, EVENT_SORT_PRIORITY.get(event.type, 99), end_time, event.id)
