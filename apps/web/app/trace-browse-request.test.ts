import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTraceBrowseQuery,
  canLoadOlderTracePages,
  createTraceBrowseRequestCoordinator,
  hasMoreTraceBrowsePages,
  mergeTraceBrowsePages,
  traceBrowseCursorFromTraces,
} from "./trace-browse-request";
import type { Trace } from "./trace-contract";

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let reject: ((error: unknown) => void) | undefined;
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {
    promise,
    reject: reject as (error: unknown) => void,
    resolve: resolve as (value: T) => void,
  };
}

function trace(id: string, startTime = "2026-01-01T00:00:00Z"): Trace {
  return {
    id,
    name: id,
    start_time: startTime,
    end_time: "2026-01-01T00:00:01Z",
    status: "success",
    events: [],
  };
}

function summary(traceCount: number) {
  return {
    trace_count: traceCount,
    event_count: 0,
    generation_count: 0,
    error_count: 0,
    total_tokens: 0,
    total_cost: 0,
    currency: null,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    models: [],
    providers: [],
  };
}

test("does not let an older browse response replace a newer filter response", async () => {
  const oldList = deferred<unknown>();
  const oldSummary = deferred<unknown>();
  const newList = deferred<unknown>();
  const newSummary = deferred<unknown>();
  const signals: AbortSignal[] = [];
  const coordinator = createTraceBrowseRequestCoordinator({
    traceLimit: 100,
    fetchTraceList: (query, options) => {
      if (options?.signal) {
        signals.push(options.signal);
      }
      return query.includes("name=old") ? oldList.promise : newList.promise;
    },
    fetchSummary: (query) => (query.includes("name=old") ? oldSummary.promise : newSummary.promise),
  });

  const oldRequest = coordinator.load({ name: "old" });
  const newRequest = coordinator.load({ name: "new" });
  newList.resolve([trace("new")]);
  newSummary.resolve(summary(1));

  assert.equal(signals[0]?.aborted, true);
  assert.deepEqual(await newRequest, {
    kind: "current",
    traces: [trace("new")],
    summary: {
      traceCount: 1,
      eventCount: 0,
      generationCount: 0,
      errorCount: 0,
      totalTokens: 0,
      totalCost: 0,
      currency: null,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      models: [],
      providers: [],
    },
    hasMore: false,
  });

  oldList.resolve([trace("old")]);
  oldSummary.resolve(summary(1));
  assert.deepEqual(await oldRequest, { kind: "stale" });
});

test("reports stale when an obsolete request fails after a newer success", async () => {
  const oldList = deferred<unknown>();
  const oldSummary = deferred<unknown>();
  const newList = deferred<unknown>();
  const newSummary = deferred<unknown>();
  const coordinator = createTraceBrowseRequestCoordinator({
    traceLimit: 100,
    fetchTraceList: (query) => (query.includes("name=old") ? oldList.promise : newList.promise),
    fetchSummary: (query) => (query.includes("name=old") ? oldSummary.promise : newSummary.promise),
  });

  const oldRequest = coordinator.load({ name: "old" });
  const newRequest = coordinator.load({ name: "new" });
  newList.resolve([trace("new")]);
  newSummary.resolve(summary(1));
  assert.equal((await newRequest).kind, "current");

  oldList.reject(new Error("old request failed"));
  oldSummary.resolve(summary(0));
  assert.deepEqual(await oldRequest, { kind: "stale" });
});

test("returns the current failure when the latest browse request fails", async () => {
  const coordinator = createTraceBrowseRequestCoordinator({
    traceLimit: 100,
    fetchTraceList: async () => {
      throw new Error("latest request failed");
    },
    fetchSummary: async () => summary(0),
  });

  assert.deepEqual(await coordinator.load({ name: "latest" }), {
    kind: "failed",
    message: "latest request failed",
  });
});

test("builds older-page query from the oldest loaded trace cursor", () => {
  const loaded = [
    trace("trace-newer", "2026-01-03T00:00:00.000Z"),
    trace("trace-same-newer-id", "2026-01-01T00:00:00.000Z"),
    trace("trace-same-older-id", "2026-01-01T00:00:00.000Z"),
  ];
  const cursor = traceBrowseCursorFromTraces(loaded);

  assert.deepEqual(cursor, {
    beforeStartTime: "2026-01-01T00:00:00.000Z",
    beforeId: "trace-same-newer-id",
  });
  assert.equal(
    buildTraceBrowseQuery({
      filters: { status: "error", service: "api" },
      limit: 100,
      cursor,
    }),
    "status=error&service=api&limit=100&before_start_time=2026-01-01T00%3A00%3A00.000Z&before_id=trace-same-newer-id",
  );
});

test("dedupes overlapping trace pages and keeps recent order", () => {
  const current = [
    trace("trace-newest", "2026-01-03T00:00:00.000Z"),
    trace("trace-overlap", "2026-01-02T00:00:00.000Z"),
  ];
  const incoming = [
    { ...trace("trace-overlap", "2026-01-02T00:00:00.000Z"), name: "updated overlap" },
    trace("trace-older", "2026-01-01T00:00:00.000Z"),
  ];

  const merged = mergeTraceBrowsePages(current, incoming);

  assert.deepEqual(merged.map((item) => item.id), ["trace-newest", "trace-overlap", "trace-older"]);
  assert.equal(merged[1].name, "updated overlap");
});

test("reports stale older-page requests when a newer trace browse starts", async () => {
  const olderList = deferred<unknown>();
  const refreshList = deferred<unknown>();
  const refreshSummary = deferred<unknown>();
  const signals: AbortSignal[] = [];
  const coordinator = createTraceBrowseRequestCoordinator({
    traceLimit: 2,
    fetchTraceList: (query, options) => {
      if (options?.signal) {
        signals.push(options.signal);
      }
      return query.includes("before_start_time") ? olderList.promise : refreshList.promise;
    },
    fetchSummary: async () => refreshSummary.promise,
  });

  const olderRequest = coordinator.loadOlder(
    {},
    [
      trace("trace-newer", "2026-01-02T00:00:00.000Z"),
      trace("trace-older", "2026-01-01T00:00:00.000Z"),
    ],
  );
  const refreshRequest = coordinator.load({ name: "refreshed" });
  refreshList.resolve([trace("trace-refreshed")]);
  refreshSummary.resolve(summary(1));

  assert.equal(signals[0]?.aborted, true);
  assert.equal((await refreshRequest).kind, "current");

  olderList.resolve([trace("too-late")]);
  assert.deepEqual(await olderRequest, { kind: "stale" });
});

test("keeps summary query independent from browse cursors and limits", async () => {
  const listQueries: string[] = [];
  const summaryQueries: string[] = [];
  const coordinator = createTraceBrowseRequestCoordinator({
    traceLimit: 100,
    fetchTraceList: async (query) => {
      listQueries.push(query);
      return [];
    },
    fetchSummary: async (query) => {
      summaryQueries.push(query);
      return summary(0);
    },
  });

  await coordinator.load({
    status: "error",
    sort: "slowest",
    limit: 5,
    before_start_time: "2026-01-01T00:00:00.000Z",
    before_id: "trace-1",
  });

  assert.equal(listQueries[0], "status=error&sort=slowest&limit=100");
  assert.equal(summaryQueries[0], "status=error");
});

test("tracks end-of-history and disables older pages outside recent order", () => {
  assert.equal(hasMoreTraceBrowsePages(99, 100), false);
  assert.equal(hasMoreTraceBrowsePages(100, 100), true);
  assert.equal(canLoadOlderTracePages({}), true);
  assert.equal(canLoadOlderTracePages({ sort: "recent" }), true);
  assert.equal(canLoadOlderTracePages({ sort: "slowest" }), false);
});
