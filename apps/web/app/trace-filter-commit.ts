import { buildTraceFilterQuery, type TraceFilterValues } from "./trace-contract";

// Short enough to keep filtering feeling responsive, long enough to collapse a
// normal burst of name/source/service/environment keystrokes into one server request.
export const TRACE_TEXT_FILTER_DEBOUNCE_MS = 250;

export type TraceFilterCommitMode = "immediate" | "debounced";

export type TraceFilterTimer = ReturnType<typeof setTimeout>;

export function traceFilterQueryKey(filters: TraceFilterValues): string {
  return buildTraceFilterQuery(filters);
}

export function createDebouncedTraceFilterCommitter({
  initialFilters,
  commit,
  waitMs = TRACE_TEXT_FILTER_DEBOUNCE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  initialFilters: TraceFilterValues;
  commit: (filters: TraceFilterValues) => void;
  waitMs?: number;
  setTimer?: (callback: () => void, waitMs: number) => TraceFilterTimer;
  clearTimer?: (timer: TraceFilterTimer) => void;
}) {
  let effectiveFilters = initialFilters;
  let pendingTimer: TraceFilterTimer | null = null;

  function cancel() {
    if (pendingTimer) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
  }

  function commitIfChanged(filters: TraceFilterValues): boolean {
    if (traceFilterQueryKey(effectiveFilters) === traceFilterQueryKey(filters)) {
      return false;
    }
    effectiveFilters = filters;
    commit(filters);
    return true;
  }

  return {
    cancel,

    commitNow(filters: TraceFilterValues): boolean {
      cancel();
      return commitIfChanged(filters);
    },

    schedule(filters: TraceFilterValues) {
      cancel();
      pendingTimer = setTimer(() => {
        pendingTimer = null;
        commitIfChanged(filters);
      }, waitMs);
    },
  };
}
