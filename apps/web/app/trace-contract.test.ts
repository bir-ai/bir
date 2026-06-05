import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildTraceTimelineRows,
  getRetrievalDetails,
  normalizeTraces,
  type Trace,
  type TraceEvent,
} from "./trace-contract";
import { normalizeExperiment, normalizeExperimentSummaries } from "./experiment-contract";

const contractTraceResponseFixture = loadSharedContractTraceResponse();
const [contractTrace] = normalizeTraces(contractTraceResponseFixture);
assert.ok(contractTrace);

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
    results: [makeExperimentResult({ trace_id: "trace-1" })],
  });

  assert.ok(experiment);
  assert.equal(experiment.experiment_id, "experiment-1");
  assert.equal(experiment.results[0].example_id, "q1");
  assert.equal(experiment.results[0].trace_id, "trace-1");
  assert.deepEqual(experiment.results[0].scores, [{ name: "contains", value: 1, metadata: { expected: "observability" } }]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
