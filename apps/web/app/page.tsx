"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExperimentDashboard } from "./components/experiment-dashboard";
import { DEFAULT_TRACE_FILTERS } from "./components/labels";
import { TraceDashboard } from "./components/trace-dashboard";
import {
  compareExperiments,
  normalizeExperiment,
  normalizeExperimentSummaries,
  type ExperimentSummary,
  type LoadedExperiment,
} from "./experiment-contract";
import {
  buildTraceFilterQuery,
  buildTraceTimelineRows,
  findTraceById,
  normalizeTraces,
  type Trace,
  type TraceFilterValues,
} from "./trace-contract";

type ViewMode = "traces" | "experiments";

type TraceApiResponse = {
  traces?: unknown;
  apiBaseUrl?: string;
  error?: string;
  detail?: unknown;
};

type ExperimentListApiResponse = {
  experiments?: unknown;
  apiBaseUrl?: string;
  error?: string;
  detail?: unknown;
};

type ExperimentDetailApiResponse = {
  experiment?: unknown;
  apiBaseUrl?: string;
  error?: string;
  detail?: unknown;
};

export default function DashboardPage() {
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
  const [apiBaseUrl, setApiBaseUrl] = useState("http://127.0.0.1:8000");
  const [isTraceLoading, setIsTraceLoading] = useState(true);
  const [isExperimentLoading, setIsExperimentLoading] = useState(true);
  const [isExperimentDetailLoading, setIsExperimentDetailLoading] = useState(false);
  const [isComparisonLoading, setIsComparisonLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [missingLinkedTraceId, setMissingLinkedTraceId] = useState<string | null>(null);

  const loadTraces = useCallback(async (filters: TraceFilterValues = traceFilters) => {
    setIsTraceLoading(true);
    setTraceError(null);

    try {
      const query = buildTraceFilterQuery(filters);
      const response = await fetch(`/api/traces${query ? `?${query}` : ""}`, { cache: "no-store" });
      const payload = (await response.json()) as TraceApiResponse;
      if (typeof payload.apiBaseUrl === "string") {
        setApiBaseUrl(payload.apiBaseUrl);
      }
      if (!response.ok) {
        setTraceError(payload.error ?? "Trace request failed");
        setTraces([]);
        setSelectedTraceId(null);
        return [];
      }

      const nextTraces = normalizeTraces(payload.traces);
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
      const response = await fetch("/api/experiments", { cache: "no-store" });
      const payload = (await response.json()) as ExperimentListApiResponse;
      if (typeof payload.apiBaseUrl === "string") {
        setApiBaseUrl(payload.apiBaseUrl);
      }
      if (!response.ok) {
        setExperimentError(payload.error ?? "Experiment request failed");
        setExperiments([]);
        setSelectedExperimentId(null);
        setSelectedExperiment(null);
        return;
      }

      const nextExperiments = normalizeExperimentSummaries(payload.experiments);
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

  const fetchExperimentDetail = useCallback(async (experimentId: string): Promise<LoadedExperiment | null> => {
    const response = await fetch(`/api/experiments/${encodeURIComponent(experimentId)}`, { cache: "no-store" });
    const payload = (await response.json()) as ExperimentDetailApiResponse;
    if (typeof payload.apiBaseUrl === "string") {
      setApiBaseUrl(payload.apiBaseUrl);
    }
    if (!response.ok) {
      throw new Error(payload.error ?? "Experiment detail request failed");
    }
    return normalizeExperiment(payload.experiment);
  }, []);

  const loadExperimentDetail = useCallback(async (experimentId: string) => {
    setIsExperimentDetailLoading(true);
    setExperimentError(null);

    try {
      setSelectedExperiment(await fetchExperimentDetail(experimentId));
    } catch (requestError) {
      setExperimentError(requestError instanceof Error ? requestError.message : "Experiment detail request failed");
      setSelectedExperiment(null);
    } finally {
      setIsExperimentDetailLoading(false);
    }
  }, [fetchExperimentDetail]);

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

  useEffect(() => {
    void loadTraces();
    void loadExperiments();
  }, [loadExperiments, loadTraces]);

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
      fetchExperimentDetail(comparisonBaselineId),
      fetchExperimentDetail(comparisonCandidateId),
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
  }, [comparisonBaselineId, comparisonCandidateId, fetchExperimentDetail]);

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
    activeView === "traces" ? isTraceLoading : isExperimentLoading || isExperimentDetailLoading || isComparisonLoading;
  const refreshActiveView = useCallback(() => {
    if (activeView === "traces") {
      void loadTraces();
      return;
    }
    void loadExperiments();
  }, [activeView, loadExperiments, loadTraces]);

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
      ) : (
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
      )}
    </main>
  );
}
