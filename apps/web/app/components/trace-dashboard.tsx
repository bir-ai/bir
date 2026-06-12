"use client";

import { getTraceScores, type Trace, type TraceFilterValues, type TraceTimelineRow } from "../trace-contract";
import { formatDate, formatDuration, formatNumber } from "./format";
import { statusLabels } from "./labels";
import { Fact, InlineField, Metric } from "./primitives";
import { TraceList } from "./trace-list";
import { TraceTimeline } from "./trace-timeline";

export function TraceDashboard({
  apiBaseUrl,
  error,
  filters,
  hasActiveFilters,
  isLoading,
  selectedTrace,
  setSelectedTraceId,
  setTraceFilters,
  stats,
  timelineRows,
  traces,
}: {
  apiBaseUrl: string;
  error: string | null;
  filters: TraceFilterValues;
  hasActiveFilters: boolean;
  isLoading: boolean;
  selectedTrace: Trace | null;
  setSelectedTraceId: (traceId: string) => void;
  setTraceFilters: (filters: TraceFilterValues) => void;
  stats: { eventCount: number; errorCount: number; generationCount: number };
  timelineRows: TraceTimelineRow[];
  traces: Trace[];
}) {
  const traceScores = selectedTrace ? getTraceScores(selectedTrace.events) : [];

  return (
    <>
      <section className="metric-strip" aria-label="Trace summary">
        <Metric label="Traces" value={traces.length.toString()} />
        <Metric label="Events" value={stats.eventCount.toString()} />
        <Metric label="Generations" value={stats.generationCount.toString()} />
        <Metric label="Errors" value={stats.errorCount.toString()} tone={stats.errorCount > 0 ? "bad" : "good"} />
      </section>

      <section className="workspace">
        <TraceList
          apiBaseUrl={apiBaseUrl}
          error={error}
          filters={filters}
          hasActiveFilters={hasActiveFilters}
          isLoading={isLoading}
          selectedTraceId={selectedTrace?.id ?? null}
          setSelectedTraceId={setSelectedTraceId}
          setTraceFilters={setTraceFilters}
          traces={traces}
        />

        <section className="detail-panel" aria-label="Trace details">
          {selectedTrace ? (
            <>
              <div className="detail-head">
                <div>
                  <p className="eyebrow">Trace Detail</p>
                  <h2>{selectedTrace.name}</h2>
                  <p className="subtle">{selectedTrace.id}</p>
                </div>
                <div className="detail-facts">
                  <Fact label="Status" value={statusLabels[selectedTrace.status]} tone={selectedTrace.status} />
                  <Fact label="Duration" value={formatDuration(selectedTrace.start_time, selectedTrace.end_time)} />
                  <Fact label="Started" value={formatDate(selectedTrace.start_time)} />
                </div>
              </div>

              {traceScores.length > 0 ? (
                <section className="score-grid trace-score-strip" aria-label="Trace scores">
                  {traceScores.map((score) => (
                    <InlineField label={score.name} value={formatNumber(score.value)} key={score.name} />
                  ))}
                </section>
              ) : null}

              <TraceTimeline rows={timelineRows} />
            </>
          ) : (
            <div className="empty-detail">No trace selected.</div>
          )}
        </section>
      </section>
    </>
  );
}
