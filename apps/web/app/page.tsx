"use client";

import Image from "next/image";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  normalizeExperiment,
  normalizeExperimentSummaries,
  type ExperimentExampleResult,
  type ExperimentStatus,
  type ExperimentSummary,
  type LoadedExperiment,
} from "./experiment-contract";
import {
  buildTraceTimelineRows,
  getRetrievalDetails,
  normalizeTraces,
  type EventStatus,
  type EventType,
  type RetrievalDetails,
  type Trace,
  type TraceTimelineRow,
} from "./trace-contract";

type ViewMode = "traces" | "experiments";

type TraceApiResponse = {
  traces?: unknown;
  apiBaseUrl?: string;
  error?: string;
  detail?: unknown;
};

type ExperimentListApiResponse = {
  experiments?: unknown;
  apiBaseUrl?: string;
  error?: string;
  detail?: unknown;
};

type ExperimentDetailApiResponse = {
  experiment?: unknown;
  apiBaseUrl?: string;
  error?: string;
  detail?: unknown;
};

const statusLabels: Record<EventStatus | ExperimentStatus, string> = {
  success: "Success",
  error: "Error",
};

const typeLabels: Record<EventType, string> = {
  trace: "Trace",
  span: "Span",
  generation: "Generation",
  tool_call: "Tool Call",
  score: "Score",
};

export default function DashboardPage() {
  const [activeView, setActiveView] = useState<ViewMode>("traces");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [selectedExperiment, setSelectedExperiment] = useState<LoadedExperiment | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState("http://127.0.0.1:8000");
  const [isTraceLoading, setIsTraceLoading] = useState(true);
  const [isExperimentLoading, setIsExperimentLoading] = useState(true);
  const [isExperimentDetailLoading, setIsExperimentDetailLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);

  const loadTraces = useCallback(async () => {
    setIsTraceLoading(true);
    setTraceError(null);

    try {
      const response = await fetch("/api/traces", { cache: "no-store" });
      const payload = (await response.json()) as TraceApiResponse;
      if (typeof payload.apiBaseUrl === "string") {
        setApiBaseUrl(payload.apiBaseUrl);
      }
      if (!response.ok) {
        setTraceError(payload.error ?? "Trace request failed");
        setTraces([]);
        setSelectedTraceId(null);
        return;
      }

      const nextTraces = normalizeTraces(payload.traces);
      setTraces(nextTraces);
      setSelectedTraceId((current) => {
        if (current && nextTraces.some((trace) => trace.id === current)) {
          return current;
        }
        return nextTraces[0]?.id ?? null;
      });
    } catch (requestError) {
      setTraceError(requestError instanceof Error ? requestError.message : "Trace request failed");
      setTraces([]);
      setSelectedTraceId(null);
    } finally {
      setIsTraceLoading(false);
    }
  }, []);

  const loadExperiments = useCallback(async () => {
    setIsExperimentLoading(true);
    setExperimentError(null);

    try {
      const response = await fetch("/api/experiments", { cache: "no-store" });
      const payload = (await response.json()) as ExperimentListApiResponse;
      if (typeof payload.apiBaseUrl === "string") {
        setApiBaseUrl(payload.apiBaseUrl);
      }
      if (!response.ok) {
        setExperimentError(payload.error ?? "Experiment request failed");
        setExperiments([]);
        setSelectedExperimentId(null);
        setSelectedExperiment(null);
        return;
      }

      const nextExperiments = normalizeExperimentSummaries(payload.experiments);
      setExperiments(nextExperiments);
      setSelectedExperimentId((current) => {
        if (current && nextExperiments.some((experiment) => experiment.experiment_id === current)) {
          return current;
        }
        return nextExperiments[0]?.experiment_id ?? null;
      });
    } catch (requestError) {
      setExperimentError(requestError instanceof Error ? requestError.message : "Experiment request failed");
      setExperiments([]);
      setSelectedExperimentId(null);
      setSelectedExperiment(null);
    } finally {
      setIsExperimentLoading(false);
    }
  }, []);

  const loadExperimentDetail = useCallback(async (experimentId: string) => {
    setIsExperimentDetailLoading(true);
    setExperimentError(null);

    try {
      const response = await fetch(`/api/experiments/${encodeURIComponent(experimentId)}`, { cache: "no-store" });
      const payload = (await response.json()) as ExperimentDetailApiResponse;
      if (typeof payload.apiBaseUrl === "string") {
        setApiBaseUrl(payload.apiBaseUrl);
      }
      if (!response.ok) {
        setExperimentError(payload.error ?? "Experiment detail request failed");
        setSelectedExperiment(null);
        return;
      }

      setSelectedExperiment(normalizeExperiment(payload.experiment));
    } catch (requestError) {
      setExperimentError(requestError instanceof Error ? requestError.message : "Experiment detail request failed");
      setSelectedExperiment(null);
    } finally {
      setIsExperimentDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTraces();
    void loadExperiments();
  }, [loadExperiments, loadTraces]);

  useEffect(() => {
    if (selectedExperimentId) {
      void loadExperimentDetail(selectedExperimentId);
      return;
    }
    setSelectedExperiment(null);
  }, [loadExperimentDetail, selectedExperimentId]);

  const selectedTrace = useMemo(
    () => traces.find((trace) => trace.id === selectedTraceId) ?? traces[0] ?? null,
    [selectedTraceId, traces],
  );
  const timelineRows = useMemo(
    () => (selectedTrace ? buildTraceTimelineRows(selectedTrace.events) : []),
    [selectedTrace],
  );

  const traceStats = useMemo(() => {
    const eventCount = traces.reduce((total, trace) => total + trace.events.length, 0);
    const errorCount = traces.filter((trace) => trace.status === "error").length;
    const generationCount = traces.reduce(
      (total, trace) => total + trace.events.filter((event) => event.type === "generation").length,
      0,
    );
    return { eventCount, errorCount, generationCount };
  }, [traces]);

  const experimentStats = useMemo(() => {
    const exampleCount = experiments.reduce((total, experiment) => total + experiment.example_count, 0);
    const errorCount = experiments.reduce((total, experiment) => total + experiment.error_count, 0);
    const scoreCount = experiments.reduce(
      (total, experiment) => total + Object.keys(experiment.aggregate_scores).length,
      0,
    );
    return { exampleCount, errorCount, scoreCount };
  }, [experiments]);

  const isActiveLoading =
    activeView === "traces" ? isTraceLoading : isExperimentLoading || isExperimentDetailLoading;
  const refreshActiveView = useCallback(() => {
    if (activeView === "traces") {
      void loadTraces();
      return;
    }
    void loadExperiments();
  }, [activeView, loadExperiments, loadTraces]);

  return (
    <main className="shell">
      <Image className="side-brand-mark" src="/bir_mark.png" alt="" width={109} height={1185} priority />
      <header className="topbar">
        <div className="brand-lockup" aria-label="bir">
          <h1>bir</h1>
        </div>
        <div className="topbar-actions">
          <div className="view-tabs" role="tablist" aria-label="Dashboard views">
            <button
              aria-selected={activeView === "traces"}
              className={activeView === "traces" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setActiveView("traces")}
            >
              Traces
            </button>
            <button
              aria-selected={activeView === "experiments"}
              className={activeView === "experiments" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setActiveView("experiments")}
            >
              Experiments
            </button>
          </div>
          <button className="refresh-button" type="button" onClick={refreshActiveView} disabled={isActiveLoading}>
            {isActiveLoading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      {activeView === "traces" ? (
        <TraceDashboard
          apiBaseUrl={apiBaseUrl}
          error={traceError}
          isLoading={isTraceLoading}
          selectedTrace={selectedTrace}
          setSelectedTraceId={setSelectedTraceId}
          stats={traceStats}
          timelineRows={timelineRows}
          traces={traces}
        />
      ) : (
        <ExperimentDashboard
          apiBaseUrl={apiBaseUrl}
          error={experimentError}
          experiments={experiments}
          isDetailLoading={isExperimentDetailLoading}
          isLoading={isExperimentLoading}
          selectedExperiment={selectedExperiment}
          selectedExperimentId={selectedExperimentId}
          setSelectedExperimentId={setSelectedExperimentId}
          stats={experimentStats}
        />
      )}
    </main>
  );
}

function TraceDashboard({
  apiBaseUrl,
  error,
  isLoading,
  selectedTrace,
  setSelectedTraceId,
  stats,
  timelineRows,
  traces,
}: {
  apiBaseUrl: string;
  error: string | null;
  isLoading: boolean;
  selectedTrace: Trace | null;
  setSelectedTraceId: (traceId: string) => void;
  stats: { eventCount: number; errorCount: number; generationCount: number };
  timelineRows: TraceTimelineRow[];
  traces: Trace[];
}) {
  return (
    <>
      <section className="metric-strip" aria-label="Trace summary">
        <Metric label="Traces" value={traces.length.toString()} />
        <Metric label="Events" value={stats.eventCount.toString()} />
        <Metric label="Generations" value={stats.generationCount.toString()} />
        <Metric label="Errors" value={stats.errorCount.toString()} tone={stats.errorCount > 0 ? "bad" : "good"} />
      </section>

      <section className="workspace">
        <aside className="trace-list" aria-label="Traces">
          <PanelHead title="Traces" subtitle={apiBaseUrl} />
          {error ? <div className="state-box error-state">{error}</div> : null}
          {!error && !isLoading && traces.length === 0 ? <div className="state-box">No traces found.</div> : null}
          {isLoading && traces.length === 0 ? <TraceSkeleton /> : null}

          <div className="trace-items">
            {traces.map((trace) => (
              <button
                className={trace.id === selectedTrace?.id ? "trace-row active" : "trace-row"}
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

              <div className="timeline">
                {timelineRows.map((row) => (
                  <EventRow row={row} key={row.event.id} />
                ))}
              </div>
            </>
          ) : (
            <div className="empty-detail">No trace selected.</div>
          )}
        </section>
      </section>
    </>
  );
}

function ExperimentDashboard({
  apiBaseUrl,
  error,
  experiments,
  isDetailLoading,
  isLoading,
  selectedExperiment,
  selectedExperimentId,
  setSelectedExperimentId,
  stats,
}: {
  apiBaseUrl: string;
  error: string | null;
  experiments: ExperimentSummary[];
  isDetailLoading: boolean;
  isLoading: boolean;
  selectedExperiment: LoadedExperiment | null;
  selectedExperimentId: string | null;
  setSelectedExperimentId: (experimentId: string) => void;
  stats: { exampleCount: number; errorCount: number; scoreCount: number };
}) {
  const selectedSummary = experiments.find((experiment) => experiment.experiment_id === selectedExperimentId) ?? null;
  const detail = selectedExperiment ?? selectedSummary;

  return (
    <>
      <section className="metric-strip" aria-label="Experiment summary">
        <Metric label="Experiments" value={experiments.length.toString()} />
        <Metric label="Examples" value={stats.exampleCount.toString()} />
        <Metric label="Scores" value={stats.scoreCount.toString()} />
        <Metric label="Errors" value={stats.errorCount.toString()} tone={stats.errorCount > 0 ? "bad" : "good"} />
      </section>

      <section className="workspace">
        <aside className="trace-list" aria-label="Experiments">
          <PanelHead title="Experiments" subtitle={apiBaseUrl} />
          {error ? <div className="state-box error-state">{error}</div> : null}
          {!error && !isLoading && experiments.length === 0 ? (
            <div className="state-box">No experiments found.</div>
          ) : null}
          {isLoading && experiments.length === 0 ? <TraceSkeleton /> : null}

          <div className="trace-items">
            {experiments.map((experiment) => (
              <button
                className={experiment.experiment_id === selectedExperimentId ? "trace-row active" : "trace-row"}
                key={experiment.experiment_id}
                type="button"
                onClick={() => setSelectedExperimentId(experiment.experiment_id)}
              >
                <span className={`status-dot ${experiment.status}`} aria-hidden="true" />
                <span className="trace-row-main">
                  <span className="trace-name">{experiment.name}</span>
                  <span className="trace-meta">
                    {experiment.example_count} examples · {formatAggregateScores(experiment.aggregate_scores)}
                  </span>
                </span>
                <span className={`status-pill ${experiment.status}`}>{statusLabels[experiment.status]}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="detail-panel" aria-label="Experiment details">
          {detail ? (
            <>
              <div className="detail-head">
                <div>
                  <p className="eyebrow">Experiment Detail</p>
                  <h2>{detail.name}</h2>
                  <p className="subtle">{detail.experiment_id}</p>
                </div>
                <div className="detail-facts">
                  <Fact label="Status" value={statusLabels[detail.status]} tone={detail.status} />
                  <Fact label="Duration" value={formatDuration(detail.start_time, detail.end_time)} />
                  <Fact label="Started" value={formatDate(detail.start_time)} />
                </div>
              </div>

              <div className="experiment-detail">
                <section className="score-grid" aria-label="Aggregate scores">
                  {Object.entries(detail.aggregate_scores).length > 0 ? (
                    Object.entries(detail.aggregate_scores).map(([name, value]) => (
                      <InlineField label={name} value={formatNumber(value)} key={name} />
                    ))
                  ) : (
                    <span className="subtle">No aggregate scores.</span>
                  )}
                </section>

                {isDetailLoading && !selectedExperiment ? <TraceSkeleton /> : null}
                {selectedExperiment ? (
                  <div className="experiment-results">
                    {selectedExperiment.results.map((result) => (
                      <ExperimentResultRow result={result} key={result.id} />
                    ))}
                  </div>
                ) : !isDetailLoading ? (
                  <div className="empty-detail">No experiment detail loaded.</div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="empty-detail">No experiment selected.</div>
          )}
        </section>
      </section>
    </>
  );
}

function PanelHead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="panel-head">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: EventStatus | ExperimentStatus;
}) {
  return (
    <div className={`fact ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EventRow({ row }: { row: TraceTimelineRow }) {
  const { event } = row;
  const eventIndent = Math.min(row.depth, 6) * 28;
  const hasInput = event.input !== null && event.input !== undefined;
  const hasOutput = event.output !== null && event.output !== undefined;
  const hasMetadata = Object.keys(event.metadata ?? {}).length > 0;
  const hasUsage = event.usage && Object.keys(event.usage).length > 0;
  const hasCost = event.cost && Object.keys(event.cost).length > 0;
  const retrievalDetails = getRetrievalDetails(event);

  return (
    <article
      className={`event-row ${event.type}${row.isOrphan ? " orphan" : ""}`}
      style={{ "--event-indent": `${eventIndent}px` } as CSSProperties}
    >
      <div className="timeline-rail">
        <span className={`event-node ${event.status}`} />
      </div>
      <div className="event-body">
        <div className="event-title-line">
          <div>
            <span className="event-type">{typeLabels[event.type]}</span>
            <h3>{event.name}</h3>
          </div>
          <div className="event-badges">
            {row.isOrphan ? <span className="orphan-pill">Orphan</span> : null}
            <span className={`status-pill ${event.status}`}>{statusLabels[event.status]}</span>
            <span className="duration-pill">{formatDuration(event.start_time, event.end_time)}</span>
          </div>
        </div>

        <div className="event-fields">
          {event.model ? <InlineField label="Model" value={event.model} /> : null}
          {event.type === "score" && typeof event.value === "number" ? (
            <InlineField label="Score" value={formatNumber(event.value)} />
          ) : null}
          {hasUsage ? <InlineField label="Usage" value={formatUsage(event.usage)} /> : null}
          {hasCost ? <InlineField label="Cost" value={formatCost(event.cost, event.currency)} /> : null}
          {event.parent_id ? <InlineField label="Parent" value={event.parent_id} /> : null}
        </div>

        {event.error ? <pre className="error-block">{event.error}</pre> : null}

        {retrievalDetails ? <RetrievalPanel details={retrievalDetails} /> : null}

        <div className="payload-grid">
          {hasInput && !retrievalDetails ? <Payload title="Input" value={event.input} /> : null}
          {hasOutput && !retrievalDetails ? <Payload title="Output" value={event.output} /> : null}
          {hasMetadata ? <Payload title="Metadata" value={event.metadata} /> : null}
        </div>
      </div>
    </article>
  );
}

function ExperimentResultRow({ result }: { result: ExperimentExampleResult }) {
  const hasInput = result.input !== null && result.input !== undefined;
  const hasExpected = result.expected !== null && result.expected !== undefined;
  const hasOutput = result.output !== null && result.output !== undefined;

  return (
    <article className="experiment-result">
      <div className="event-title-line">
        <div>
          <span className="event-type">Example</span>
          <h3>{result.example_id}</h3>
        </div>
        <div className="event-badges">
          <span className={`status-pill ${result.status}`}>{statusLabels[result.status]}</span>
          <span className="duration-pill">{formatDuration(result.start_time, result.end_time)}</span>
        </div>
      </div>

      <div className="event-fields">
        {result.scores.map((score) => (
          <InlineField label={score.name} value={formatNumber(score.value)} key={score.name} />
        ))}
      </div>

      {result.error ? <pre className="error-block">{result.error}</pre> : null}

      <div className="payload-grid">
        {hasInput ? <Payload title="Input" value={result.input} /> : null}
        {hasExpected ? <Payload title="Expected" value={result.expected} /> : null}
        {hasOutput ? <Payload title="Output" value={result.output} /> : null}
        {result.scores.length > 0 ? <Payload title="Scores" value={result.scores} /> : null}
      </div>
    </article>
  );
}

function RetrievalPanel({ details }: { details: RetrievalDetails }) {
  const hasQuery = details.query !== null && details.query !== undefined;

  return (
    <section className="retrieval-panel">
      <div className="retrieval-query">
        <h4>Query</h4>
        {hasQuery ? <pre>{formatPayloadValue(details.query)}</pre> : <p>No query captured.</p>}
      </div>

      <div className="retrieval-docs">
        <h4>Documents</h4>
        {details.documents.length > 0 ? (
          <div className="retrieval-doc-list">
            {details.documents.map((document, index) => (
              <article className="retrieval-doc" key={`${document.id ?? "document"}-${index}`}>
                <div className="retrieval-doc-head">
                  <strong>{document.id ?? `Document ${index + 1}`}</strong>
                  <div className="event-badges">
                    {typeof document.rank === "number" ? (
                      <span className="doc-chip">Rank {formatNumber(document.rank)}</span>
                    ) : null}
                    {typeof document.score === "number" ? (
                      <span className="doc-chip">Score {formatNumber(document.score)}</span>
                    ) : null}
                    {document.source ? <span className="doc-chip">{document.source}</span> : null}
                  </div>
                </div>
                {document.text ? <p className="retrieval-text">{document.text}</p> : null}
                {document.metadata ? <pre className="retrieval-metadata">{JSON.stringify(document.metadata, null, 2)}</pre> : null}
              </article>
            ))}
          </div>
        ) : (
          <p>No documents captured.</p>
        )}
      </div>
    </section>
  );
}

function InlineField({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-field">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function Payload({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="payload">
      <h4>{title}</h4>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function formatPayloadValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function TraceSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatDuration(startValue: string, endValue: string): string {
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "-";
  }
  const duration = Math.max(0, end - start);
  if (duration < 1000) {
    return `${duration.toFixed(0)} ms`;
  }
  return `${(duration / 1000).toFixed(2)} s`;
}

function formatUsage(usage: Record<string, number> | null | undefined): string {
  if (!usage) {
    return "";
  }
  return Object.entries(usage)
    .map(([key, value]) => `${key}: ${formatNumber(value)}`)
    .join(", ");
}

function formatCost(cost: Record<string, number> | null | undefined, currency: string | null | undefined): string {
  if (!cost) {
    return "";
  }
  const suffix = currency ? ` ${currency}` : "";
  return Object.entries(cost)
    .map(([key, value]) => `${key}: ${formatNumber(value)}${suffix}`)
    .join(", ");
}

function formatAggregateScores(scores: Record<string, number>): string {
  const entries = Object.entries(scores);
  if (entries.length === 0) {
    return "no scores";
  }
  return entries.map(([key, value]) => `${key}: ${formatNumber(value)}`).join(", ");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 6,
  }).format(value);
}
