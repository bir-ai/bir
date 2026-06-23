import type {
  ExperimentComparisonStatus,
  ExperimentStatus,
} from "../experiment-contract";
import type { EventStatus, EventType, TraceFilterValues, TraceScoreGroupKey, TraceSort } from "../trace-contract";

export const statusLabels: Record<EventStatus | ExperimentStatus, string> = {
  success: "Success",
  error: "Error",
};

export const comparisonStatusLabels: Record<ExperimentComparisonStatus, string> = {
  regressed: "Regressed",
  improved: "Improved",
  changed: "Changed",
  unchanged: "Unchanged",
  missing_candidate: "Missing candidate",
  new_candidate: "New candidate",
};

export const typeLabels: Record<EventType, string> = {
  trace: "Trace",
  span: "Span",
  generation: "Generation",
  tool_call: "Tool Call",
  score: "Score",
};

export const sortLabels: Record<TraceSort, string> = {
  recent: "Recent",
  slowest: "Slowest",
};

export const scoreGroupLabels: Record<TraceScoreGroupKey, string> = {
  faithfulness: "Faithfulness & RAG quality",
  other: "Other scores",
};

export const DEFAULT_TRACE_FILTERS: TraceFilterValues = {
  status: "all",
  name: "",
  event_type: "all",
  source: "",
  service: "",
  environment: "",
  sort: "recent",
};
