"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";

type EventStatus = "success" | "error";
type EventType = "trace" | "span" | "generation" | "tool_call" | "score";

type TraceEvent = {
  schema_version: "1.0";
  id: string;
  trace_id: string;
  parent_id: string | null;
  name: string;
  type: EventType;
  start_time: string;
  end_time: string;
  status: EventStatus;
  metadata: Record<string, unknown>;
  input: unknown;
  output: unknown;
  error: string | null;
  value?: number;
  model?: string | null;
  usage?: Record<string, number> | null;
};

type Trace = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  status: EventStatus;
  events: TraceEvent[];
};

type ApiResponse = {
  traces?: unknown;
  apiBaseUrl?: string;
  error?: string;
  detail?: unknown;
};

const statusLabels: Record<EventStatus, string> = {
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
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState("http://127.0.0.1:8000");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadTraces() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/traces", { cache: "no-store" });
      const payload = (await response.json()) as ApiResponse;
      if (typeof payload.apiBaseUrl === "string") {
        setApiBaseUrl(payload.apiBaseUrl);
      }
      if (!response.ok) {
        setError(payload.error ?? "Trace request failed");
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
      setError(requestError instanceof Error ? requestError.message : "Trace request failed");
      setTraces([]);
      setSelectedTraceId(null);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadTraces();
  }, []);

  const selectedTrace = useMemo(
    () => traces.find((trace) => trace.id === selectedTraceId) ?? traces[0] ?? null,
    [selectedTraceId, traces],
  );

  const stats = useMemo(() => {
    const eventCount = traces.reduce((total, trace) => total + trace.events.length, 0);
    const errorCount = traces.filter((trace) => trace.status === "error").length;
    const generationCount = traces.reduce(
      (total, trace) => total + trace.events.filter((event) => event.type === "generation").length,
      0,
    );
    return { eventCount, errorCount, generationCount };
  }, [traces]);

  return (
    <main className="shell">
      <Image className="side-brand-mark" src="/bir_mark.png" alt="" width={109} height={1185} priority />
      <header className="topbar">
        <div className="brand-lockup" aria-label="bir">
          <h1>bir</h1>
        </div>
        <button className="refresh-button" type="button" onClick={() => void loadTraces()} disabled={isLoading}>
          {isLoading ? "Refreshing" : "Refresh"}
        </button>
      </header>

      <section className="metric-strip" aria-label="Trace summary">
        <Metric label="Traces" value={traces.length.toString()} />
        <Metric label="Events" value={stats.eventCount.toString()} />
        <Metric label="Generations" value={stats.generationCount.toString()} />
        <Metric label="Errors" value={stats.errorCount.toString()} tone={stats.errorCount > 0 ? "bad" : "good"} />
      </section>

      <section className="workspace">
        <aside className="trace-list" aria-label="Traces">
          <div className="panel-head">
            <div>
              <h2>Traces</h2>
              <p>{apiBaseUrl}</p>
            </div>
          </div>

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
                {selectedTrace.events.map((event) => (
                  <EventRow event={event} key={event.id} />
                ))}
              </div>
            </>
          ) : (
            <div className="empty-detail">No trace selected.</div>
          )}
        </section>
      </section>
    </main>
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
  tone?: EventStatus;
}) {
  return (
    <div className={`fact ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EventRow({ event }: { event: TraceEvent }) {
  const hasInput = event.input !== null && event.input !== undefined;
  const hasOutput = event.output !== null && event.output !== undefined;
  const hasMetadata = Object.keys(event.metadata ?? {}).length > 0;
  const hasUsage = event.usage && Object.keys(event.usage).length > 0;

  return (
    <article className={`event-row ${event.type}`}>
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
          {event.parent_id ? <InlineField label="Parent" value={event.parent_id} /> : null}
        </div>

        {event.error ? <pre className="error-block">{event.error}</pre> : null}

        <div className="payload-grid">
          {hasInput ? <Payload title="Input" value={event.input} /> : null}
          {hasOutput ? <Payload title="Output" value={event.output} /> : null}
          {hasMetadata ? <Payload title="Metadata" value={event.metadata} /> : null}
        </div>
      </div>
    </article>
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

function TraceSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function normalizeTraces(value: unknown): Trace[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTrace).sort((a, b) => b.start_time.localeCompare(a.start_time));
}

function isTrace(value: unknown): value is Trace {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<Trace>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.start_time === "string" &&
    typeof candidate.end_time === "string" &&
    isStatus(candidate.status) &&
    Array.isArray(candidate.events) &&
    candidate.events.every(isTraceEvent)
  );
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TraceEvent>;
  return (
    candidate.schema_version === "1.0" &&
    typeof candidate.id === "string" &&
    typeof candidate.trace_id === "string" &&
    (typeof candidate.parent_id === "string" || candidate.parent_id === null) &&
    typeof candidate.name === "string" &&
    isEventType(candidate.type) &&
    typeof candidate.start_time === "string" &&
    typeof candidate.end_time === "string" &&
    isStatus(candidate.status) &&
    isRecord(candidate.metadata) &&
    (typeof candidate.error === "string" || candidate.error === null)
  );
}

function isStatus(value: unknown): value is EventStatus {
  return value === "success" || value === "error";
}

function isEventType(value: unknown): value is EventType {
  return value === "trace" || value === "span" || value === "generation" || value === "tool_call" || value === "score";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 3,
  }).format(value);
}
