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

export type TraceFilterValues = {
  status?: string | null;
  name?: string | null;
  event_type?: string | null;
};

export type RetrievalDocument = {
  id?: string;
  rank?: number;
  score?: number;
  source?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

export type RetrievalDetails = {
  query: unknown;
  documents: RetrievalDocument[];
};

export type PromptDetails = {
  name: string;
  version?: string;
  template_sha256?: string;
  template?: string;
  variables?: Record<string, unknown>;
  rendered?: string;
  metadata?: Record<string, unknown>;
};

export type GenerationChatMessage = {
  role: string;
  content: string;
};

export type GenerationChatDetails = {
  messages: GenerationChatMessage[];
  outputText: string | null;
};

export type TraceScore = {
  name: string;
  value: number;
};

export type TraceSummary = {
  traceCount: number;
  eventCount: number;
  generationCount: number;
  errorCount: number;
  totalTokens: number;
  totalCost: number;
  currency: string | null;
  p50LatencyMs: number;
  p95LatencyMs: number;
};

export function normalizeTraces(value: unknown): Trace[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTrace).sort((a, b) => b.start_time.localeCompare(a.start_time));
}

export function findTraceById(traces: Trace[], traceId: string): Trace | null {
  return traces.find((trace) => trace.id === traceId) ?? null;
}

export function buildTraceFilterQuery(filters: TraceFilterValues): string {
  const params = new URLSearchParams();
  const status = filters.status?.trim();
  const name = filters.name?.trim();
  const eventType = filters.event_type?.trim();

  if (status && status !== "all") {
    params.set("status", status);
  }
  if (name) {
    params.set("name", name);
  }
  if (eventType && eventType !== "all") {
    params.set("event_type", eventType);
  }
  return params.toString();
}

export function getRetrievalDetails(event: TraceEvent): RetrievalDetails | null {
  if (event.type !== "tool_call" || event.metadata.kind !== "retrieval") {
    return null;
  }

  return {
    query: retrievalQuery(event.input),
    documents: retrievalDocuments(event.output),
  };
}

export function getPromptDetails(event: TraceEvent): PromptDetails | null {
  if (event.type !== "generation") {
    return null;
  }

  const prompt = event.metadata.prompt;
  if (!isRecord(prompt) || typeof prompt.name !== "string" || prompt.name.length === 0) {
    return null;
  }

  const details: PromptDetails = {
    name: prompt.name,
  };
  if (typeof prompt.version === "string") {
    details.version = prompt.version;
  }
  if (typeof prompt.template_sha256 === "string") {
    details.template_sha256 = prompt.template_sha256;
  }
  if (typeof prompt.template === "string") {
    details.template = prompt.template;
  }
  if (isRecord(prompt.variables)) {
    details.variables = prompt.variables;
  }
  if (typeof prompt.rendered === "string") {
    details.rendered = prompt.rendered;
  }
  if (isRecord(prompt.metadata)) {
    details.metadata = prompt.metadata;
  }
  return details;
}

export function getGenerationChatDetails(event: TraceEvent): GenerationChatDetails | null {
  if (event.type !== "generation" || !isRecord(event.input) || !Array.isArray(event.input.messages)) {
    return null;
  }

  const messages = event.input.messages;
  if (messages.length === 0 || !messages.every(isGenerationChatMessage)) {
    return null;
  }

  return {
    messages,
    outputText: typeof event.output === "string" ? event.output : null,
  };
}

export function getTraceScores(events: TraceEvent[]): TraceScore[] {
  return events
    .filter((event) => event.type === "score" && typeof event.value === "number")
    .map((event) => ({ name: event.name, value: event.value as number }));
}

export function summarizeTraces(traces: Trace[]): TraceSummary {
  let eventCount = 0;
  let generationCount = 0;
  let errorCount = 0;
  let totalTokens = 0;
  let totalCost = 0;
  const costCurrencies = new Set<string>();
  const durationsMs: number[] = [];

  for (const trace of traces) {
    eventCount += trace.events.length;
    if (trace.status === "error") {
      errorCount += 1;
    }

    const durationMs = traceDurationMs(trace);
    if (durationMs !== null) {
      durationsMs.push(durationMs);
    }

    for (const event of trace.events) {
      if (event.type !== "generation") {
        continue;
      }
      generationCount += 1;
      totalTokens += generationTokens(event.usage);
      const cost = generationCost(event.cost);
      if (cost !== null) {
        totalCost += cost;
        if (typeof event.currency === "string" && event.currency.length > 0) {
          costCurrencies.add(event.currency);
        }
      }
    }
  }

  durationsMs.sort((first, second) => first - second);

  return {
    traceCount: traces.length,
    eventCount,
    generationCount,
    errorCount,
    totalTokens,
    totalCost,
    currency: costCurrencies.size === 1 ? [...costCurrencies][0] : null,
    p50LatencyMs: percentile(durationsMs, 50),
    p95LatencyMs: percentile(durationsMs, 95),
  };
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

function traceDurationMs(trace: Trace): number | null {
  const start = new Date(trace.start_time).getTime();
  const end = new Date(trace.end_time).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

function generationTokens(usage: Record<string, number> | null | undefined): number {
  if (!usage) {
    return 0;
  }
  if (typeof usage.total_tokens === "number") {
    return usage.total_tokens;
  }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return inputTokens + outputTokens;
}

function generationCost(cost: Record<string, number> | null | undefined): number | null {
  if (!cost || typeof cost.total_cost !== "number") {
    return null;
  }
  return cost.total_cost;
}

// Nearest-rank percentile over an ascending list, so reported values are always
// real observed latencies rather than interpolated points.
function percentile(sortedAscending: number[], percentileRank: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil((percentileRank / 100) * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

function retrievalQuery(input: unknown): unknown {
  if (!isRecord(input) || !("query" in input)) {
    return null;
  }
  return input.query;
}

function retrievalDocuments(output: unknown): RetrievalDocument[] {
  if (!isRecord(output) || !Array.isArray(output.documents)) {
    return [];
  }

  return output.documents.filter(isRecord).map((document) => {
    const normalized: RetrievalDocument = {};
    if (typeof document.id === "string") {
      normalized.id = document.id;
    }
    if (typeof document.rank === "number") {
      normalized.rank = document.rank;
    }
    if (typeof document.score === "number") {
      normalized.score = document.score;
    }
    if (typeof document.source === "string") {
      normalized.source = document.source;
    }
    if (typeof document.text === "string") {
      normalized.text = document.text;
    }
    if (isRecord(document.metadata)) {
      normalized.metadata = document.metadata;
    }
    return normalized;
  });
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

function isGenerationChatMessage(value: unknown): value is GenerationChatMessage {
  return isRecord(value) && typeof value.role === "string" && typeof value.content === "string";
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
