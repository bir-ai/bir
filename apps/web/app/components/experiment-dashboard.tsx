"use client";

import type {
  ExperimentComparison,
  ExperimentSummary,
  LoadedExperiment,
} from "../experiment-contract";
import { ExperimentDetailPanel } from "./experiment-detail";
import { ExperimentList } from "./experiment-list";
import { Metric } from "./primitives";

export function ExperimentDashboard({
  apiBaseUrl,
  comparison,
  comparisonBaselineId,
  comparisonCandidateId,
  error,
  experiments,
  isComparisonLoading,
  isDetailLoading,
  isLoading,
  isTraceLoading,
  missingLinkedTraceId,
  onOpenTrace,
  selectedExperiment,
  selectedExperimentId,
  setComparisonBaselineId,
  setComparisonCandidateId,
  setSelectedExperimentId,
  stats,
}: {
  apiBaseUrl: string;
  comparison: ExperimentComparison | null;
  comparisonBaselineId: string | null;
  comparisonCandidateId: string | null;
  error: string | null;
  experiments: ExperimentSummary[];
  isComparisonLoading: boolean;
  isDetailLoading: boolean;
  isLoading: boolean;
  isTraceLoading: boolean;
  missingLinkedTraceId: string | null;
  onOpenTrace: (traceId: string) => void;
  selectedExperiment: LoadedExperiment | null;
  selectedExperimentId: string | null;
  setComparisonBaselineId: (experimentId: string) => void;
  setComparisonCandidateId: (experimentId: string) => void;
  setSelectedExperimentId: (experimentId: string) => void;
  stats: { exampleCount: number; errorCount: number; scoreCount: number };
}) {
  const selectedSummary = experiments.find((experiment) => experiment.experiment_id === selectedExperimentId) ?? null;
  const detail = selectedExperiment ?? selectedSummary;

  return (
    <>
      <section className="metric-strip" aria-label="Experiment summary">
        <Metric label="Experiments" value={experiments.length.toString()} />
        <Metric label="Examples" value={stats.exampleCount.toString()} />
        <Metric label="Scores" value={stats.scoreCount.toString()} />
        <Metric label="Errors" value={stats.errorCount.toString()} tone={stats.errorCount > 0 ? "bad" : "good"} />
      </section>

      <section className="workspace">
        <ExperimentList
          apiBaseUrl={apiBaseUrl}
          error={error}
          experiments={experiments}
          isLoading={isLoading}
          selectedExperimentId={selectedExperimentId}
          setSelectedExperimentId={setSelectedExperimentId}
        />

        <ExperimentDetailPanel
          comparison={comparison}
          comparisonBaselineId={comparisonBaselineId}
          comparisonCandidateId={comparisonCandidateId}
          detail={detail}
          experiments={experiments}
          isComparisonLoading={isComparisonLoading}
          isDetailLoading={isDetailLoading}
          isTraceLoading={isTraceLoading}
          missingLinkedTraceId={missingLinkedTraceId}
          onOpenTrace={onOpenTrace}
          selectedExperiment={selectedExperiment}
          setComparisonBaselineId={setComparisonBaselineId}
          setComparisonCandidateId={setComparisonCandidateId}
        />
      </section>
    </>
  );
}
