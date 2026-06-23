"use client";

import { useState } from "react";

import {
  filterFailedResults,
  type ExperimentComparison,
  type ExperimentExampleResult,
  type ExperimentSummary,
  type LoadedExperiment,
} from "../experiment-contract";
import { formatDate, formatDuration, formatNumber } from "./format";
import { statusLabels } from "./labels";
import { Fact, InlineField, Payload, TraceSkeleton } from "./primitives";
import { ExperimentComparisonControls, ExperimentComparisonPanel } from "./experiment-comparison";

export function ExperimentDetailPanel({
  comparison,
  comparisonBaselineId,
  comparisonCandidateId,
  detailError,
  detail,
  experiments,
  isComparisonLoading,
  isDetailLoading,
  isTraceLoading,
  missingLinkedTraceId,
  onOpenTrace,
  selectedExperiment,
  setComparisonBaselineId,
  setComparisonCandidateId,
}: {
  comparison: ExperimentComparison | null;
  comparisonBaselineId: string | null;
  comparisonCandidateId: string | null;
  detailError: string | null;
  detail: ExperimentSummary | null;
  experiments: ExperimentSummary[];
  isComparisonLoading: boolean;
  isDetailLoading: boolean;
  isTraceLoading: boolean;
  missingLinkedTraceId: string | null;
  onOpenTrace: (traceId: string) => void;
  selectedExperiment: LoadedExperiment | null;
  setComparisonBaselineId: (experimentId: string) => void;
  setComparisonCandidateId: (experimentId: string) => void;
}) {
  return (
    <section className="detail-panel" aria-label="Experiment details">
      {detail ? (
        <>
          <div className="detail-head">
            <div>
              <p className="eyebrow">Experiment Detail</p>
              <h2>{detail.name}</h2>
              <p className="subtle">{detail.experiment_id}</p>
            </div>
            <div className="detail-facts">
              <Fact label="Status" value={statusLabels[detail.status]} tone={detail.status} />
              <Fact label="Duration" value={formatDuration(detail.start_time, detail.end_time)} />
              <Fact label="Started" value={formatDate(detail.start_time)} />
            </div>
          </div>

          <div className="experiment-detail">
            {experiments.length >= 2 ? (
              <>
                <ExperimentComparisonControls
                  baselineId={comparisonBaselineId}
                  candidateId={comparisonCandidateId}
                  experiments={experiments}
                  setBaselineId={setComparisonBaselineId}
                  setCandidateId={setComparisonCandidateId}
                />
                {isComparisonLoading && !comparison ? <TraceSkeleton /> : null}
                {comparison ? <ExperimentComparisonPanel comparison={comparison} /> : null}
              </>
            ) : null}

            <section className="score-grid" aria-label="Aggregate scores">
              {Object.entries(detail.aggregate_scores).length > 0 ? (
                Object.entries(detail.aggregate_scores).map(([name, value]) => (
                  <InlineField label={name} value={formatNumber(value)} key={name} />
                ))
              ) : (
                <span className="subtle">No aggregate scores.</span>
              )}
            </section>

            {isDetailLoading && !selectedExperiment ? <TraceSkeleton /> : null}
            {detailError ? <div className="error-block">{detailError}</div> : null}
            {selectedExperiment ? (
              <ExperimentResultList
                isTraceLoading={isTraceLoading}
                missingLinkedTraceId={missingLinkedTraceId}
                onOpenTrace={onOpenTrace}
                results={selectedExperiment.results}
              />
            ) : !isDetailLoading && !detailError ? (
              <div className="empty-detail">No experiment detail loaded.</div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="empty-detail">No experiment selected.</div>
      )}
    </section>
  );
}

// Per-example result list with a one-click "Failed only" triage toggle that
// mirrors the trace list's "Errors only" shortcut. Filtering runs through the
// pure filterFailedResults helper so the rule stays unit-testable; when the
// toggle is on and nothing failed we show a small empty state instead of an
// empty list.
function ExperimentResultList({
  isTraceLoading,
  missingLinkedTraceId,
  onOpenTrace,
  results,
}: {
  isTraceLoading: boolean;
  missingLinkedTraceId: string | null;
  onOpenTrace: (traceId: string) => void;
  results: ExperimentExampleResult[];
}) {
  const [failedOnly, setFailedOnly] = useState(false);
  const visibleResults = failedOnly ? filterFailedResults(results) : results;

  return (
    <>
      <section className="trace-triage" aria-label="Experiment triage">
        <div className="filter-group">
          <span>Triage</span>
          <button
            aria-pressed={failedOnly}
            className={failedOnly ? "triage-toggle active" : "triage-toggle"}
            title={failedOnly ? "Showing failed examples only — click to clear" : "Show failed examples only"}
            type="button"
            onClick={() => setFailedOnly((previous) => !previous)}
          >
            Failed only
          </button>
        </div>
      </section>

      {failedOnly && visibleResults.length === 0 ? (
        <div className="empty-detail">No failed examples.</div>
      ) : (
        <div className="experiment-results">
          {visibleResults.map((result) => {
            const traceId = result.trace_id ?? null;
            const isLinkedTraceMissing = traceId !== null && missingLinkedTraceId === traceId && !isTraceLoading;

            return (
              <ExperimentResultRow
                hasLinkedTrace={traceId !== null}
                isLinkedTraceMissing={isLinkedTraceMissing}
                onOpenTrace={onOpenTrace}
                result={result}
                key={result.id}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function ExperimentResultRow({
  hasLinkedTrace,
  isLinkedTraceMissing,
  onOpenTrace,
  result,
}: {
  hasLinkedTrace: boolean;
  isLinkedTraceMissing: boolean;
  onOpenTrace: (traceId: string) => void;
  result: ExperimentExampleResult;
}) {
  const hasInput = result.input !== null && result.input !== undefined;
  const hasExpected = result.expected !== null && result.expected !== undefined;
  const hasOutput = result.output !== null && result.output !== undefined;
  const traceId = result.trace_id ?? null;

  return (
    <article className="experiment-result">
      <div className="event-title-line">
        <div>
          <span className="event-type">Example</span>
          <h3>{result.example_id}</h3>
        </div>
        <div className="event-badges">
          <span className={`status-pill ${result.status}`}>{statusLabels[result.status]}</span>
          <span className="duration-pill">{formatDuration(result.start_time, result.end_time)}</span>
        </div>
      </div>

      <div className="event-fields">
        {traceId ? <InlineField label="Trace" value={traceId} /> : null}
        {hasLinkedTrace && traceId ? (
          <button className="inline-action" type="button" onClick={() => onOpenTrace(traceId)}>
            Open trace
          </button>
        ) : null}
        {result.scores.map((score) => (
          <InlineField label={score.name} value={formatNumber(score.value)} key={score.name} />
        ))}
      </div>

      {isLinkedTraceMissing ? (
        <p className="linked-trace-missing">Trace detail was not found or was invalid. Retry after refreshing traces.</p>
      ) : null}
      {result.error ? <pre className="error-block">{result.error}</pre> : null}

      <div className="payload-grid">
        {hasInput ? <Payload title="Input" value={result.input} /> : null}
        {hasExpected ? <Payload title="Expected" value={result.expected} /> : null}
        {hasOutput ? <Payload title="Output" value={result.output} /> : null}
        {result.scores.length > 0 ? <Payload title="Scores" value={result.scores} /> : null}
      </div>
    </article>
  );
}
