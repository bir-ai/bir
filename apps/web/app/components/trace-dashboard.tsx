"use client";

import {
  getTraceScoreGroups,
  getTraceService,
  getTraceTotals,
  isErrorsOnlyFilter,
  toggleErrorsOnlyFilter,
  type Trace,
  type TraceFilterValues,
  type TraceIntegrationSummary,
  type TraceModelSummary,
  type TraceProviderSummary,
  type TraceSort,
  type TraceSummary,
  type TraceTimelineRow,
} from "../trace-contract";
import type { TraceFilterCommitMode } from "../trace-filter-commit";
import { formatDate, formatDuration, formatMilliseconds, formatNumber } from "./format";
import { sortLabels, statusLabels } from "./labels";
import { Fact, Metric } from "./primitives";
import { TraceScorePanel } from "./trace-detail-panels";
import { TraceList } from "./trace-list";
import { TraceTimeline } from "./trace-timeline";

export function TraceDashboard({
  apiBaseUrl,
  error,
  filters,
  hasMoreTraces,
  hasActiveFilters,
  isLoading,
  isLoadingOlder,
  onLoadOlderTraces,
  selectedTrace,
  setSelectedTraceId,
  setTraceFilters,
  stats,
  traceDetailError,
  timelineRows,
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
  selectedTrace: Trace | null;
  setSelectedTraceId: (traceId: string) => void;
  setTraceFilters: (filters: TraceFilterValues, mode?: TraceFilterCommitMode) => void;
  stats: TraceSummary;
  traceDetailError: string | null;
  timelineRows: TraceTimelineRow[];
  traceLimit: number;
  traces: Trace[];
}) {
  const traceScoreGroups = selectedTrace ? getTraceScoreGroups(selectedTrace.events) : [];
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
  const errorsOnly = isErrorsOnlyFilter(filters);

  return (
    <>
      <p className="metric-scope">Metric scope: all matching traces</p>
      <section className="metric-strip" aria-label="Trace summary">
        <Metric label="Traces" value={stats.traceCount.toString()} />
        <Metric label="Events" value={stats.eventCount.toString()} />
        <Metric label="Generations" value={stats.generationCount.toString()} />
        <Metric
          label="Errors"
          value={stats.errorCount.toString()}
          tone={stats.errorCount > 0 ? "bad" : "good"}
          active={errorsOnly}
          title={errorsOnly ? "Showing errors only — click to clear" : "Show errors only"}
          onClick={() => setTraceFilters(toggleErrorsOnlyFilter(filters))}
        />
        <Metric label="Total tokens" value={formatNumber(stats.totalTokens)} />
        <Metric label="Total cost" value={totalCostLabel} />
        <Metric label="p50 latency" value={formatMilliseconds(stats.p50LatencyMs)} />
        <Metric label="p95 latency" value={formatMilliseconds(stats.p95LatencyMs)} />
      </section>

      <TraceTriageBar errorsOnly={errorsOnly} filters={filters} setTraceFilters={setTraceFilters} />

      {stats.models.length > 0 ? <ModelBreakdown models={stats.models} currency={stats.currency} /> : null}

      {stats.providers.length > 0 ? <ProviderBreakdown providers={stats.providers} currency={stats.currency} /> : null}

      {stats.integrations.length > 0 ? (
        <IntegrationBreakdown integrations={stats.integrations} currency={stats.currency} />
      ) : null}

      <section className="workspace">
        <TraceList
          apiBaseUrl={apiBaseUrl}
          error={error}
          filters={filters}
          hasMoreTraces={hasMoreTraces}
          hasActiveFilters={hasActiveFilters}
          isLoading={isLoading}
          isLoadingOlder={isLoadingOlder}
          onLoadOlderTraces={onLoadOlderTraces}
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

              {traceScoreGroups.length > 0 ? <TraceScorePanel groups={traceScoreGroups} /> : null}

              {traceDetailError ? <div className="error-block">{traceDetailError}</div> : null}

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

// Prominent, one-click triage row: an "Errors only" status shortcut plus the
// Recent/Slowest sort toggle, both bound to the shared trace filter state.
function TraceTriageBar({
  errorsOnly,
  filters,
  setTraceFilters,
}: {
  errorsOnly: boolean;
  filters: TraceFilterValues;
  setTraceFilters: (filters: TraceFilterValues, mode?: TraceFilterCommitMode) => void;
}) {
  const sort = filters.sort ?? "recent";

  return (
    <section className="trace-triage" aria-label="Trace triage">
      <div className="filter-group">
        <span>Triage</span>
        <button
          aria-pressed={errorsOnly}
          className={errorsOnly ? "triage-toggle active" : "triage-toggle"}
          type="button"
          onClick={() => setTraceFilters(toggleErrorsOnlyFilter(filters))}
        >
          Errors only
        </button>
      </div>

      <div className="filter-group">
        <span>Order</span>
        <div className="filter-segments" role="group" aria-label="Trace order">
          {(["recent", "slowest"] as const satisfies readonly TraceSort[]).map((nextSort) => (
            <button
              aria-pressed={sort === nextSort}
              className={sort === nextSort ? "active" : ""}
              key={nextSort}
              type="button"
              onClick={() => setTraceFilters({ ...filters, sort: nextSort })}
            >
              {sortLabels[nextSort]}
            </button>
          ))}
        </div>
      </div>
    </section>
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
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            // Models whose generations report only total_tokens have no known
            // split; show a dash rather than a misleading zero in that case.
            const hasTokenSplit = model.inputTokens + model.outputTokens > 0;
            return (
              <tr key={model.model}>
                <td>{model.model}</td>
                <td>{formatNumber(model.generationCount)}</td>
                <td>{formatNumber(model.totalTokens)}</td>
                <td>{hasTokenSplit ? formatNumber(model.inputTokens) : "-"}</td>
                <td>{hasTokenSplit ? formatNumber(model.outputTokens) : "-"}</td>
                <td>{currency ? `${formatNumber(model.totalCost)} ${currency}` : formatNumber(model.totalCost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// Same shape as ModelBreakdown, bucketed by provider instead of model; it reuses
// the model-breakdown/model-table styles so the two summaries read identically.
function ProviderBreakdown({
  providers,
  currency,
}: {
  providers: TraceProviderSummary[];
  currency: string | null;
}) {
  return (
    <section className="model-breakdown" aria-label="Provider breakdown">
      <h3>Provider breakdown</h3>
      <table className="model-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Generations</th>
            <th scope="col">Tokens</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => {
            // Providers whose generations report only total_tokens have no known
            // split; show a dash rather than a misleading zero in that case.
            const hasTokenSplit = provider.inputTokens + provider.outputTokens > 0;
            return (
              <tr key={provider.provider}>
                <td>{provider.provider}</td>
                <td>{formatNumber(provider.generationCount)}</td>
                <td>{formatNumber(provider.totalTokens)}</td>
                <td>{hasTokenSplit ? formatNumber(provider.inputTokens) : "-"}</td>
                <td>{hasTokenSplit ? formatNumber(provider.outputTokens) : "-"}</td>
                <td>
                  {currency
                    ? `${formatNumber(provider.totalCost)} ${currency}`
                    : formatNumber(provider.totalCost)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function IntegrationBreakdown({
  integrations,
  currency,
}: {
  integrations: TraceIntegrationSummary[];
  currency: string | null;
}) {
  return (
    <section className="model-breakdown" aria-label="Integration breakdown">
      <h3>Integration breakdown</h3>
      <table className="model-table">
        <thead>
          <tr>
            <th scope="col">Integration</th>
            <th scope="col">Generations</th>
            <th scope="col">Tokens</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {integrations.map((integration) => {
            const hasTokenSplit = integration.inputTokens + integration.outputTokens > 0;
            return (
              <tr key={integration.integration}>
                <td>{integration.integration}</td>
                <td>{formatNumber(integration.generationCount)}</td>
                <td>{formatNumber(integration.totalTokens)}</td>
                <td>{hasTokenSplit ? formatNumber(integration.inputTokens) : "-"}</td>
                <td>{hasTokenSplit ? formatNumber(integration.outputTokens) : "-"}</td>
                <td>
                  {currency
                    ? `${formatNumber(integration.totalCost)} ${currency}`
                    : formatNumber(integration.totalCost)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
