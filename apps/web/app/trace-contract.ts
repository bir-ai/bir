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
  cost?: Record<string, number> | null;
  currency?: string | null;
};

export type Trace = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  status: EventStatus;
  events: TraceEvent[];
};

export type TraceTimelineRow = {
  event: TraceEvent;
  depth: number;
  isOrphan: boolean;
};

export function normalizeTraces(value: unknown): Trace[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTrace).sort((a, b) => b.start_time.localeCompare(a.start_time));
}

export function buildTraceTimelineRows(events: TraceEvent[]): TraceTimelineRow[] {
  const eventsById = new Map<string, TraceEvent>();
  const childrenByParentId = new Map<string, TraceEvent[]>();
  const roots: TraceEvent[] = [];
  const orphans: TraceEvent[] = [];

  for (const event of events) {
    eventsById.set(event.id, event);
  }

  for (const event of events) {
    if (event.parent_id === null) {
      roots.push(event);
      continue;
    }

    if (eventsById.has(event.parent_id)) {
      const children = childrenByParentId.get(event.parent_id) ?? [];
      children.push(event);
      childrenByParentId.set(event.parent_id, children);
      continue;
    }

    orphans.push(event);
  }

  const rows: TraceTimelineRow[] = [];
  const visitedEventIds = new Set<string>();

  function appendEvent(event: TraceEvent, depth: number, isOrphan: boolean) {
    if (visitedEventIds.has(event.id)) {
      return;
    }

    visitedEventIds.add(event.id);
    rows.push({ event, depth, isOrphan });

    for (const child of childrenByParentId.get(event.id) ?? []) {
      appendEvent(child, depth + 1, isOrphan);
    }
  }

  for (const root of roots) {
    appendEvent(root, 0, false);
  }
  for (const orphan of orphans) {
    appendEvent(orphan, 0, true);
  }
  for (const event of events) {
    appendEvent(event, 0, true);
  }

  return rows;
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
