"use client";

import type { ExperimentSummary } from "../experiment-contract";
import { formatAggregateScores } from "./format";
import { statusLabels } from "./labels";
import { PanelHead, TraceSkeleton } from "./primitives";

export function ExperimentList({
  apiBaseUrl,
  error,
  experiments,
  isLoading,
  selectedExperimentId,
  setSelectedExperimentId,
}: {
  apiBaseUrl: string;
  error: string | null;
  experiments: ExperimentSummary[];
  isLoading: boolean;
  selectedExperimentId: string | null;
  setSelectedExperimentId: (experimentId: string) => void;
}) {
  return (
    <aside className="trace-list" aria-label="Experiments">
      <PanelHead title="Experiments" subtitle={apiBaseUrl} />
      {error ? <div className="state-box error-state">{error}</div> : null}
      {!error && !isLoading && experiments.length === 0 ? (
        <div className="state-box">No experiments found.</div>
      ) : null}
      {isLoading && experiments.length === 0 ? <TraceSkeleton /> : null}

      <div className="trace-items">
        {experiments.map((experiment) => (
          <button
            className={experiment.experiment_id === selectedExperimentId ? "trace-row active" : "trace-row"}
            key={experiment.experiment_id}
            type="button"
            onClick={() => setSelectedExperimentId(experiment.experiment_id)}
          >
            <span className={`status-dot ${experiment.status}`} aria-hidden="true" />
            <span className="trace-row-main">
              <span className="trace-name">{experiment.name}</span>
              <span className="trace-meta">
                {experiment.example_count} examples · {formatAggregateScores(experiment.aggregate_scores)}
              </span>
            </span>
            <span className={`status-pill ${experiment.status}`}>{statusLabels[experiment.status]}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
