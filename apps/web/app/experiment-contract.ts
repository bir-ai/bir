export type ExperimentStatus = "success" | "error";

export type EvalScore = {
  name: string;
  value: number;
  metadata: Record<string, unknown>;
};

export type ExperimentExampleResult = {
  id: string;
  example_id: string;
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

function isLoadedExperiment(value: unknown): value is LoadedExperiment {
  if (!isExperimentSummary(value) || !isRecord(value)) {
    return false;
  }
  const candidate = value as ExperimentSummary & { results?: unknown };
  return Array.isArray(candidate.results) && candidate.results.every(isExperimentExampleResult);
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
    Array.isArray(value.scores) &&
    value.scores.every(isEvalScore) &&
    typeof value.start_time === "string" &&
    typeof value.end_time === "string" &&
    (typeof value.duration_ms === "number" || value.duration_ms === null || value.duration_ms === undefined) &&
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

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
