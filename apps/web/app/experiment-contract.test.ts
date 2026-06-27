import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  compareExperiments,
  filterFailedResults,
  normalizeExperiment,
  normalizeExperimentDetail,
  type EvalScore,
  type ExperimentExampleResult,
  type ExperimentStatus,
  type LoadedExperiment,
} from "./experiment-contract";

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

test("normalizes SDK concurrent experiment rows without reordering linked traces", () => {
  const experiment = normalizeExperiment(loadProductExperimentFixture("concurrent-order-experiment-sdk-concurrent"));

  assert.ok(experiment);
  assert.deepEqual(
    experiment.results.map((result) => result.example_id),
    ["q0", "q1", "q2"],
  );
  assert.ok(experiment.results[0].start_time > experiment.results[1].start_time);
  assert.deepEqual(
    experiment.results.map((result) => result.trace_id),
    ["trace-sdk-concurrent-q0", "trace-sdk-concurrent-q1", "trace-sdk-concurrent-q2"],
  );
  assert.deepEqual(experiment.results[2].input, { api_key: "[redacted]", question: "2" });
  assert.deepEqual(experiment.results[2].scores[0]?.metadata, { api_key: "[redacted]" });
});

test("normalizes SDK raise-on-error partial experiment rows", () => {
  const experiment = normalizeExperiment(loadProductExperimentFixture("raise-on-error-experiment-sdk-partial"));

  assert.ok(experiment);
  assert.equal(experiment.status, "error");
  assert.equal(experiment.example_count, 2);
  assert.equal(experiment.error_count, 1);
  assert.deepEqual(
    experiment.results.map((result) => [result.example_id, result.status, result.trace_id]),
    [
      ["q0", "success", "trace-sdk-partial-q0"],
      ["q1", "error", "trace-sdk-partial-q1"],
    ],
  );
  assert.equal(experiment.results[1].error, "provider failed token=[redacted]");
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

test("reports an explicit error result for malformed experiment detail", () => {
  const result = makeResult({});
  const summary = makeSummary();

  assert.deepEqual(normalizeExperimentDetail({ ...summary, example_count: 2, results: [result] }), {
    kind: "invalid",
    message: "Bir server returned an unexpected experiment detail.",
  });
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

test("comparison reads a higher score as improved and a lower score as regressed", () => {
  // Mirrors the SDK's compare_experiments: score direction is quality direction.
  const baseline = experimentFrom([
    scoredResult("q1", [evalScore("faithfulness", 0.5)]),
    scoredResult("q2", [evalScore("faithfulness", 0.8)]),
  ]);
  const candidate = experimentFrom([
    scoredResult("q1", [evalScore("faithfulness", 0.9)]),
    scoredResult("q2", [evalScore("faithfulness", 0.4)]),
  ]);

  const statuses = statusByExample(compareExperiments(baseline, candidate));

  assert.equal(statuses.get("q1"), "improved");
  assert.equal(statuses.get("q2"), "regressed");
});

test("comparison marks mixed-direction scores as changed and equal scores as unchanged", () => {
  const baseline = experimentFrom([
    scoredResult("q1", [evalScore("a", 0.5), evalScore("b", 0.5)]),
    scoredResult("q2", [evalScore("a", 0.5)]),
  ]);
  const candidate = experimentFrom([
    scoredResult("q1", [evalScore("a", 0.9), evalScore("b", 0.1)]),
    scoredResult("q2", [evalScore("a", 0.5)]),
  ]);

  const statuses = statusByExample(compareExperiments(baseline, candidate));

  assert.equal(statuses.get("q1"), "changed");
  assert.equal(statuses.get("q2"), "unchanged");
});

test("comparison keeps execution-transition and row-presence statuses ahead of score direction", () => {
  const baseline = experimentFrom([
    scoredResult("q1", [evalScore("a", 0.5)], "success"),
    scoredResult("q2", [evalScore("a", 0.5)], "error"),
    scoredResult("q3", [evalScore("a", 0.5)]),
  ]);
  const candidate = experimentFrom([
    scoredResult("q1", [evalScore("a", 0.5)], "error"),
    scoredResult("q2", [evalScore("a", 0.5)], "success"),
    scoredResult("q4", [evalScore("a", 0.5)]),
  ]);

  const statuses = statusByExample(compareExperiments(baseline, candidate));

  assert.equal(statuses.get("q1"), "regressed"); // success -> error
  assert.equal(statuses.get("q2"), "improved"); // error -> success
  assert.equal(statuses.get("q3"), "missing_candidate");
  assert.equal(statuses.get("q4"), "new_candidate");
});

function statusByExample(comparison: ReturnType<typeof compareExperiments>): Map<string, string> {
  return new Map(comparison.rows.map((row) => [row.example_id, row.status]));
}

function evalScore(name: string, value: number): EvalScore {
  return { name, value, metadata: {} };
}

function scoredResult(
  exampleId: string,
  scores: EvalScore[],
  status: ExperimentStatus = "success",
): ExperimentExampleResult {
  return makeResult({ id: `result-${exampleId}`, example_id: exampleId, scores, status });
}

function experimentFrom(results: ExperimentExampleResult[]): LoadedExperiment {
  return {
    schema_version: "1.0",
    experiment_id: "experiment-1",
    name: "prompt-v1",
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:01+00:00",
    status: "success",
    example_count: results.length,
    error_count: results.filter((result) => result.status === "error").length,
    aggregate_scores: {},
    result_path: "prompt-v1-experiment-1.jsonl",
    results,
  };
}

function loadProductExperimentFixture(stem: string): unknown {
  const fixturesDir = path.resolve(process.cwd(), "../../tests/product-fixtures");
  const summary = JSON.parse(readFileSync(path.join(fixturesDir, `${stem}.summary.json`), "utf-8")) as Record<
    string,
    unknown
  >;
  const results = readFileSync(path.join(fixturesDir, `${stem}.jsonl`), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  return { ...summary, results };
}

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
