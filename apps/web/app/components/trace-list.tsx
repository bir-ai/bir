"use client";

import {
  buildTraceFilterQuery,
  getTraceService,
  type Trace,
  type TraceFilterValues,
  type TraceService,
} from "../trace-contract";
import type { TraceFilterCommitMode } from "../trace-filter-commit";
import { formatDuration } from "./format";
import { DEFAULT_TRACE_FILTERS, statusLabels, typeLabels } from "./labels";
import { PanelHead, TraceSkeleton } from "./primitives";

export function TraceList({
  apiBaseUrl,
  error,
  filters,
  hasMoreTraces,
  hasActiveFilters,
  isLoading,
  isLoadingOlder,
  onLoadOlderTraces,
  selectedTraceId,
  setSelectedTraceId,
  setTraceFilters,
  traceLimit,
  traces,
}: {
  apiBaseUrl: string;
  error: string | null;
  filters: TraceFilterValues;
  hasMoreTraces: boolean;
  hasActiveFilters: boolean;
  isLoading: boolean;
  isLoadingOlder: boolean;
  onLoadOlderTraces: () => void;
  selectedTraceId: string | null;
  setSelectedTraceId: (traceId: string) => void;
  setTraceFilters: (filters: TraceFilterValues, mode?: TraceFilterCommitMode) => void;
  traceLimit: number;
  traces: Trace[];
}) {
  const canLoadOlder = (filters.sort ?? "recent") === "recent";

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
        {traces.map((trace) => {
          const service = getTraceService(trace);
          return (
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
                  {service ? ` · ${formatTraceService(service)}` : ""}
                </span>
              </span>
              <span className={`status-pill ${trace.status}`}>{statusLabels[trace.status]}</span>
            </button>
          );
        })}
      </div>

      {traces.length > 0 && canLoadOlder ? (
        <div className="trace-pagination">
          {hasMoreTraces ? (
            <button
              className="trace-load-more"
              type="button"
              onClick={onLoadOlderTraces}
              disabled={isLoading || isLoadingOlder}
            >
              {isLoadingOlder ? "Loading older" : "Load older"}
            </button>
          ) : (
            <p className="trace-limit-hint">End of matching trace history.</p>
          )}
        </div>
      ) : null}

      {traces.length >= traceLimit && !canLoadOlder ? (
        <p className="trace-limit-hint">Load older is available in Recent order.</p>
      ) : null}
    </aside>
  );
}

function TraceFilterControls({
  filters,
  setTraceFilters,
}: {
  filters: TraceFilterValues;
  setTraceFilters: (filters: TraceFilterValues, mode?: TraceFilterCommitMode) => void;
}) {
  const status = filters.status ?? "all";
  const eventType = filters.event_type ?? "all";
  const name = filters.name ?? "";
  const source = filters.source ?? "";
  const service = filters.service ?? "";
  const environment = filters.environment ?? "";
  const minDuration = filters.min_duration_ms ?? "";
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
          onChange={(event) => setTraceFilters({ ...filters, name: event.target.value }, "debounced")}
        />
      </label>

      <label className="filter-group">
        <span>Service</span>
        <input
          type="search"
          value={service}
          onChange={(event) => setTraceFilters({ ...filters, service: event.target.value }, "debounced")}
        />
      </label>

      <label className="filter-group">
        <span>Source</span>
        <input
          type="search"
          value={source}
          onChange={(event) => setTraceFilters({ ...filters, source: event.target.value }, "debounced")}
        />
      </label>

      <label className="filter-group">
        <span>Environment</span>
        <input
          type="search"
          value={environment}
          onChange={(event) => setTraceFilters({ ...filters, environment: event.target.value }, "debounced")}
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

      <label className="filter-group">
        <span>Min Duration (ms)</span>
        <input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          placeholder="Any"
          value={minDuration}
          onChange={(event) =>
            setTraceFilters({ ...filters, min_duration_ms: parseMinDuration(event.target.value) })
          }
        />
      </label>

      {hasActiveFilters ? (
        <button className="filter-clear" type="button" onClick={() => setTraceFilters(DEFAULT_TRACE_FILTERS)}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

// Keep only a positive, finite threshold in the shared filter state; an empty or
// invalid entry clears the filter (undefined) so buildTraceFilterQuery omits it
// and the server is never asked for a non-positive min_duration_ms.
function parseMinDuration(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatTraceService(service: TraceService): string {
  if (service.name && service.environment) {
    return `${service.name} (${service.environment})`;
  }
  return service.name ?? service.environment ?? "";
}
