import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildTraceTimelineRows,
  buildTraceFilterQuery,
  findTraceById,
  getGenerationChatDetails,
  getPromptDetails,
  getRetrievalDetails,
  getTraceScores,
  normalizeTraces,
  summarizeTraces,
  type EventStatus,
  type Trace,
  type TraceEvent,
} from "./trace-contract";
import { compareExperiments, normalizeExperiment, normalizeExperimentSummaries } from "./experiment-contract";

const contractTraceResponseFixture = loadSharedContractTraceResponse();
const [contractTrace] = normalizeTraces(contractTraceResponseFixture);
assert.ok(contractTrace);

test("builds trace filter query strings from non-empty filters", () => {
  const query = buildTraceFilterQuery({
    status: "error",
    name: " answer question ",
    event_type: "generation",
  });

  assert.equal(query, "status=error&name=answer+question&event_type=generation");
});

test("omits empty and default trace filters", () => {
  const query = buildTraceFilterQuery({
    status: "all",
    name: "   ",
    event_type: "all",
  });

  assert.equal(query, "");
});

test("normalizes valid trace responses from the shared contract fixture", () => {
  const traces = normalizeTraces(contractTraceResponseFixture);

  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, "trace-fixture-1");
  assert.deepEqual(
    traces[0].events.map((event) => event.type),
    ["trace", "span", "tool_call", "generation", "score"],
  );
  const retrievalEvent = traces[0].events.find((event) => event.type === "tool_call");
  assert.deepEqual(retrievalEvent?.output, {
    documents: [
      {
        id: "doc-1",
        rank: 1,
        score: 0.82,
        source: "docs",
        text: "Bir records local traces with JSONL.",
      },
    ],
  });
  const generationEvent = traces[0].events.find((event) => event.type === "generation");
  assert.deepEqual(generationEvent?.cost, { input_cost: 0.000012, output_cost: 0.000048, total_cost: 0.00006 });
  assert.equal(generationEvent?.currency, "USD");
});

test("extracts retrieval query and documents from the shared contract fixture", () => {
  const retrievalEvent = contractTrace.events.find(
    (event) => event.type === "tool_call" && event.metadata.kind === "retrieval",
  );
  assert.ok(retrievalEvent);

  const details = getRetrievalDetails(retrievalEvent);

  assert.deepEqual(details, {
    query: "hello",
    documents: [
      {
        id: "doc-1",
        rank: 1,
        score: 0.82,
        source: "docs",
        text: "Bir records local traces with JSONL.",
      },
    ],
  });
});

test("does not treat ordinary tool calls as retrieval events", () => {
  const retrievalEvent = contractTrace.events.find((event) => event.type === "tool_call");
  assert.ok(retrievalEvent);
  const ordinaryToolEvent: TraceEvent = {
    ...retrievalEvent,
    metadata: { kind: "calculator" },
  };

  assert.equal(getRetrievalDetails(ordinaryToolEvent), null);
});

test("extracts prompt metadata from generation events", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const promptedGeneration: TraceEvent = {
    ...generationEvent,
    metadata: {
      prompt: {
        name: "answer_question",
        version: "v1",
        template_sha256: "abc123",
        template: "Answer {question}",
        variables: { question: "What is Bir?" },
        rendered: "Answer What is Bir?",
        metadata: { owner: "evals" },
        ignored_numeric_field: 123,
      },
    },
  };

  const details = getPromptDetails(promptedGeneration);

  assert.deepEqual(details, {
    name: "answer_question",
    version: "v1",
    template_sha256: "abc123",
    template: "Answer {question}",
    variables: { question: "What is Bir?" },
    rendered: "Answer What is Bir?",
    metadata: { owner: "evals" },
  });
});

test("ignores malformed prompt metadata", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const missingName: TraceEvent = {
    ...generationEvent,
    metadata: { prompt: { version: "v1" } },
  };
  const emptyName: TraceEvent = {
    ...generationEvent,
    metadata: { prompt: { name: "" } },
  };
  const nonObjectPrompt: TraceEvent = {
    ...generationEvent,
    metadata: { prompt: "answer_question" },
  };

  assert.equal(getPromptDetails(missingName), null);
  assert.equal(getPromptDetails(emptyName), null);
  assert.equal(getPromptDetails(nonObjectPrompt), null);
});

test("does not extract prompt metadata from non-generation events", () => {
  const traceEvent = contractTrace.events.find((event) => event.type === "trace");
  assert.ok(traceEvent);
  const eventWithPrompt: TraceEvent = {
    ...traceEvent,
    metadata: { prompt: { name: "answer_question" } },
  };

  assert.equal(getPromptDetails(eventWithPrompt), null);
});

test("extracts chat messages and output text from playground-style generations", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const chatGeneration: TraceEvent = {
    ...generationEvent,
    input: {
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "What is Bir?" },
      ],
    },
    output: "Bir is an observability SDK.",
  };

  const details = getGenerationChatDetails(chatGeneration);

  assert.deepEqual(details, {
    messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "What is Bir?" },
    ],
    outputText: "Bir is an observability SDK.",
  });
});

test("ignores generations whose input is not a chat message list", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const spanEvent = contractTrace.events.find((event) => event.type === "span");
  assert.ok(spanEvent);
  const malformedMessages: TraceEvent = {
    ...generationEvent,
    input: { messages: [{ role: "user" }] },
  };
  const chatShapedSpan: TraceEvent = {
    ...spanEvent,
    input: { messages: [{ role: "user", content: "hi" }] },
  };

  assert.equal(getGenerationChatDetails(generationEvent), null);
  assert.equal(getGenerationChatDetails(malformedMessages), null);
  assert.equal(getGenerationChatDetails(chatShapedSpan), null);
});

test("keeps a structured generation output out of the chat details text", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const structuredOutput: TraceEvent = {
    ...generationEvent,
    input: { messages: [{ role: "user", content: "hi" }] },
    output: { message: "ok" },
  };

  const details = getGenerationChatDetails(structuredOutput);

  assert.ok(details);
  assert.equal(details.outputText, null);
});

test("collects score events from a trace", () => {
  const scores = getTraceScores(contractTrace.events);

  assert.deepEqual(scores, [{ name: "helpfulness", value: 0.82 }]);
});

test("skips score events without a numeric value when collecting scores", () => {
  const scoreEvent = contractTrace.events.find((event) => event.type === "score");
  assert.ok(scoreEvent);
  const valuelessScore: TraceEvent = { ...scoreEvent, id: "score-no-value" };
  delete valuelessScore.value;

  assert.deepEqual(getTraceScores([valuelessScore]), []);
});

test("ignores malformed trace responses without throwing", () => {
  const malformedTrace = {
    ...contractTrace,
    events: [{ ...contractTrace.events[0], type: "unknown" }],
  };

  const traces = normalizeTraces([null, {}, malformedTrace, contractTrace]);

  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, contractTrace.id);
});

test("builds nested timeline rows from parent-child event relationships", () => {
  const rows = buildTraceTimelineRows(contractTrace.events);

  assert.deepEqual(
    rows.map((row) => ({
      name: row.event.name,
      depth: row.depth,
      isOrphan: row.isOrphan,
    })),
    [
      { name: "answer_question", depth: 0, isOrphan: false },
      { name: "retrieve_context", depth: 1, isOrphan: false },
      { name: "search_docs", depth: 2, isOrphan: false },
      { name: "local.llm", depth: 1, isOrphan: false },
      { name: "helpfulness", depth: 2, isOrphan: false },
    ],
  );
});

test("marks events whose parent is missing as orphan timeline rows", () => {
  const spanEvent = contractTrace.events.find((event) => event.type === "span");
  assert.ok(spanEvent);

  const orphanEvent: TraceEvent = {
    ...spanEvent,
    id: "orphan-span",
    parent_id: "missing-parent",
    name: "orphan_step",
  };
  const traceWithOrphan: Trace = {
    ...contractTrace,
    events: [...contractTrace.events, orphanEvent],
  };

  const rows = buildTraceTimelineRows(traceWithOrphan.events);
  const orphanRow = rows.find((row) => row.event.id === orphanEvent.id);

  assert.ok(orphanRow);
  assert.equal(orphanRow.depth, 0);
  assert.equal(orphanRow.isOrphan, true);
});

test("summarizes generation tokens and cost across traces", () => {
  const traces = [
    summarizableTrace({
      id: "trace-a",
      start: "2026-01-01T00:00:00.000+00:00",
      end: "2026-01-01T00:00:00.100+00:00",
      generations: [
        generationEvent({
          id: "gen-a",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          cost: { total_cost: 0.0006 },
          currency: "USD",
        }),
      ],
    }),
    summarizableTrace({
      id: "trace-b",
      start: "2026-01-01T00:00:00.000+00:00",
      end: "2026-01-01T00:00:00.300+00:00",
      generations: [
        generationEvent({
          id: "gen-b",
          // No total_tokens, so the helper falls back to input + output tokens.
          usage: { input_tokens: 30, output_tokens: 10 },
          cost: { total_cost: 0.0004 },
          currency: "USD",
        }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.equal(summary.traceCount, 2);
  assert.equal(summary.eventCount, 4);
  assert.equal(summary.generationCount, 2);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.totalTokens, 160);
  assert.ok(Math.abs(summary.totalCost - 0.001) < 1e-9);
  assert.equal(summary.currency, "USD");
});

test("computes p50 and p95 latency over trace root durations", () => {
  const baseStart = "2026-01-01T00:00:00.000+00:00";
  const baseMs = Date.parse(baseStart);
  const traces = [100, 300, 200, 400].map((durationMs, index) =>
    summarizableTrace({
      id: `trace-${index}`,
      start: baseStart,
      end: new Date(baseMs + durationMs).toISOString(),
    }),
  );

  const summary = summarizeTraces(traces);

  assert.equal(summary.p50LatencyMs, 200);
  assert.equal(summary.p95LatencyMs, 400);
});

test("returns a zeroed summary for an empty trace list", () => {
  assert.deepEqual(summarizeTraces([]), {
    traceCount: 0,
    eventCount: 0,
    generationCount: 0,
    errorCount: 0,
    totalTokens: 0,
    totalCost: 0,
    currency: null,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
  });
});

test("handles traces without generations or usage and counts errors", () => {
  const traces = [
    summarizableTrace({
      id: "trace-no-gen",
      status: "error",
      start: "2026-01-01T00:00:00.000+00:00",
      end: "2026-01-01T00:00:00.050+00:00",
    }),
    summarizableTrace({
      id: "trace-bare-gen",
      generations: [generationEvent({ id: "gen-bare" })],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.equal(summary.generationCount, 1);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.totalTokens, 0);
  assert.equal(summary.totalCost, 0);
  assert.equal(summary.currency, null);
  // Durations are [0, 50]; nearest-rank p95 picks the max so the 50ms trace counts.
  assert.equal(summary.p95LatencyMs, 50);
});

test("reports null currency when generations mix currencies", () => {
  const traces = [
    summarizableTrace({
      id: "trace-usd",
      generations: [generationEvent({ id: "gen-usd", cost: { total_cost: 0.001 }, currency: "USD" })],
    }),
    summarizableTrace({
      id: "trace-eur",
      generations: [generationEvent({ id: "gen-eur", cost: { total_cost: 0.002 }, currency: "EUR" })],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.equal(summary.currency, null);
  assert.ok(Math.abs(summary.totalCost - 0.003) < 1e-9);
});

test("normalizes valid experiment summary responses newest first", () => {
  const summaries = normalizeExperimentSummaries([
    makeExperimentSummary({ experiment_id: "experiment-1", start_time: "2026-01-01T00:00:00+00:00" }),
    makeExperimentSummary({ experiment_id: "experiment-2", start_time: "2026-01-02T00:00:00+00:00" }),
  ]);

  assert.deepEqual(
    summaries.map((summary) => summary.experiment_id),
    ["experiment-2", "experiment-1"],
  );
  assert.deepEqual(summaries[0].aggregate_scores, { contains: 1 });
});

test("normalizes valid experiment detail responses", () => {
  const experiment = normalizeExperiment({
    ...makeExperimentSummary(),
    results: [makeExperimentResult({ trace_id: contractTrace.id })],
  });

  assert.ok(experiment);
  assert.equal(experiment.experiment_id, "experiment-1");
  assert.equal(experiment.results[0].example_id, "q1");
  assert.equal(experiment.results[0].trace_id, contractTrace.id);
  assert.deepEqual(experiment.results[0].scores, [{ name: "contains", value: 1, metadata: { expected: "observability" } }]);
});

test("matches linked experiment trace ids to loaded traces", () => {
  const experiment = normalizeExperiment({
    ...makeExperimentSummary(),
    results: [makeExperimentResult({ trace_id: contractTrace.id })],
  });
  assert.ok(experiment);

  const linkedTrace = findTraceById([contractTrace], experiment.results[0].trace_id ?? "");

  assert.equal(linkedTrace?.id, contractTrace.id);
  assert.equal(findTraceById([contractTrace], "missing-trace"), null);
});

test("rejects malformed experiment responses without throwing", () => {
  const malformedSummary = makeExperimentSummary({ aggregate_scores: { contains: true } });
  const malformedDetail = {
    ...makeExperimentSummary(),
    results: [{ ...makeExperimentResult(), scores: [{ name: "contains", value: true, metadata: {} }] }],
  };

  assert.deepEqual(normalizeExperimentSummaries([malformedSummary, makeExperimentSummary()]), [makeExperimentSummary()]);
  assert.equal(normalizeExperiment(malformedDetail), null);
  assert.equal(normalizeExperiment(null), null);
});

test("compares experiments by aggregate and per-example score deltas", () => {
  const baseline = makeLoadedExperiment({
    summary: makeExperimentSummary({
      experiment_id: "baseline",
      name: "prompt-v1",
      aggregate_scores: { contains: 0.5, exact_match: 1 },
    }),
    results: [
      makeExperimentResult({
        id: "baseline-q1",
        example_id: "q1",
        scores: [{ name: "contains", value: 0.5, metadata: {} }],
      }),
      makeExperimentResult({
        id: "baseline-q2",
        example_id: "q2",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
      makeExperimentResult({
        id: "baseline-q3",
        example_id: "q3",
        scores: [{ name: "contains", value: 0.5, metadata: {} }],
      }),
      makeExperimentResult({
        id: "baseline-q4",
        example_id: "q4",
        scores: [{ name: "contains", value: 0.75, metadata: {} }],
      }),
    ],
  });
  const candidate = makeLoadedExperiment({
    summary: makeExperimentSummary({
      experiment_id: "candidate",
      name: "prompt-v2",
      aggregate_scores: { contains: 0.75, latency_under: 1 },
    }),
    results: [
      makeExperimentResult({
        id: "candidate-q1",
        example_id: "q1",
        scores: [{ name: "contains", value: 0.25, metadata: {} }],
      }),
      makeExperimentResult({
        id: "candidate-q2",
        example_id: "q2",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
      makeExperimentResult({
        id: "candidate-q3",
        example_id: "q3",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
      makeExperimentResult({
        id: "candidate-q5",
        example_id: "q5",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
    ],
  });

  const comparison = compareExperiments(baseline, candidate);

  assert.deepEqual(comparison.aggregate_scores, [
    { name: "contains", baseline_value: 0.5, candidate_value: 0.75, delta: 0.25 },
    { name: "exact_match", baseline_value: 1, candidate_value: null, delta: null },
    { name: "latency_under", baseline_value: null, candidate_value: 1, delta: null },
  ]);
  assert.deepEqual(
    comparison.rows.map((row) => [row.example_id, row.status]),
    [
      ["q1", "regressed"],
      ["q4", "missing_candidate"],
      ["q5", "new_candidate"],
      ["q3", "improved"],
      ["q2", "unchanged"],
    ],
  );
  assert.deepEqual(comparison.counts, {
    regressed: 1,
    improved: 1,
    unchanged: 1,
    missing_candidate: 1,
    new_candidate: 1,
  });
});

test("compares experiments with missing score values without throwing", () => {
  const baseline = makeLoadedExperiment({
    results: [
      makeExperimentResult({
        example_id: "q1",
        scores: [
          { name: "contains", value: 1, metadata: {} },
          { name: "exact_match", value: 1, metadata: {} },
        ],
      }),
    ],
  });
  const candidate = makeLoadedExperiment({
    summary: makeExperimentSummary({ experiment_id: "experiment-2", aggregate_scores: {} }),
    results: [
      makeExperimentResult({
        id: "candidate-q1",
        example_id: "q1",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
    ],
  });

  const comparison = compareExperiments(baseline, candidate);

  assert.equal(comparison.rows[0].status, "unchanged");
  assert.deepEqual(comparison.rows[0].scores, [
    { name: "contains", baseline_value: 1, candidate_value: 1, delta: 0 },
    { name: "exact_match", baseline_value: 1, candidate_value: null, delta: null },
  ]);
});

function loadSharedContractTraceResponse(): unknown[] {
  const fixturePath = path.resolve(process.cwd(), "../../tests/fixtures/valid-events.jsonl");
  const events = readFileSync(fixturePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

  const rootEvent = events.find(
    (event): event is Record<string, unknown> =>
      isRecord(event) && event.type === "trace" && event.id === event.trace_id,
  );
  assert.ok(rootEvent);

  return [
    {
      id: rootEvent.id,
      name: rootEvent.name,
      start_time: rootEvent.start_time,
      end_time: rootEvent.end_time,
      status: rootEvent.status,
      events,
    },
  ];
}

function makeExperimentSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0",
    experiment_id: "experiment-1",
    name: "prompt-v1",
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:01+00:00",
    status: "success",
    example_count: 1,
    error_count: 0,
    aggregate_scores: { contains: 1 },
    result_path: "prompt-v1-experiment-1.jsonl",
    ...overrides,
  };
}

function makeExperimentResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "result-1",
    example_id: "q1",
    input: { question: "What is Bir?" },
    expected: "An observability SDK",
    output: "Bir is an observability SDK.",
    scores: [{ name: "contains", value: 1, metadata: { expected: "observability" } }],
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:01+00:00",
    duration_ms: 1000,
    status: "success",
    error: null,
    ...overrides,
  };
}

function makeLoadedExperiment({
  summary = makeExperimentSummary(),
  results = [makeExperimentResult()],
}: {
  summary?: Record<string, unknown>;
  results?: Record<string, unknown>[];
} = {}) {
  const experiment = normalizeExperiment({ ...summary, results });
  assert.ok(experiment);
  return experiment;
}

function generationEvent(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    schema_version: "1.0",
    id: "generation",
    trace_id: "trace",
    parent_id: "trace",
    name: "playground.llm",
    type: "generation",
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:00+00:00",
    status: "success",
    metadata: {},
    input: null,
    output: null,
    error: null,
    ...overrides,
  };
}

function summarizableTrace(options: {
  id: string;
  status?: EventStatus;
  start?: string;
  end?: string;
  generations?: TraceEvent[];
}): Trace {
  const start = options.start ?? "2026-01-01T00:00:00+00:00";
  const end = options.end ?? start;
  const status = options.status ?? "success";
  const root: TraceEvent = {
    schema_version: "1.0",
    id: options.id,
    trace_id: options.id,
    parent_id: null,
    name: "workflow",
    type: "trace",
    start_time: start,
    end_time: end,
    status,
    metadata: {},
    input: null,
    output: null,
    error: null,
  };
  return {
    id: options.id,
    name: "workflow",
    start_time: start,
    end_time: end,
    status,
    events: [root, ...(options.generations ?? [])],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
