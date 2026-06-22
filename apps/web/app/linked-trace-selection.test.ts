import assert from "node:assert/strict";
import test from "node:test";

import { createLinkedTraceResolver, resolveSelectedTrace } from "./linked-trace-selection";
import type { Trace } from "./trace-contract";

function trace(id: string): Trace {
  return {
    id,
    name: id,
    start_time: "2025-01-01T00:00:00Z",
    end_time: "2025-01-01T00:00:01Z",
    status: "success",
    events: [],
  };
}

test("selects a valid linked trace independently of browse-list membership", async () => {
  const linkedTrace = trace("older-than-window");
  const resolver = createLinkedTraceResolver(async () => linkedTrace);

  const result = await resolver.resolve(linkedTrace.id);

  assert.deepEqual(result, { kind: "selected", trace: linkedTrace });
  assert.equal(resolveSelectedTrace([trace("newest")], linkedTrace.id, linkedTrace), linkedTrace);
});

test("reports missing and invalid linked trace details", async () => {
  const missingResolver = createLinkedTraceResolver(async () => {
    throw new Error("Bir server returned HTTP 404: Trace not found");
  });
  const invalidResolver = createLinkedTraceResolver(async () => ({ id: "not-a-trace" }));

  assert.deepEqual(await missingResolver.resolve("missing"), {
    kind: "missing",
    traceId: "missing",
    message: "Trace missing was not found.",
  });
  assert.deepEqual(await invalidResolver.resolve("invalid"), {
    kind: "missing",
    traceId: "invalid",
    message: "Trace invalid was not found or returned invalid trace detail.",
  });
});

test("does not let an older direct request replace a newer selection", async () => {
  let finishFirst: ((value: unknown) => void) | undefined;
  const resolver = createLinkedTraceResolver((traceId) => {
    if (traceId === "first") {
      return new Promise((resolve) => {
        finishFirst = resolve;
      });
    }
    return Promise.resolve(trace("second"));
  });

  const first = resolver.resolve("first");
  assert.deepEqual(await resolver.resolve("second"), { kind: "selected", trace: trace("second") });
  finishFirst?.(trace("first"));
  assert.deepEqual(await first, { kind: "stale" });
});

test("invalidating a request prevents it from changing a normal list selection", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const resolver = createLinkedTraceResolver(() => new Promise((resolve) => {
    finish = resolve;
  }));

  const pending = resolver.resolve("linked");
  resolver.invalidate();
  finish?.(trace("linked"));

  assert.deepEqual(await pending, { kind: "stale" });
});
