"use client";

import type {
  ExperimentComparison,
  ExperimentComparisonStatus,
  ExperimentSummary,
} from "../experiment-contract";
import { formatComparisonScore } from "./format";
import { comparisonStatusLabels } from "./labels";
import { InlineField } from "./primitives";

export function ExperimentComparisonControls({
  baselineId,
  candidateId,
  experiments,
  setBaselineId,
  setCandidateId,
}: {
  baselineId: string | null;
  candidateId: string | null;
  experiments: ExperimentSummary[];
  setBaselineId: (experimentId: string) => void;
  setCandidateId: (experimentId: string) => void;
}) {
  return (
    <section className="comparison-controls trace-filters" aria-label="Experiment comparison controls">
      <label className="filter-group">
        <span>Baseline</span>
        <select
          value={baselineId ?? ""}
          onChange={(event) => setBaselineId(event.target.value)}
        >
          {experiments.map((experiment) => (
            <option
              disabled={experiment.experiment_id === candidateId}
              value={experiment.experiment_id}
              key={experiment.experiment_id}
            >
              {experiment.name}
            </option>
          ))}
        </select>
      </label>

      <label className="filter-group">
        <span>Candidate</span>
        <select
          value={candidateId ?? ""}
          onChange={(event) => setCandidateId(event.target.value)}
        >
          {experiments.map((experiment) => (
            <option
              disabled={experiment.experiment_id === baselineId}
              value={experiment.experiment_id}
              key={experiment.experiment_id}
            >
              {experiment.name}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

export function ExperimentComparisonPanel({ comparison }: { comparison: ExperimentComparison }) {
  return (
    <section className="comparison-panel" aria-label="Experiment comparison">
      <div className="event-title-line">
        <div>
          <span className="event-type">Comparison</span>
          <h3>
            {comparison.baseline.name} to {comparison.candidate.name}
          </h3>
        </div>
      </div>

      <div className="event-fields">
        {Object.entries(comparison.counts).map(([status, count]) => (
          <InlineField
            label={comparisonStatusLabels[status as ExperimentComparisonStatus]}
            value={count.toString()}
            key={status}
          />
        ))}
      </div>

      <section className="score-grid comparison-score-grid" aria-label="Aggregate score deltas">
        {comparison.aggregate_scores.length > 0 ? (
          comparison.aggregate_scores.map((score) => (
            <InlineField
              label={score.name}
              value={formatComparisonScore(score.baseline_value, score.candidate_value, score.delta)}
              key={score.name}
            />
          ))
        ) : (
          <span className="subtle">No aggregate scores to compare.</span>
        )}
      </section>

      <div className="comparison-results">
        {comparison.rows.map((row) => (
          <article className={`comparison-row ${row.status}`} key={row.example_id}>
            <div className="event-title-line">
              <div>
                <span className="event-type">Example</span>
                <h3>{row.example_id}</h3>
              </div>
              <div className="event-badges">
                <span className={`comparison-pill ${row.status}`}>{comparisonStatusLabels[row.status]}</span>
              </div>
            </div>
            <div className="event-fields">
              {row.scores.length > 0 ? (
                row.scores.map((score) => (
                  <InlineField
                    label={score.name}
                    value={formatComparisonScore(score.baseline_value, score.candidate_value, score.delta)}
                    key={score.name}
                  />
                ))
              ) : (
                <span className="subtle">No scores to compare.</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
