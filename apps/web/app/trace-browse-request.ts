import {
  buildTraceFilterQuery,
  buildTraceSummaryFilterQuery,
  normalizeTraces,
  normalizeTraceSummary,
  type Trace,
  type TraceFilterValues,
  type TraceSummary,
} from "./trace-contract";

export type TraceBrowseRequestResult =
  | { kind: "current"; traces: Trace[]; summary: TraceSummary }
  | { kind: "failed"; message: string }
  | { kind: "stale" };

export type TraceBrowseRequestCoordinator = ReturnType<typeof createTraceBrowseRequestCoordinator>;

export function createTraceBrowseRequestCoordinator({
  fetchTraceList,
  fetchSummary,
  traceLimit,
}: {
  fetchTraceList: (query: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
  fetchSummary: (query: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
  traceLimit: number;
}) {
  let latestRequest = 0;
  let activeController: AbortController | null = null;

  return {
    invalidate() {
      latestRequest += 1;
      activeController?.abort();
      activeController = null;
    },

    async load(filters: TraceFilterValues): Promise<TraceBrowseRequestResult> {
      const request = latestRequest + 1;
      latestRequest = request;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      try {
        const browseQuery = buildTraceFilterQuery({ ...filters, limit: traceLimit });
        const summaryQuery = buildTraceSummaryFilterQuery(filters);
        const [traceResponse, summaryResponse] = await Promise.all([
          fetchTraceList(browseQuery, { signal: controller.signal }),
          fetchSummary(summaryQuery, { signal: controller.signal }),
        ]);
        const traces = normalizeTraces(traceResponse, filters.sort);
        const summary = normalizeTraceSummary(summaryResponse);
        if (!summary) {
          throw new Error("Bir server returned an unexpected trace summary");
        }
        if (request !== latestRequest) {
          return { kind: "stale" };
        }
        return { kind: "current", traces, summary };
      } catch (error) {
        if (request !== latestRequest || isAbortError(error)) {
          return { kind: "stale" };
        }
        return {
          kind: "failed",
          message: error instanceof Error ? error.message : "Trace request failed",
        };
      } finally {
        if (request === latestRequest && activeController === controller) {
          activeController = null;
        }
      }
    },
  };
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
