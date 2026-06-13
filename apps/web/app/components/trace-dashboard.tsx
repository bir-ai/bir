"use client";

import {
  getTraceScores,
  getTraceService,
  getTraceTotals,
  type Trace,
  type TraceFilterValues,
  type TraceModelSummary,
  type TraceSummary,
  type TraceTimelineRow,
} from "../trace-contract";
import { formatDate, formatDuration, formatMilliseconds, formatNumber } from "./format";
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
  traceLimit,
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
  stats: TraceSummary;
  timelineRows: TraceTimelineRow[];
  traceLimit: number;
  traces: Trace[];
}) {
  const traceScores = selectedTrace ? getTraceScores(selectedTrace.events) : [];
  const traceService = selectedTrace ? getTraceService(selectedTrace) : null;
  const traceTotals = selectedTrace ? getTraceTotals(selectedTrace.events) : null;
  const traceCostLabel = traceTotals
    ? traceTotals.currency
      ? `${formatNumber(traceTotals.totalCost)} ${traceTotals.currency}`
      : formatNumber(traceTotals.totalCost)
    : "";
  const totalCostLabel = stats.currency
    ? `${formatNumber(stats.totalCost)} ${stats.currency}`
    : formatNumber(stats.totalCost);

  return (
    <>
      <section className="metric-strip" aria-label="Trace summary">
        <Metric label="Traces" value={stats.traceCount.toString()} />
        <Metric label="Events" value={stats.eventCount.toString()} />
        <Metric label="Generations" value={stats.generationCount.toString()} />
        <Metric label="Errors" value={stats.errorCount.toString()} tone={stats.errorCount > 0 ? "bad" : "good"} />
        <Metric label="Total tokens" value={formatNumber(stats.totalTokens)} />
        <Metric label="Total cost" value={totalCostLabel} />
        <Metric label="p50 latency" value={formatMilliseconds(stats.p50LatencyMs)} />
        <Metric label="p95 latency" value={formatMilliseconds(stats.p95LatencyMs)} />
      </section>

      {stats.models.length > 0 ? <ModelBreakdown models={stats.models} currency={stats.currency} /> : null}

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
          traceLimit={traceLimit}
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
                  {traceService?.name ? <Fact label="Service" value={traceService.name} /> : null}
                  {traceService?.environment ? <Fact label="Environment" value={traceService.environment} /> : null}
                  {traceTotals && traceTotals.totalTokens > 0 ? (
                    <Fact label="Tokens" value={formatNumber(traceTotals.totalTokens)} />
                  ) : null}
                  {traceTotals && traceTotals.totalCost > 0 ? <Fact label="Cost" value={traceCostLabel} /> : null}
                </div>
              </div>

              {traceScores.length > 0 ? (
                <section className="score-grid trace-score-strip" aria-label="Trace scores">
                  {traceScores.map((score) => (
                    <InlineField
                      label={score.name}
                      value={formatNumber(score.value)}
                      title={score.metadata ? JSON.stringify(score.metadata) : undefined}
                      key={score.name}
                    />
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

function ModelBreakdown({ models, currency }: { models: TraceModelSummary[]; currency: string | null }) {
  return (
    <section className="model-breakdown" aria-label="Model breakdown">
      <h3>Model breakdown</h3>
      <table className="model-table">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Generations</th>
            <th scope="col">Tokens</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.model}>
              <td>{model.model}</td>
              <td>{formatNumber(model.generationCount)}</td>
              <td>{formatNumber(model.totalTokens)}</td>
              <td>{currency ? `${formatNumber(model.totalCost)} ${currency}` : formatNumber(model.totalCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
