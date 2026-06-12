"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchExperimentDetail,
  fetchExperimentSummaries,
  fetchPlaygroundStatus,
  fetchTraces,
  getApiBaseUrl,
} from "./api-client";
import { ExperimentDashboard } from "./components/experiment-dashboard";
import { DEFAULT_TRACE_FILTERS } from "./components/labels";
import { PlaygroundDashboard } from "./components/playground";
import { TraceDashboard } from "./components/trace-dashboard";
import {
  compareExperiments,
  normalizeExperiment,
  normalizeExperimentSummaries,
  type ExperimentSummary,
  type LoadedExperiment,
} from "./experiment-contract";
import { normalizePlaygroundStatus, type PlaygroundStatus } from "./playground-contract";
import {
  buildTraceFilterQuery,
  buildTraceTimelineRows,
  findTraceById,
  normalizeTraces,
  type Trace,
  type TraceFilterValues,
} from "./trace-contract";

type ViewMode = "traces" | "experiments" | "playground";

async function getExperimentDetail(experimentId: string): Promise<LoadedExperiment | null> {
  return normalizeExperiment(await fetchExperimentDetail(experimentId));
}

export default function DashboardPage() {
  // Same-origin resolution needs the browser, so the prerendered HTML keeps a
  // stable placeholder and the real URL fills in after hydration.
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [activeView, setActiveView] = useState<ViewMode>("traces");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traceFilters, setTraceFilters] = useState<TraceFilterValues>(DEFAULT_TRACE_FILTERS);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [selectedExperiment, setSelectedExperiment] = useState<LoadedExperiment | null>(null);
  const [comparisonBaselineId, setComparisonBaselineId] = useState<string | null>(null);
  const [comparisonCandidateId, setComparisonCandidateId] = useState<string | null>(null);
  const [comparisonBaseline, setComparisonBaseline] = useState<LoadedExperiment | null>(null);
  const [comparisonCandidate, setComparisonCandidate] = useState<LoadedExperiment | null>(null);
  const [playgroundStatus, setPlaygroundStatus] = useState<PlaygroundStatus | null>(null);
  const [isTraceLoading, setIsTraceLoading] = useState(true);
  const [isExperimentLoading, setIsExperimentLoading] = useState(true);
  const [isExperimentDetailLoading, setIsExperimentDetailLoading] = useState(false);
  const [isComparisonLoading, setIsComparisonLoading] = useState(false);
  const [isPlaygroundStatusLoading, setIsPlaygroundStatusLoading] = useState(true);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [playgroundError, setPlaygroundError] = useState<string | null>(null);
  const [missingLinkedTraceId, setMissingLinkedTraceId] = useState<string | null>(null);

  const loadTraces = useCallback(async (filters: TraceFilterValues = traceFilters) => {
    setIsTraceLoading(true);
    setTraceError(null);

    try {
      const query = buildTraceFilterQuery(filters);
      const nextTraces = normalizeTraces(await fetchTraces(query));
      setTraces(nextTraces);
      setSelectedTraceId((current) => {
        if (current && nextTraces.some((trace) => trace.id === current)) {
          return current;
        }
        return nextTraces[0]?.id ?? null;
      });
      return nextTraces;
    } catch (requestError) {
      setTraceError(requestError instanceof Error ? requestError.message : "Trace request failed");
      setTraces([]);
      setSelectedTraceId(null);
      return [];
    } finally {
      setIsTraceLoading(false);
    }
  }, [traceFilters]);

  const loadExperiments = useCallback(async () => {
    setIsExperimentLoading(true);
    setExperimentError(null);

    try {
      const nextExperiments = normalizeExperimentSummaries(await fetchExperimentSummaries());
      setExperiments(nextExperiments);
      setSelectedExperimentId((current) => {
        if (current && nextExperiments.some((experiment) => experiment.experiment_id === current)) {
          return current;
        }
        return nextExperiments[0]?.experiment_id ?? null;
      });
    } catch (requestError) {
      setExperimentError(requestError instanceof Error ? requestError.message : "Experiment request failed");
      setExperiments([]);
      setSelectedExperimentId(null);
      setSelectedExperiment(null);
    } finally {
      setIsExperimentLoading(false);
    }
  }, []);

  const loadPlaygroundStatus = useCallback(async () => {
    setIsPlaygroundStatusLoading(true);
    setPlaygroundError(null);

    try {
      const status = normalizePlaygroundStatus(await fetchPlaygroundStatus());
      if (!status) {
        throw new Error("Bir server returned an unexpected playground status");
      }
      setPlaygroundStatus(status);
    } catch (requestError) {
      setPlaygroundError(requestError instanceof Error ? requestError.message : "Playground status request failed");
      setPlaygroundStatus(null);
    } finally {
      setIsPlaygroundStatusLoading(false);
    }
  }, []);

  const loadExperimentDetail = useCallback(async (experimentId: string) => {
    setIsExperimentDetailLoading(true);
    setExperimentError(null);

    try {
      setSelectedExperiment(await getExperimentDetail(experimentId));
    } catch (requestError) {
      setExperimentError(requestError instanceof Error ? requestError.message : "Experiment detail request failed");
      setSelectedExperiment(null);
    } finally {
      setIsExperimentDetailLoading(false);
    }
  }, []);

  const openTraceFromExperiment = useCallback(
    async (traceId: string) => {
      setMissingLinkedTraceId(null);

      if (findTraceById(traces, traceId)) {
        setSelectedTraceId(traceId);
        setActiveView("traces");
        return;
      }

      setTraceFilters(DEFAULT_TRACE_FILTERS);
      const refreshedTraces = await loadTraces(DEFAULT_TRACE_FILTERS);
      if (findTraceById(refreshedTraces, traceId)) {
        setSelectedTraceId(traceId);
        setActiveView("traces");
        return;
      }

      setMissingLinkedTraceId(traceId);
    },
    [loadTraces, traces],
  );

  const openTraceFromPlayground = useCallback(
    async (traceId: string) => {
      setMissingLinkedTraceId(null);
      setTraceFilters(DEFAULT_TRACE_FILTERS);
      const refreshedTraces = await loadTraces(DEFAULT_TRACE_FILTERS);
      setSelectedTraceId(traceId);
      setActiveView("traces");

      if (!findTraceById(refreshedTraces, traceId)) {
        setMissingLinkedTraceId(traceId);
      }
    },
    [loadTraces],
  );

  useEffect(() => {
    setApiBaseUrl(getApiBaseUrl());
  }, []);

  useEffect(() => {
    void loadTraces();
    void loadExperiments();
    void loadPlaygroundStatus();
  }, [loadExperiments, loadPlaygroundStatus, loadTraces]);

  useEffect(() => {
    if (selectedExperimentId) {
      void loadExperimentDetail(selectedExperimentId);
      return;
    }
    setSelectedExperiment(null);
  }, [loadExperimentDetail, selectedExperimentId]);

  useEffect(() => {
    if (experiments.length < 2) {
      setComparisonBaselineId(null);
      setComparisonCandidateId(null);
      setComparisonBaseline(null);
      setComparisonCandidate(null);
      setIsComparisonLoading(false);
      return;
    }

    const experimentIds = experiments.map((experiment) => experiment.experiment_id);
    const candidateId = comparisonCandidateId && experimentIds.includes(comparisonCandidateId)
      ? comparisonCandidateId
      : experimentIds[0];
    setComparisonCandidateId(candidateId);
    setComparisonBaselineId((current) => {
      if (current && current !== candidateId && experimentIds.includes(current)) {
        return current;
      }
      return experimentIds.find((experimentId) => experimentId !== candidateId) ?? null;
    });
  }, [comparisonCandidateId, experiments]);

  useEffect(() => {
    if (!comparisonBaselineId || !comparisonCandidateId || comparisonBaselineId === comparisonCandidateId) {
      setComparisonBaseline(null);
      setComparisonCandidate(null);
      setIsComparisonLoading(false);
      return;
    }

    let isCurrentRequest = true;
    setIsComparisonLoading(true);
    setExperimentError(null);

    void Promise.all([
      getExperimentDetail(comparisonBaselineId),
      getExperimentDetail(comparisonCandidateId),
    ])
      .then(([baseline, candidate]) => {
        if (!isCurrentRequest) {
          return;
        }
        setComparisonBaseline(baseline);
        setComparisonCandidate(candidate);
      })
      .catch((requestError) => {
        if (!isCurrentRequest) {
          return;
        }
        setExperimentError(requestError instanceof Error ? requestError.message : "Experiment comparison request failed");
        setComparisonBaseline(null);
        setComparisonCandidate(null);
      })
      .finally(() => {
        if (isCurrentRequest) {
          setIsComparisonLoading(false);
        }
      });

    return () => {
      isCurrentRequest = false;
    };
  }, [comparisonBaselineId, comparisonCandidateId]);

  const selectedTrace = useMemo(
    () => (selectedTraceId ? findTraceById(traces, selectedTraceId) : null) ?? traces[0] ?? null,
    [selectedTraceId, traces],
  );
  const timelineRows = useMemo(
    () => (selectedTrace ? buildTraceTimelineRows(selectedTrace.events) : []),
    [selectedTrace],
  );
  const hasActiveTraceFilters = buildTraceFilterQuery(traceFilters).length > 0;

  const traceStats = useMemo(() => {
    const eventCount = traces.reduce((total, trace) => total + trace.events.length, 0);
    const errorCount = traces.filter((trace) => trace.status === "error").length;
    const generationCount = traces.reduce(
      (total, trace) => total + trace.events.filter((event) => event.type === "generation").length,
      0,
    );
    return { eventCount, errorCount, generationCount };
  }, [traces]);

  const experimentStats = useMemo(() => {
    const exampleCount = experiments.reduce((total, experiment) => total + experiment.example_count, 0);
    const errorCount = experiments.reduce((total, experiment) => total + experiment.error_count, 0);
    const scoreCount = experiments.reduce(
      (total, experiment) => total + Object.keys(experiment.aggregate_scores).length,
      0,
    );
    return { exampleCount, errorCount, scoreCount };
  }, [experiments]);

  const experimentComparison = useMemo(
    () => (comparisonBaseline && comparisonCandidate ? compareExperiments(comparisonBaseline, comparisonCandidate) : null),
    [comparisonBaseline, comparisonCandidate],
  );

  const isActiveLoading =
    activeView === "traces"
      ? isTraceLoading
      : activeView === "experiments"
        ? isExperimentLoading || isExperimentDetailLoading || isComparisonLoading
        : isPlaygroundStatusLoading;
  const refreshActiveView = useCallback(() => {
    if (activeView === "traces") {
      void loadTraces();
      return;
    }
    if (activeView === "experiments") {
      void loadExperiments();
      return;
    }
    void loadPlaygroundStatus();
  }, [activeView, loadExperiments, loadPlaygroundStatus, loadTraces]);

  return (
    <main className="shell">
      <Image className="side-brand-mark" src="/bir_mark.png" alt="" width={109} height={1185} priority />
      <header className="topbar">
        <div className="brand-lockup" aria-label="bir">
          <h1>bir</h1>
        </div>
        <div className="topbar-actions">
          <div className="view-tabs" role="tablist" aria-label="Dashboard views">
            <button
              aria-selected={activeView === "traces"}
              className={activeView === "traces" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setActiveView("traces")}
            >
              Traces
            </button>
            <button
              aria-selected={activeView === "experiments"}
              className={activeView === "experiments" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setActiveView("experiments")}
            >
              Experiments
            </button>
            <button
              aria-selected={activeView === "playground"}
              className={activeView === "playground" ? "active" : ""}
              role="tab"
              type="button"
              onClick={() => setActiveView("playground")}
            >
              Playground
            </button>
          </div>
          <button className="refresh-button" type="button" onClick={refreshActiveView} disabled={isActiveLoading}>
            {isActiveLoading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      {activeView === "traces" ? (
        <TraceDashboard
          apiBaseUrl={apiBaseUrl}
          error={traceError}
          hasActiveFilters={hasActiveTraceFilters}
          filters={traceFilters}
          isLoading={isTraceLoading}
          selectedTrace={selectedTrace}
          setSelectedTraceId={setSelectedTraceId}
          setTraceFilters={setTraceFilters}
          stats={traceStats}
          timelineRows={timelineRows}
          traces={traces}
        />
      ) : activeView === "experiments" ? (
        <ExperimentDashboard
          apiBaseUrl={apiBaseUrl}
          comparison={experimentComparison}
          comparisonBaselineId={comparisonBaselineId}
          comparisonCandidateId={comparisonCandidateId}
          error={experimentError}
          experiments={experiments}
          isComparisonLoading={isComparisonLoading}
          isDetailLoading={isExperimentDetailLoading}
          isLoading={isExperimentLoading}
          isTraceLoading={isTraceLoading}
          missingLinkedTraceId={missingLinkedTraceId}
          onOpenTrace={openTraceFromExperiment}
          selectedExperiment={selectedExperiment}
          selectedExperimentId={selectedExperimentId}
          setComparisonBaselineId={setComparisonBaselineId}
          setComparisonCandidateId={setComparisonCandidateId}
          setSelectedExperimentId={setSelectedExperimentId}
          stats={experimentStats}
        />
      ) : (
        <PlaygroundDashboard
          apiBaseUrl={apiBaseUrl}
          error={playgroundError}
          isStatusLoading={isPlaygroundStatusLoading}
          onOpenTrace={openTraceFromPlayground}
          status={playgroundStatus}
        />
      )}
    </main>
  );
}
