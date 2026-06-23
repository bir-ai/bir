import type { PlaygroundChatReply } from "./playground-contract";
import { buildTraceFilterQuery, getTraceScores, type Trace, type TraceEvent } from "./trace-contract";

export const PLAYGROUND_HISTORY_PAGE_SIZE = 25;
const PLAYGROUND_TRACE_NAME = "playground.chat";
const PLAYGROUND_TRACE_SOURCE = "playground";

export type PlaygroundHistoryCursor = {
  beforeStartTime: string;
  beforeId: string;
};

export type PlaygroundHistoryEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  expected?: string;
  reply?: PlaygroundChatReply;
};

export type PlaygroundHistorySession = {
  sessionId: string;
  startTime: string;
  endTime: string;
  traceCount: number;
  entries: PlaygroundHistoryEntry[];
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function buildPlaygroundHistoryQuery({
  cursor = null,
  limit = PLAYGROUND_HISTORY_PAGE_SIZE,
}: {
  cursor?: PlaygroundHistoryCursor | null;
  limit?: number;
} = {}): string {
  return buildTraceFilterQuery({
    name: PLAYGROUND_TRACE_NAME,
    source: PLAYGROUND_TRACE_SOURCE,
    limit,
    before_start_time: cursor?.beforeStartTime,
    before_id: cursor?.beforeId,
  });
}

export function mergePlaygroundHistoryTraces(current: Trace[], incoming: Trace[]): Trace[] {
  const tracesById = new Map<string, Trace>();
  for (const trace of current) {
    tracesById.set(trace.id, trace);
  }
  for (const trace of incoming) {
    tracesById.set(trace.id, trace);
  }
  return Array.from(tracesById.values()).sort(
    (first, second) => second.start_time.localeCompare(first.start_time) || second.id.localeCompare(first.id),
  );
}

export function playgroundHistoryCursorFromTraces(traces: Trace[]): PlaygroundHistoryCursor | null {
  if (traces.length === 0) {
    return null;
  }
  const oldestTrace = traces.reduce((oldest, trace) =>
    trace.start_time < oldest.start_time || (trace.start_time === oldest.start_time && trace.id < oldest.id)
      ? trace
      : oldest,
  );
  return {
    beforeStartTime: oldestTrace.start_time,
    beforeId: oldestTrace.id,
  };
}

export function buildPlaygroundHistorySessions(traces: Trace[]): PlaygroundHistorySession[] {
  const groupedTraces = new Map<string, Trace[]>();

  for (const trace of traces) {
    const sessionId = playgroundSessionId(trace);
    if (!sessionId) {
      continue;
    }

    const sessionTraces = groupedTraces.get(sessionId) ?? [];
    sessionTraces.push(trace);
    groupedTraces.set(sessionId, sessionTraces);
  }

  return Array.from(groupedTraces.entries())
    .map(([sessionId, sessionTraces]) => buildSession(sessionId, sessionTraces))
    .filter((session): session is PlaygroundHistorySession => session !== null)
    .sort((a, b) => b.endTime.localeCompare(a.endTime));
}

function buildSession(sessionId: string, traces: Trace[]): PlaygroundHistorySession | null {
  const orderedTraces = [...traces].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const entries: PlaygroundHistoryEntry[] = [];

  for (const trace of orderedTraces) {
    const generation = playgroundGeneration(trace);
    if (!generation) {
      continue;
    }

    const userMessage = lastUserMessage(generation.input);
    if (userMessage) {
      entries.push({
        id: `${trace.id}-user`,
        role: "user",
        content: userMessage.content,
        expected: expectedOutputFromScores(trace),
      });
    }

    const assistantContent = assistantOutput(generation.output);
    if (assistantContent) {
      entries.push({
        id: `${trace.id}-assistant`,
        role: "assistant",
        content: assistantContent,
        reply: {
          trace_id: trace.id,
          message: { role: "assistant", content: assistantContent },
          model: generation.model ?? "unknown",
          input_tokens: usageNumber(generation.usage, "input_tokens"),
          output_tokens: usageNumber(generation.usage, "output_tokens"),
          total_tokens: usageNumber(generation.usage, "total_tokens"),
          latency_ms: latencyMs(generation),
          // The live chat reply carries metadata-free {name, value} scores, so
          // reconstructed history replies drop score metadata to match; the full
          // metadata still shows on the score events in the trace timeline.
          scores: getTraceScores(trace.events).map(({ name, value }) => ({ name, value })),
        },
      });
    }
  }

  if (entries.length === 0 || orderedTraces.length === 0) {
    return null;
  }

  return {
    sessionId,
    startTime: orderedTraces[0].start_time,
    endTime: orderedTraces[orderedTraces.length - 1].end_time,
    traceCount: orderedTraces.length,
    entries,
  };
}

function playgroundSessionId(trace: Trace): string | null {
  const rootEvent = trace.events.find((event) => event.type === "trace" && event.metadata.source === "playground");
  const generationEvent = playgroundGeneration(trace);
  const sessionId = rootEvent?.metadata.session_id ?? generationEvent?.metadata.session_id;

  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId : null;
}

function playgroundGeneration(trace: Trace): TraceEvent | null {
  return (
    trace.events.find(
      (event) =>
        event.type === "generation" &&
        event.name === "playground.llm" &&
        event.metadata.source === "playground",
    ) ?? null
  );
}

function lastUserMessage(input: unknown): ChatMessage | null {
  if (!isRecord(input) || !Array.isArray(input.messages)) {
    return null;
  }

  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (isChatMessage(message) && message.role === "user") {
      return message;
    }
  }
  return null;
}

// The contains_expected evaluator records the expected answer in its score
// metadata, so reconstructed sessions can still be exported as datasets.
function expectedOutputFromScores(trace: Trace): string | undefined {
  const scoreEvent = trace.events.find(
    (event) => event.type === "score" && event.name === "contains_expected",
  );
  const expected = scoreEvent?.metadata.expected_output;
  return typeof expected === "string" && expected.length > 0 ? expected : undefined;
}

function assistantOutput(output: unknown): string | null {
  if (typeof output === "string" && output.length > 0) {
    return output;
  }
  return null;
}

function usageNumber(usage: Record<string, number> | null | undefined, key: string): number | null {
  const value = usage?.[key];
  return typeof value === "number" ? value : null;
}

function latencyMs(event: TraceEvent): number {
  const metadataLatency = event.metadata.latency_ms;
  if (typeof metadataLatency === "number") {
    return metadataLatency;
  }

  const start = new Date(event.start_time).getTime();
  const end = new Date(event.end_time).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    (value.role === "system" || value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
