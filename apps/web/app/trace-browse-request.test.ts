import assert from "node:assert/strict";
import test from "node:test";

import { createTraceBrowseRequestCoordinator } from "./trace-browse-request";
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

function trace(id: string): Trace {
  return {
    id,
    name: id,
    start_time: "2026-01-01T00:00:00Z",
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
