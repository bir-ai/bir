import assert from "node:assert/strict";
import test from "node:test";

import {
  createDebouncedTraceFilterCommitter,
  TRACE_TEXT_FILTER_DEBOUNCE_MS,
  type TraceFilterTimer,
} from "./trace-filter-commit";
import type { TraceFilterValues } from "./trace-contract";

type Timer = {
  active: boolean;
  callback: () => void;
  waitMs: number;
};

function fakeTimers() {
  const timers: Timer[] = [];
  return {
    timers,
    setTimer(callback: () => void, waitMs: number): TraceFilterTimer {
      const timer = { active: true, callback, waitMs };
      timers.push(timer);
      return timer as unknown as TraceFilterTimer;
    },
    clearTimer(timer: TraceFilterTimer) {
      (timer as unknown as Timer).active = false;
    },
    runActiveTimers() {
      for (const timer of timers.filter((entry) => entry.active)) {
        timer.active = false;
        timer.callback();
      }
    },
  };
}

test("debounces text filter commits and only applies the latest scheduled value", () => {
  const clock = fakeTimers();
  const commits: TraceFilterValues[] = [];
  const committer = createDebouncedTraceFilterCommitter({
    initialFilters: {},
    commit: (filters) => commits.push(filters),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  committer.schedule({ name: "a" });
  committer.schedule({ name: "answer" });

  assert.equal(clock.timers.length, 2);
  assert.equal(clock.timers[0]?.active, false);
  assert.equal(clock.timers[1]?.waitMs, TRACE_TEXT_FILTER_DEBOUNCE_MS);

  clock.runActiveTimers();

  assert.deepEqual(commits, [{ name: "answer" }]);
});

test("debounces source filter commits", () => {
  const clock = fakeTimers();
  const commits: TraceFilterValues[] = [];
  const committer = createDebouncedTraceFilterCommitter({
    initialFilters: {},
    commit: (filters) => commits.push(filters),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  committer.schedule({ source: "play" });
  committer.schedule({ source: "playground" });
  clock.runActiveTimers();

  assert.deepEqual(commits, [{ source: "playground" }]);
});

test("clearing filters removes an active source filter immediately", () => {
  const clock = fakeTimers();
  const commits: TraceFilterValues[] = [];
  const committer = createDebouncedTraceFilterCommitter({
    initialFilters: { source: "playground" },
    commit: (filters) => commits.push(filters),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(committer.commitNow({ source: "" }), true);

  assert.deepEqual(commits, [{ source: "" }]);
});

test("immediate controls cancel pending text debounce and commit the combined filters", () => {
  const clock = fakeTimers();
  const commits: TraceFilterValues[] = [];
  const committer = createDebouncedTraceFilterCommitter({
    initialFilters: {},
    commit: (filters) => commits.push(filters),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  committer.schedule({ name: "ans" });
  assert.equal(committer.commitNow({ name: "ans", status: "error" }), true);
  clock.runActiveTimers();

  assert.deepEqual(commits, [{ name: "ans", status: "error" }]);
});

test("filter clear is immediate and cancels a pending text debounce", () => {
  const clock = fakeTimers();
  const commits: TraceFilterValues[] = [];
  const committer = createDebouncedTraceFilterCommitter({
    initialFilters: { name: "answer", status: "error" },
    commit: (filters) => commits.push(filters),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  committer.schedule({ name: "answering", status: "error" });
  assert.equal(committer.commitNow({}), true);
  clock.runActiveTimers();

  assert.deepEqual(commits, [{}]);
});

test("equivalent effective server queries do not trigger another commit", () => {
  const clock = fakeTimers();
  const commits: TraceFilterValues[] = [];
  const committer = createDebouncedTraceFilterCommitter({
    initialFilters: { name: "answer" },
    commit: (filters) => commits.push(filters),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  committer.schedule({ name: " answer " });
  clock.runActiveTimers();
  assert.deepEqual(commits, []);
});
