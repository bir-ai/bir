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
  | { kind: "current"; traces: Trace[]; summary: TraceSummary; hasMore: boolean }
  | { kind: "failed"; message: string }
  | { kind: "stale" };

export type TraceBrowsePageResult =
  | { kind: "current"; traces: Trace[]; hasMore: boolean }
  | { kind: "failed"; message: string }
  | { kind: "stale" };

export type TraceBrowseCursor = {
  beforeStartTime: string;
  beforeId: string;
};

export type TraceBrowseRequestCoordinator = ReturnType<typeof createTraceBrowseRequestCoordinator>;

export function buildTraceBrowseQuery({
  cursor = null,
  filters,
  limit,
}: {
  cursor?: TraceBrowseCursor | null;
  filters: TraceFilterValues;
  limit: number;
}): string {
  return buildTraceFilterQuery({
    ...filters,
    limit,
    before_start_time: cursor?.beforeStartTime,
    before_id: cursor?.beforeId,
  });
}

export function canLoadOlderTracePages(filters: TraceFilterValues): boolean {
  return (filters.sort ?? "recent") === "recent";
}

export function mergeTraceBrowsePages(current: Trace[], incoming: Trace[]): Trace[] {
  const tracesById = new Map<string, Trace>();
  for (const trace of current) {
    tracesById.set(trace.id, trace);
  }
  for (const trace of incoming) {
    tracesById.set(trace.id, trace);
  }
  return Array.from(tracesById.values()).sort(
    (first, second) => second.start_time.localeCompare(first.start_time) || second.id.localeCompare(first.id),
  );
}

export function traceBrowseCursorFromTraces(traces: Trace[]): TraceBrowseCursor | null {
  if (traces.length === 0) {
    return null;
  }
  const oldestTrace = traces.reduce((oldest, trace) =>
    trace.start_time < oldest.start_time || (trace.start_time === oldest.start_time && trace.id < oldest.id)
      ? trace
      : oldest,
  );
  return {
    beforeStartTime: oldestTrace.start_time,
    beforeId: oldestTrace.id,
  };
}

export function hasMoreTraceBrowsePages(pageSize: number, traceLimit: number): boolean {
  return pageSize >= traceLimit;
}

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
        const browseQuery = buildTraceBrowseQuery({ filters, limit: traceLimit });
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
        return {
          kind: "current",
          traces,
          summary,
          hasMore: canLoadOlderTracePages(filters) && hasMoreTraceBrowsePages(traces.length, traceLimit),
        };
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

    async loadOlder(filters: TraceFilterValues, currentTraces: Trace[]): Promise<TraceBrowsePageResult> {
      if (!canLoadOlderTracePages(filters)) {
        return { kind: "failed", message: "Load older is available in Recent order." };
      }
      const cursor = traceBrowseCursorFromTraces(currentTraces);
      if (!cursor) {
        return { kind: "stale" };
      }

      const request = latestRequest + 1;
      latestRequest = request;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      try {
        const query = buildTraceBrowseQuery({ filters, limit: traceLimit, cursor });
        const traces = normalizeTraces(await fetchTraceList(query, { signal: controller.signal }), filters.sort);
        if (request !== latestRequest) {
          return { kind: "stale" };
        }
        return {
          kind: "current",
          traces,
          hasMore: hasMoreTraceBrowsePages(traces.length, traceLimit),
        };
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
