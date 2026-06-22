export type EventStatus = "success" | "error";
export type EventType = "trace" | "span" | "generation" | "tool_call" | "score";
export type TraceSort = "recent" | "slowest";

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
  // Persisted as explicit null on non-score events (model_dump exclude_none=False).
  value?: number | null;
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
  service?: string | null;
  environment?: string | null;
  min_duration_ms?: number;
  sort?: TraceSort;
  limit?: number;
};

export type TraceService = {
  name?: string;
  environment?: string;
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
  metadata?: Record<string, unknown>;
};

export type TraceScoreGroupKey = "faithfulness" | "other";

export type TraceScoreGroup = {
  key: TraceScoreGroupKey;
  scores: TraceScore[];
};

export type TraceModelSummary = {
  model: string;
  generationCount: number;
  totalTokens: number;
  // Reported input/output split. Generations that send only total_tokens leave
  // these at 0 rather than inferring a breakdown, so the two need not sum to
  // totalTokens.
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
};

export type TraceProviderSummary = {
  provider: string;
  generationCount: number;
  totalTokens: number;
  // Same reported-only input/output split as TraceModelSummary: generations that
  // send just total_tokens leave these at 0 instead of inferring a breakdown.
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
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
  models: TraceModelSummary[];
  providers: TraceProviderSummary[];
};

export type TraceTotals = {
  totalTokens: number;
  totalCost: number;
  currency: string | null;
};

export function normalizeTraces(value: unknown, sort: TraceSort = "recent"): Trace[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const traces = value.filter(isTrace);
  if (sort === "slowest") {
    // Mirror the server's slowest-first ordering (duration desc, then recency
    // then id) so the displayed order is stable regardless of response order.
    return traces.sort(
      (a, b) =>
        (traceDurationMs(b) ?? 0) - (traceDurationMs(a) ?? 0) ||
        b.start_time.localeCompare(a.start_time) ||
        b.id.localeCompare(a.id),
    );
  }
  return traces.sort((a, b) => b.start_time.localeCompare(a.start_time));
}

export function findTraceById(traces: Trace[], traceId: string): Trace | null {
  return traces.find((trace) => trace.id === traceId) ?? null;
}

export function buildTraceFilterQuery(filters: TraceFilterValues): string {
  const params = new URLSearchParams();
  const status = filters.status?.trim();
  const name = filters.name?.trim();
  const eventType = filters.event_type?.trim();
  const service = filters.service?.trim();
  const environment = filters.environment?.trim();
  const minDurationMs = filters.min_duration_ms;
  const sort = filters.sort;
  const limit = filters.limit;

  if (status && status !== "all") {
    params.set("status", status);
  }
  if (name) {
    params.set("name", name);
  }
  if (eventType && eventType !== "all") {
    params.set("event_type", eventType);
  }
  if (service) {
    params.set("service", service);
  }
  if (environment) {
    params.set("environment", environment);
  }
  // Only forward a positive, finite duration threshold. Unlike limit this allows
  // fractional milliseconds, matching the server's Query(gt=0) float bound, so a
  // stray NaN/Infinity or non-positive value is dropped but 12.5 is kept.
  if (typeof minDurationMs === "number" && Number.isFinite(minDurationMs) && minDurationMs > 0) {
    params.set("min_duration_ms", String(minDurationMs));
  }
  // Only forward a non-default sort so default browse URLs stay clean.
  if (sort === "slowest") {
    params.set("sort", sort);
  }
  // Only forward a positive, finite integer: the server rejects limit <= 0 and a
  // stray NaN/Infinity would serialize into a meaningless query parameter.
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
    params.set("limit", String(limit));
  }
  return params.toString();
}

export function buildTraceSummaryFilterQuery(filters: TraceFilterValues): string {
  const params = new URLSearchParams(buildTraceFilterQuery(filters));
  params.delete("limit");
  params.delete("sort");
  return params.toString();
}

// One-click triage helpers: keep the "errors only" status shortcut in one place
// so the quick toggle and the failed-count chip stay in lockstep.
export function isErrorsOnlyFilter(filters: TraceFilterValues): boolean {
  return filters.status === "error";
}

export function toggleErrorsOnlyFilter(filters: TraceFilterValues): TraceFilterValues {
  // Turning the shortcut off clears the status to "all" rather than restoring a
  // previous value, so the result is predictable from the filters alone.
  return { ...filters, status: isErrorsOnlyFilter(filters) ? "all" : "error" };
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
    .map((event) => {
      const score: TraceScore = { name: event.name, value: event.value as number };
      if (isRecord(event.metadata) && Object.keys(event.metadata).length > 0) {
        score.metadata = event.metadata;
      }
      return score;
    });
}

// Faithfulness/RAG-quality evaluators, anchored on the SDK's
// answer_context_overlap plus the score names developers commonly use for the
// same family. A score can also opt in via metadata.group === "faithfulness".
const FAITHFULNESS_SCORE_NAMES = new Set(["answer_context_overlap", "faithfulness", "groundedness"]);

export function getTraceScoreGroups(events: TraceEvent[]): TraceScoreGroup[] {
  const faithfulness: TraceScore[] = [];
  const other: TraceScore[] = [];
  for (const score of getTraceScores(events)) {
    (isFaithfulnessScore(score) ? faithfulness : other).push(score);
  }

  // Only return groups that have scores so the detail view never renders an
  // empty labeled section; faithfulness stays first for a stable read order.
  const groups: TraceScoreGroup[] = [];
  if (faithfulness.length > 0) {
    groups.push({ key: "faithfulness", scores: faithfulness });
  }
  if (other.length > 0) {
    groups.push({ key: "other", scores: other });
  }
  return groups;
}

function isFaithfulnessScore(score: TraceScore): boolean {
  return FAITHFULNESS_SCORE_NAMES.has(score.name) || score.metadata?.group === "faithfulness";
}

export function getTraceService(trace: Trace): TraceService | null {
  const root = trace.events.find((event) => event.type === "trace" && event.id === trace.id);
  const service = root?.metadata.service;
  if (!isRecord(service)) {
    return null;
  }

  const result: TraceService = {};
  if (typeof service.name === "string" && service.name.length > 0) {
    result.name = service.name;
  }
  if (typeof service.environment === "string" && service.environment.length > 0) {
    result.environment = service.environment;
  }
  if (result.name === undefined && result.environment === undefined) {
    return null;
  }
  return result;
}

export function getTraceTotals(events: TraceEvent[]): TraceTotals {
  let totalTokens = 0;
  let totalCost = 0;
  const costCurrencies = new Set<string>();

  for (const event of events) {
    if (event.type !== "generation") {
      continue;
    }
    totalTokens += generationTokens(event.usage);
    const cost = generationCost(event.cost);
    if (cost !== null) {
      totalCost += cost;
      if (typeof event.currency === "string" && event.currency.length > 0) {
        costCurrencies.add(event.currency);
      }
    }
  }

  return {
    totalTokens,
    totalCost,
    currency: costCurrencies.size === 1 ? [...costCurrencies][0] : null,
  };
}

export function summarizeTraces(traces: Trace[]): TraceSummary {
  let eventCount = 0;
  let generationCount = 0;
  let errorCount = 0;
  let totalTokens = 0;
  let totalCost = 0;
  const costCurrencies = new Set<string>();
  const durationsMs: number[] = [];
  const modelSummaries = new Map<string, TraceModelSummary>();
  const providerSummaries = new Map<string, TraceProviderSummary>();

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
      const tokens = generationTokens(event.usage);
      const { inputTokens, outputTokens } = generationTokenSplit(event.usage);
      totalTokens += tokens;
      const cost = generationCost(event.cost);
      if (cost !== null) {
        totalCost += cost;
        if (typeof event.currency === "string" && event.currency.length > 0) {
          costCurrencies.add(event.currency);
        }
      }

      // Bucket each generation by model; generations without one collapse into a
      // shared "unknown" entry that only appears when such generations exist.
      const modelKey = typeof event.model === "string" && event.model.length > 0 ? event.model : "unknown";
      const bucket = modelSummaries.get(modelKey) ?? {
        model: modelKey,
        generationCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
      };
      bucket.generationCount += 1;
      bucket.totalTokens += tokens;
      bucket.inputTokens += inputTokens;
      bucket.outputTokens += outputTokens;
      bucket.totalCost += cost ?? 0;
      modelSummaries.set(modelKey, bucket);

      // Bucket the same generation by provider, derived from metadata or the
      // generation name; generations without either collapse into "unknown".
      const providerKey = deriveProvider(event);
      const providerBucket = providerSummaries.get(providerKey) ?? {
        provider: providerKey,
        generationCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
      };
      providerBucket.generationCount += 1;
      providerBucket.totalTokens += tokens;
      providerBucket.inputTokens += inputTokens;
      providerBucket.outputTokens += outputTokens;
      providerBucket.totalCost += cost ?? 0;
      providerSummaries.set(providerKey, providerBucket);
    }
  }

  durationsMs.sort((first, second) => first - second);

  const models = [...modelSummaries.values()].sort(
    (first, second) => second.generationCount - first.generationCount || first.model.localeCompare(second.model),
  );

  const providers = [...providerSummaries.values()].sort(
    (first, second) => second.generationCount - first.generationCount || first.provider.localeCompare(second.provider),
  );

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
    models,
    providers,
  };
}

export function normalizeTraceSummary(value: unknown): TraceSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const countKeys = ["trace_count", "event_count", "generation_count", "error_count"] as const;
  const totalKeys = ["total_tokens", "total_cost", "p50_latency_ms", "p95_latency_ms"] as const;
  if (
    !countKeys.every((key) => isNonNegativeInteger(value[key])) ||
    !totalKeys.every((key) => isNonNegativeFiniteNumber(value[key])) ||
    !(value.currency === null || (typeof value.currency === "string" && value.currency.length > 0)) ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.providers)
  ) {
    return null;
  }

  const models = value.models.map(normalizeModelSummary);
  const providers = value.providers.map(normalizeProviderSummary);
  if (models.some((entry) => entry === null) || providers.some((entry) => entry === null)) {
    return null;
  }
  return {
    traceCount: value.trace_count as number,
    eventCount: value.event_count as number,
    generationCount: value.generation_count as number,
    errorCount: value.error_count as number,
    totalTokens: value.total_tokens as number,
    totalCost: value.total_cost as number,
    currency: value.currency as string | null,
    p50LatencyMs: value.p50_latency_ms as number,
    p95LatencyMs: value.p95_latency_ms as number,
    models: models as TraceModelSummary[],
    providers: providers as TraceProviderSummary[],
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

// Reported input/output token split. Unlike generationTokens this never derives
// a value: a generation that sends only total_tokens has an unknown split, so
// both sides stay 0 instead of guessing a breakdown from the total.
function generationTokenSplit(usage: Record<string, number> | null | undefined): {
  inputTokens: number;
  outputTokens: number;
} {
  return {
    inputTokens: usage && typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: usage && typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

function generationCost(cost: Record<string, number> | null | undefined): number | null {
  if (!cost || typeof cost.total_cost !== "number") {
    return null;
  }
  return cost.total_cost;
}

// Provider attribution for a generation: an explicit non-empty metadata.provider
// wins, otherwise fall back to the namespace prefix of a dotted generation name
// such as "openai.chat.completions" -> "openai" or "local.llm" -> "local". Names
// without a namespace prefix have no derivable provider and collapse into
// "unknown".
function deriveProvider(event: TraceEvent): string {
  const provider = event.metadata.provider;
  if (typeof provider === "string" && provider.length > 0) {
    return provider;
  }
  const dotIndex = event.name.indexOf(".");
  if (dotIndex > 0) {
    return event.name.slice(0, dotIndex);
  }
  return "unknown";
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

function normalizeModelSummary(value: unknown): TraceModelSummary | null {
  if (!isRecord(value) || typeof value.model !== "string" || value.model.length === 0) {
    return null;
  }
  const totals = normalizeBreakdownTotals(value);
  return totals ? { model: value.model, ...totals } : null;
}

function normalizeProviderSummary(value: unknown): TraceProviderSummary | null {
  if (!isRecord(value) || typeof value.provider !== "string" || value.provider.length === 0) {
    return null;
  }
  const totals = normalizeBreakdownTotals(value);
  return totals ? { provider: value.provider, ...totals } : null;
}

function normalizeBreakdownTotals(value: Record<string, unknown>): Omit<TraceModelSummary, "model"> | null {
  if (
    !isNonNegativeInteger(value.generation_count) ||
    !isNonNegativeFiniteNumber(value.total_tokens) ||
    !isNonNegativeFiniteNumber(value.input_tokens) ||
    !isNonNegativeFiniteNumber(value.output_tokens) ||
    !isNonNegativeFiniteNumber(value.total_cost)
  ) {
    return null;
  }
  return {
    generationCount: value.generation_count,
    totalTokens: value.total_tokens,
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalCost: value.total_cost,
  };
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFiniteNumber(value) && Number.isInteger(value);
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

export function isTrace(value: unknown): value is Trace {
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
  const hasValidOptionalFields =
    isOptionalNullableNumber(candidate.value) &&
    isOptionalNullableString(candidate.model) &&
    isOptionalNullableNumberRecord(candidate.usage) &&
    isOptionalNullableNumberRecord(candidate.cost) &&
    isOptionalNullableString(candidate.currency);
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
    (typeof candidate.error === "string" || candidate.error === null) &&
    hasValidOptionalFields &&
    (candidate.type !== "score" || typeof candidate.value === "number")
  );
}

function isOptionalNullableNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "number";
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableNumberRecord(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isRecord(value) && Object.values(value).every((item) => typeof item === "number"))
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
