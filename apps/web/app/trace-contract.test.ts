import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTraceTimelineRows,
  normalizeTraces,
  type Trace,
  type TraceEvent,
} from "./trace-contract";
import { contractTraceResponseFixture } from "./trace-contract.fixture";

const [contractTrace] = contractTraceResponseFixture;

test("normalizes valid trace responses from the shared contract fixture", () => {
  const traces = normalizeTraces(contractTraceResponseFixture);

  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, "trace-fixture-1");
  assert.deepEqual(
    traces[0].events.map((event) => event.type),
    ["trace", "span", "tool_call", "generation", "score"],
  );
  const generationEvent = traces[0].events.find((event) => event.type === "generation");
  assert.deepEqual(generationEvent?.cost, { input_cost: 0.000012, output_cost: 0.000048, total_cost: 0.00006 });
  assert.equal(generationEvent?.currency, "USD");
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
  const orphanEvent: TraceEvent = {
    ...contractTrace.events[1],
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
