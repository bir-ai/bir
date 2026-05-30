export type EventStatus = "success" | "error";
export type EventType = "trace" | "span" | "generation" | "tool_call" | "score";

export type TraceEvent = {
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

export type Trace = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  status: EventStatus;
  events: TraceEvent[];
};

export function normalizeTraces(value: unknown): Trace[] {
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
