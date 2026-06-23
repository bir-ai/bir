import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlaygroundHistoryQuery,
  buildPlaygroundHistorySessions,
  mergePlaygroundHistoryTraces,
  playgroundHistoryCursorFromTraces,
} from "./playground-history";
import type { Trace, TraceEvent } from "./trace-contract";

test("builds scoped bounded Playground history queries", () => {
  assert.equal(
    buildPlaygroundHistoryQuery({ limit: 10 }),
    "name=playground.chat&source=playground&limit=10",
  );
  assert.equal(
    buildPlaygroundHistoryQuery({
      limit: 10,
      cursor: { beforeStartTime: "2026-01-02T00:00:00.000Z", beforeId: "trace-2" },
    }),
    "name=playground.chat&source=playground&limit=10&before_start_time=2026-01-02T00%3A00%3A00.000Z&before_id=trace-2",
  );
});

test("merges history pages without duplicate traces", () => {
  const newer = makePlaygroundTrace({
    traceId: "trace-newer",
    sessionId: "session-newer",
    startTime: "2026-01-03T00:00:00.000Z",
  });
  const shared = makePlaygroundTrace({
    traceId: "trace-shared",
    sessionId: "session-shared",
    startTime: "2026-01-02T00:00:00.000Z",
    output: "old copy",
  });
  const updatedShared = makePlaygroundTrace({
    traceId: "trace-shared",
    sessionId: "session-shared",
    startTime: "2026-01-02T00:00:00.000Z",
    output: "new copy",
  });
  const older = makePlaygroundTrace({
    traceId: "trace-older",
    sessionId: "session-older",
    startTime: "2026-01-01T00:00:00.000Z",
  });

  const merged = mergePlaygroundHistoryTraces([newer, shared], [updatedShared, older]);

  assert.deepEqual(merged.map((trace) => trace.id), ["trace-newer", "trace-shared", "trace-older"]);
  assert.equal(buildPlaygroundHistorySessions(merged).find((session) => session.sessionId === "session-shared")
    ?.entries[1].content, "new copy");
  assert.deepEqual(playgroundHistoryCursorFromTraces(merged), {
    beforeStartTime: older.start_time,
    beforeId: older.id,
  });
});

test("reconstructs a session split across history page boundaries after merging pages", () => {
  const recentPage = [
    makePlaygroundTrace({
      traceId: "session-1-turn-2",
      sessionId: "session-1",
      startTime: "2026-01-02T00:00:00.000Z",
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Second" },
      ],
      output: "Second reply",
    }),
  ];
  const olderPage = [
    makePlaygroundTrace({
      traceId: "session-1-turn-1",
      sessionId: "session-1",
      startTime: "2026-01-01T00:00:00.000Z",
      messages: [{ role: "user", content: "First" }],
      output: "First reply",
    }),
  ];

  const sessions = buildPlaygroundHistorySessions(mergePlaygroundHistoryTraces(recentPage, olderPage));

  assert.deepEqual(
    sessions[0].entries.map((entry) => [entry.role, entry.content]),
    [
      ["user", "First"],
      ["assistant", "First reply"],
      ["user", "Second"],
      ["assistant", "Second reply"],
    ],
  );
});

test("refresh after a new Playground turn preserves older loaded history", () => {
  const olderLoaded = makePlaygroundTrace({
    traceId: "older-turn",
    sessionId: "older-session",
    startTime: "2026-01-01T00:00:00.000Z",
  });
  const previousRecent = makePlaygroundTrace({
    traceId: "previous-recent",
    sessionId: "current-session",
    startTime: "2026-01-02T00:00:00.000Z",
  });
  const newRecent = makePlaygroundTrace({
    traceId: "new-recent",
    sessionId: "current-session",
    startTime: "2026-01-03T00:00:00.000Z",
  });

  const loadedHistory = mergePlaygroundHistoryTraces([previousRecent], [olderLoaded]);
  const refreshed = mergePlaygroundHistoryTraces(loadedHistory, [newRecent, previousRecent]);

  assert.deepEqual(refreshed.map((trace) => trace.id), ["new-recent", "previous-recent", "older-turn"]);
  assert.deepEqual(
    buildPlaygroundHistorySessions(refreshed).map((session) => session.sessionId),
    ["current-session", "older-session"],
  );
});

test("groups playground traces by session id and reconstructs messages", () => {
  const sessions = buildPlaygroundHistorySessions([
    makePlaygroundTrace({
      traceId: "trace-2",
      sessionId: "session-1",
      startTime: "2026-01-01T00:00:02.000Z",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "What is Bir?" },
      ],
      output: "Bir traces LLM apps.",
      totalTokens: 22,
    }),
    makePlaygroundTrace({
      traceId: "trace-1",
      sessionId: "session-1",
      startTime: "2026-01-01T00:00:01.000Z",
      messages: [{ role: "user", content: "Hello" }],
      output: "Hi",
      totalTokens: 9,
    }),
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, "session-1");
  assert.equal(sessions[0].traceCount, 2);
  assert.deepEqual(
    sessions[0].entries.map((entry) => [entry.role, entry.content]),
    [
      ["user", "Hello"],
      ["assistant", "Hi"],
      ["user", "What is Bir?"],
      ["assistant", "Bir traces LLM apps."],
    ],
  );
  assert.equal(sessions[0].entries[3].reply?.trace_id, "trace-2");
  assert.equal(sessions[0].entries[3].reply?.total_tokens, 22);
});

test("reconstructs evaluator scores from trace score events", () => {
  const sessions = buildPlaygroundHistorySessions([
    makePlaygroundTrace({
      traceId: "trace-1",
      sessionId: "session-1",
      output: "Hi",
      scores: [
        { name: "answered", value: 1 },
        { name: "contains_expected", value: 0 },
      ],
    }),
  ]);

  assert.deepEqual(sessions[0].entries[1].reply?.scores, [
    { name: "answered", value: 1 },
    { name: "contains_expected", value: 0 },
  ]);
});

test("recovers the expected answer from contains_expected score metadata", () => {
  const withExpected = makePlaygroundTrace({
    traceId: "trace-1",
    sessionId: "session-1",
    output: "Hi",
    scores: [{ name: "contains_expected", value: 0, expectedOutput: "Ankara" }],
  });
  const withoutExpected = makePlaygroundTrace({
    traceId: "trace-2",
    sessionId: "session-2",
    output: "Hi",
    scores: [{ name: "answered", value: 1 }],
  });

  const sessions = buildPlaygroundHistorySessions([withExpected, withoutExpected]);
  const expectedBySession = new Map(
    sessions.map((session) => [session.sessionId, session.entries[0].expected]),
  );

  assert.equal(expectedBySession.get("session-1"), "Ankara");
  assert.equal(expectedBySession.get("session-2"), undefined);
});

test("sorts reconstructed sessions by latest trace end time", () => {
  const sessions = buildPlaygroundHistorySessions([
    makePlaygroundTrace({
      traceId: "older-trace",
      sessionId: "older",
      startTime: "2026-01-01T00:00:01.000Z",
      output: "Older reply",
    }),
    makePlaygroundTrace({
      traceId: "newer-trace",
      sessionId: "newer",
      startTime: "2026-01-01T00:00:03.000Z",
      output: "Newer reply",
    }),
  ]);

  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    ["newer", "older"],
  );
});

test("ignores non-playground traces and traces without session ids", () => {
  const sessions = buildPlaygroundHistorySessions([
    makePlaygroundTrace({ traceId: "missing-session", sessionId: null }),
    makePlaygroundTrace({ traceId: "wrong-source", sessionId: "session-1", source: "sdk" }),
    makeTrace({ id: "ordinary-trace", name: "answer_question", events: [] }),
  ]);

  assert.deepEqual(sessions, []);
});

function makePlaygroundTrace({
  traceId,
  sessionId,
  startTime = "2026-01-01T00:00:00.000Z",
  source = "playground",
  messages = [{ role: "user", content: "Say hello." }],
  output = "Hello.",
  totalTokens = 3,
  scores = [],
}: {
  traceId: string;
  sessionId: string | null;
  startTime?: string;
  source?: string;
  messages?: { role: "system" | "user" | "assistant"; content: string }[];
  output?: string;
  totalTokens?: number;
  scores?: { name: string; value: number; expectedOutput?: string }[];
}): Trace {
  const metadata = sessionId === null ? { source } : { source, session_id: sessionId };
  const endTime = new Date(new Date(startTime).getTime() + 250).toISOString();
  const scoreEvents = scores.map((score) =>
    makeEvent({
      id: `${traceId}-score-${score.name}`,
      traceId,
      parentId: traceId,
      name: score.name,
      type: "score",
      startTime: endTime,
      endTime,
      metadata: score.expectedOutput === undefined ? metadata : { ...metadata, expected_output: score.expectedOutput },
      input: null,
      output: null,
      value: score.value,
    }),
  );
  return makeTrace({
    id: traceId,
    name: "playground.chat",
    startTime,
    endTime,
    events: [
      ...scoreEvents,
      makeEvent({
        id: traceId,
        traceId,
        parentId: null,
        name: "playground.chat",
        type: "trace",
        startTime,
        endTime,
        metadata,
        input: null,
        output: null,
      }),
      makeEvent({
        id: `${traceId}-generation`,
        traceId,
        parentId: traceId,
        name: "playground.llm",
        type: "generation",
        startTime,
        endTime,
        metadata: { ...metadata, latency_ms: 250 },
        input: { messages },
        output,
        model: "llama3.2:1b",
        usage: {
          input_tokens: Math.max(0, totalTokens - 1),
          output_tokens: 1,
          total_tokens: totalTokens,
        },
      }),
    ],
  });
}

function makeTrace({
  id,
  name,
  startTime = "2026-01-01T00:00:00.000Z",
  endTime = "2026-01-01T00:00:00.250Z",
  events,
}: {
  id: string;
  name: string;
  startTime?: string;
  endTime?: string;
  events: TraceEvent[];
}): Trace {
  return {
    id,
    name,
    start_time: startTime,
    end_time: endTime,
    status: "success",
    events,
  };
}

function makeEvent({
  id,
  traceId,
  parentId,
  name,
  type,
  startTime,
  endTime,
  metadata,
  input,
  output,
  model,
  usage,
  value,
}: {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  type: TraceEvent["type"];
  startTime: string;
  endTime: string;
  metadata: Record<string, unknown>;
  input: unknown;
  output: unknown;
  model?: string;
  usage?: Record<string, number>;
  value?: number;
}): TraceEvent {
  return {
    schema_version: "1.0",
    id,
    trace_id: traceId,
    parent_id: parentId,
    name,
    type,
    start_time: startTime,
    end_time: endTime,
    status: "success",
    metadata,
    input,
    output,
    error: null,
    model,
    usage,
    value,
  };
}
