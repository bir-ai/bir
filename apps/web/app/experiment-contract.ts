export type ExperimentStatus = "success" | "error";

export type EvalScore = {
  name: string;
  value: number;
  metadata: Record<string, unknown>;
};

export type ExperimentExampleResult = {
  id: string;
  example_id: string;
  trace_id?: string | null;
  input: unknown;
  expected: unknown;
  output: unknown;
  scores: EvalScore[];
  start_time: string;
  end_time: string;
  duration_ms?: number | null;
  status: ExperimentStatus;
  error: string | null;
};

export type ExperimentSummary = {
  schema_version: "1.0";
  experiment_id: string;
  name: string;
  start_time: string;
  end_time: string;
  status: ExperimentStatus;
  example_count: number;
  error_count: number;
  aggregate_scores: Record<string, number>;
  result_path: string;
};

export type LoadedExperiment = ExperimentSummary & {
  results: ExperimentExampleResult[];
};

export type ExperimentComparisonStatus =
  | "regressed"
  | "improved"
  | "unchanged"
  | "missing_candidate"
  | "new_candidate";

export type ExperimentScoreDelta = {
  name: string;
  baseline_value: number | null;
  candidate_value: number | null;
  delta: number | null;
};

export type ExperimentComparisonRow = {
  example_id: string;
  status: ExperimentComparisonStatus;
  baseline_result: ExperimentExampleResult | null;
  candidate_result: ExperimentExampleResult | null;
  scores: ExperimentScoreDelta[];
};

export type ExperimentComparison = {
  baseline: LoadedExperiment;
  candidate: LoadedExperiment;
  aggregate_scores: ExperimentScoreDelta[];
  rows: ExperimentComparisonRow[];
  counts: Record<ExperimentComparisonStatus, number>;
};

export function normalizeExperimentSummaries(value: unknown): ExperimentSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isExperimentSummary).sort((a, b) => b.start_time.localeCompare(a.start_time));
}

export function normalizeExperiment(value: unknown): LoadedExperiment | null {
  if (!isLoadedExperiment(value)) {
    return null;
  }
  return value;
}

// One-click triage for the experiment detail view: narrow the rendered example
// rows down to failed runs (status "error") so a failing experiment is easy to
// scan, mirroring the trace list's errors-only shortcut. The input order is
// preserved, so the filtered view matches the order of the full list.
export function filterFailedResults(results: ExperimentExampleResult[]): ExperimentExampleResult[] {
  return results.filter((result) => result.status === "error");
}

export function compareExperiments(baseline: LoadedExperiment, candidate: LoadedExperiment): ExperimentComparison {
  const rows = buildComparisonRows(baseline.results, candidate.results).sort(compareRows);
  const counts = emptyComparisonCounts();
  for (const row of rows) {
    counts[row.status] += 1;
  }

  return {
    baseline,
    candidate,
    aggregate_scores: compareScoreRecords(baseline.aggregate_scores, candidate.aggregate_scores),
    rows,
    counts,
  };
}

function buildComparisonRows(
  baselineResults: ExperimentExampleResult[],
  candidateResults: ExperimentExampleResult[],
): ExperimentComparisonRow[] {
  const baselineByExampleId = new Map(baselineResults.map((result) => [result.example_id, result]));
  const candidateByExampleId = new Map(candidateResults.map((result) => [result.example_id, result]));
  const exampleIds = new Set([...baselineByExampleId.keys(), ...candidateByExampleId.keys()]);

  return [...exampleIds].map((exampleId) => {
    const baselineResult = baselineByExampleId.get(exampleId) ?? null;
    const candidateResult = candidateByExampleId.get(exampleId) ?? null;
    const scores = compareScores(baselineResult?.scores ?? [], candidateResult?.scores ?? []);
    return {
      example_id: exampleId,
      status: comparisonStatus(baselineResult, candidateResult, scores),
      baseline_result: baselineResult,
      candidate_result: candidateResult,
      scores,
    };
  });
}

function compareScoreRecords(
  baselineScores: Record<string, number>,
  candidateScores: Record<string, number>,
): ExperimentScoreDelta[] {
  return [...new Set([...Object.keys(baselineScores), ...Object.keys(candidateScores)])]
    .sort()
    .map((name) => scoreDelta(name, baselineScores[name], candidateScores[name]));
}

function compareScores(baselineScores: EvalScore[], candidateScores: EvalScore[]): ExperimentScoreDelta[] {
  const baselineByName = new Map(baselineScores.map((score) => [score.name, score.value]));
  const candidateByName = new Map(candidateScores.map((score) => [score.name, score.value]));
  return [...new Set([...baselineByName.keys(), ...candidateByName.keys()])]
    .sort()
    .map((name) => scoreDelta(name, baselineByName.get(name), candidateByName.get(name)));
}

function scoreDelta(name: string, baselineValue: number | undefined, candidateValue: number | undefined): ExperimentScoreDelta {
  const baseline_value = baselineValue ?? null;
  const candidate_value = candidateValue ?? null;
  return {
    name,
    baseline_value,
    candidate_value,
    delta: baseline_value === null || candidate_value === null ? null : candidate_value - baseline_value,
  };
}

function comparisonStatus(
  baselineResult: ExperimentExampleResult | null,
  candidateResult: ExperimentExampleResult | null,
  scores: ExperimentScoreDelta[],
): ExperimentComparisonStatus {
  if (baselineResult === null) {
    return "new_candidate";
  }
  if (candidateResult === null) {
    return "missing_candidate";
  }
  const deltas = scores.map((score) => score.delta).filter((delta): delta is number => delta !== null);
  if (deltas.some((delta) => delta < 0)) {
    return "regressed";
  }
  if (deltas.some((delta) => delta > 0)) {
    return "improved";
  }
  return "unchanged";
}

function compareRows(left: ExperimentComparisonRow, right: ExperimentComparisonRow): number {
  const statusOrder: Record<ExperimentComparisonStatus, number> = {
    regressed: 0,
    missing_candidate: 1,
    new_candidate: 2,
    improved: 3,
    unchanged: 4,
  };
  return statusOrder[left.status] - statusOrder[right.status] || left.example_id.localeCompare(right.example_id);
}

function emptyComparisonCounts(): Record<ExperimentComparisonStatus, number> {
  return {
    regressed: 0,
    improved: 0,
    unchanged: 0,
    missing_candidate: 0,
    new_candidate: 0,
  };
}

function isLoadedExperiment(value: unknown): value is LoadedExperiment {
  if (!isExperimentSummary(value) || !isRecord(value)) {
    return false;
  }
  const candidate = value as ExperimentSummary & { results?: unknown };
  if (!Array.isArray(candidate.results) || !candidate.results.every(isExperimentExampleResult)) {
    return false;
  }
  const results = candidate.results as ExperimentExampleResult[];
  return (
    candidate.example_count === results.length &&
    candidate.error_count === results.filter((result) => result.status === "error").length &&
    hasUniqueValues(results.map((result) => result.id)) &&
    hasUniqueValues(results.map((result) => result.example_id))
  );
}

function isExperimentSummary(value: unknown): value is ExperimentSummary {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schema_version === "1.0" &&
    typeof value.experiment_id === "string" &&
    typeof value.name === "string" &&
    typeof value.start_time === "string" &&
    typeof value.end_time === "string" &&
    isStatus(value.status) &&
    isNonNegativeInteger(value.example_count) &&
    isNonNegativeInteger(value.error_count) &&
    isNumberRecord(value.aggregate_scores) &&
    typeof value.result_path === "string"
  );
}

function isExperimentExampleResult(value: unknown): value is ExperimentExampleResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.example_id === "string" &&
    (typeof value.trace_id === "string" || value.trace_id === null || value.trace_id === undefined) &&
    Array.isArray(value.scores) &&
    value.scores.every(isEvalScore) &&
    typeof value.start_time === "string" &&
    typeof value.end_time === "string" &&
    (value.duration_ms === null || value.duration_ms === undefined || isNonNegativeFiniteNumber(value.duration_ms)) &&
    isStatus(value.status) &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isEvalScore(value: unknown): value is EvalScore {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.name === "string" && typeof value.value === "number" && isRecord(value.metadata);
}

function isStatus(value: unknown): value is ExperimentStatus {
  return value === "success" || value === "error";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasUniqueValues(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
