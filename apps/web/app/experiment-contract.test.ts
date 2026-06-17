import assert from "node:assert/strict";
import test from "node:test";

import { filterFailedResults, type ExperimentExampleResult } from "./experiment-contract";

test("filterFailedResults returns only the error rows when active", () => {
  const results = [
    makeResult({ id: "r1", example_id: "q1", status: "success" }),
    makeResult({ id: "r2", example_id: "q2", status: "error" }),
    makeResult({ id: "r3", example_id: "q3", status: "success" }),
    makeResult({ id: "r4", example_id: "q4", status: "error" }),
  ];

  assert.deepEqual(
    filterFailedResults(results).map((result) => result.id),
    ["r2", "r4"],
  );
});

test("filterFailedResults preserves the input order of the failed rows", () => {
  // Intentionally unsorted ids: filtering must keep the original order, not reorder.
  const results = [
    makeResult({ id: "r3", example_id: "q3", status: "error" }),
    makeResult({ id: "r1", example_id: "q1", status: "error" }),
    makeResult({ id: "r2", example_id: "q2", status: "success" }),
  ];

  assert.deepEqual(
    filterFailedResults(results).map((result) => result.id),
    ["r3", "r1"],
  );
});

test("filterFailedResults returns an empty list when nothing failed", () => {
  const results = [
    makeResult({ id: "r1", example_id: "q1", status: "success" }),
    makeResult({ id: "r2", example_id: "q2", status: "success" }),
  ];

  assert.deepEqual(filterFailedResults(results), []);
  assert.deepEqual(filterFailedResults([]), []);
});

function makeResult(overrides: Partial<ExperimentExampleResult>): ExperimentExampleResult {
  return {
    id: "result-1",
    example_id: "q1",
    input: { question: "What is Bir?" },
    expected: "An observability SDK",
    output: "Bir is an observability SDK.",
    scores: [],
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:01+00:00",
    duration_ms: 1000,
    status: "success",
    error: null,
    ...overrides,
  };
}
