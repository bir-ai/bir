"use client";

import {
  buildTraceFilterQuery,
  type Trace,
  type TraceFilterValues,
} from "../trace-contract";
import { formatDuration } from "./format";
import { DEFAULT_TRACE_FILTERS, statusLabels, typeLabels } from "./labels";
import { PanelHead, TraceSkeleton } from "./primitives";

export function TraceList({
  apiBaseUrl,
  error,
  filters,
  hasActiveFilters,
  isLoading,
  selectedTraceId,
  setSelectedTraceId,
  setTraceFilters,
  traces,
}: {
  apiBaseUrl: string;
  error: string | null;
  filters: TraceFilterValues;
  hasActiveFilters: boolean;
  isLoading: boolean;
  selectedTraceId: string | null;
  setSelectedTraceId: (traceId: string) => void;
  setTraceFilters: (filters: TraceFilterValues) => void;
  traces: Trace[];
}) {
  return (
    <aside className="trace-list" aria-label="Traces">
      <PanelHead title="Traces" subtitle={apiBaseUrl} />
      <TraceFilterControls filters={filters} setTraceFilters={setTraceFilters} />
      {error ? <div className="state-box error-state">{error}</div> : null}
      {!error && !isLoading && traces.length === 0 ? (
        <div className="state-box">{hasActiveFilters ? "No traces match these filters." : "No traces found."}</div>
      ) : null}
      {isLoading && traces.length === 0 ? <TraceSkeleton /> : null}

      <div className="trace-items">
        {traces.map((trace) => (
          <button
            className={trace.id === selectedTraceId ? "trace-row active" : "trace-row"}
            key={trace.id}
            type="button"
            onClick={() => setSelectedTraceId(trace.id)}
          >
            <span className={`status-dot ${trace.status}`} aria-hidden="true" />
            <span className="trace-row-main">
              <span className="trace-name">{trace.name}</span>
              <span className="trace-meta">
                {trace.events.length} events · {formatDuration(trace.start_time, trace.end_time)}
              </span>
            </span>
            <span className={`status-pill ${trace.status}`}>{statusLabels[trace.status]}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function TraceFilterControls({
  filters,
  setTraceFilters,
}: {
  filters: TraceFilterValues;
  setTraceFilters: (filters: TraceFilterValues) => void;
}) {
  const status = filters.status ?? "all";
  const eventType = filters.event_type ?? "all";
  const name = filters.name ?? "";
  const hasActiveFilters = buildTraceFilterQuery(filters).length > 0;

  return (
    <div className="trace-filters" aria-label="Trace filters">
      <div className="filter-group">
        <span>Status</span>
        <div className="filter-segments" role="group" aria-label="Trace status">
          {(["all", "success", "error"] as const).map((nextStatus) => (
            <button
              aria-pressed={status === nextStatus}
              className={status === nextStatus ? "active" : ""}
              key={nextStatus}
              type="button"
              onClick={() => setTraceFilters({ ...filters, status: nextStatus })}
            >
              {nextStatus === "all" ? "All" : statusLabels[nextStatus]}
            </button>
          ))}
        </div>
      </div>

      <label className="filter-group">
        <span>Name</span>
        <input
          type="search"
          value={name}
          onChange={(event) => setTraceFilters({ ...filters, name: event.target.value })}
        />
      </label>

      <label className="filter-group">
        <span>Event Type</span>
        <select
          value={eventType}
          onChange={(event) => setTraceFilters({ ...filters, event_type: event.target.value })}
        >
          <option value="all">All event types</option>
          {Object.entries(typeLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {hasActiveFilters ? (
        <button className="filter-clear" type="button" onClick={() => setTraceFilters(DEFAULT_TRACE_FILTERS)}>
          Clear
        </button>
      ) : null}
    </div>
  );
}
