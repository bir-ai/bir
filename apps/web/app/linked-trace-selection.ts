import { isTrace, type Trace } from "./trace-contract";

export type LinkedTraceResolution =
  | { kind: "selected"; trace: Trace }
  | { kind: "missing"; traceId: string; message: string }
  | { kind: "stale" };

export function resolveSelectedTrace(
  traces: Trace[],
  selectedTraceId: string | null,
  linkedTrace: Trace | null,
): Trace | null {
  if (selectedTraceId) {
    const listedTrace = traces.find((trace) => trace.id === selectedTraceId);
    if (listedTrace) {
      return listedTrace;
    }
    if (linkedTrace?.id === selectedTraceId) {
      return linkedTrace;
    }
  }
  return traces[0] ?? null;
}

export function createLinkedTraceResolver(fetchDetail: (traceId: string) => Promise<unknown>) {
  let latestRequest = 0;

  return {
    invalidate() {
      latestRequest += 1;
    },

    async resolve(traceId: string): Promise<LinkedTraceResolution> {
      const request = ++latestRequest;

      try {
        const detail = await fetchDetail(traceId);
        if (request !== latestRequest) {
          return { kind: "stale" };
        }
        if (!isTrace(detail) || detail.id !== traceId) {
          return {
            kind: "missing",
            traceId,
            message: `Trace ${traceId} was not found or returned invalid trace detail.`,
          };
        }
        return { kind: "selected", trace: detail };
      } catch (error) {
        if (request !== latestRequest) {
          return { kind: "stale" };
        }
        const detail = error instanceof Error ? error.message : "Trace detail request failed";
        return {
          kind: "missing",
          traceId,
          message: /HTTP 404(?:\D|$)/.test(detail)
            ? `Trace ${traceId} was not found.`
            : `Could not open trace ${traceId}: ${detail}`,
        };
      }
    },
  };
}
