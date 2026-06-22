import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { filterFailedResults, normalizeExperiment, type ExperimentExampleResult } from "./experiment-contract";

test("normalizes the shared valid experiment fixture", () => {
  const fixturePath = path.resolve(process.cwd(), "../../tests/fixtures/valid-experiment.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
    summary: Record<string, unknown>;
    results: unknown[];
  };

  const experiment = normalizeExperiment({ ...fixture.summary, results: fixture.results });

  assert.ok(experiment);
  assert.equal(experiment.example_count, 2);
  assert.equal(experiment.error_count, 1);
  assert.deepEqual(experiment.results.map((result) => result.example_id), ["question-1", "question-2"]);
});

test("rejects internally inconsistent experiment details", () => {
  const result = makeResult({});
  const summary = makeSummary();

  assert.equal(normalizeExperiment({ ...summary, example_count: 2, results: [result] }), null);
  assert.equal(normalizeExperiment({ ...summary, error_count: 1, results: [result] }), null);
  assert.equal(
    normalizeExperiment({
      ...summary,
      example_count: 2,
      results: [result, { ...result, example_id: "q2" }],
    }),
    null,
  );
  assert.equal(
    normalizeExperiment({ ...summary, example_count: 2, results: [result, { ...result, id: "result-2" }] }),
    null,
  );
  assert.equal(normalizeExperiment({ ...summary, results: [{ ...result, duration_ms: -1 }] }), null);
});

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

function makeSummary(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    experiment_id: "experiment-1",
    name: "prompt-v1",
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:01+00:00",
    status: "success",
    example_count: 1,
    error_count: 0,
    aggregate_scores: {},
    result_path: "prompt-v1-experiment-1.jsonl",
  };
}
