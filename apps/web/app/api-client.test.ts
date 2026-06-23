import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchExperimentDetail,
  fetchExperimentSummaries,
  fetchPlaygroundModels,
  fetchPlaygroundStatus,
  fetchTraceDetail,
  fetchTraceSummary,
  fetchTraces,
  getApiBaseUrl,
  postPlaygroundChat,
} from "./api-client";

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function withStubbedFetch(
  handler: () => Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withStubbedWindow(origin: string): () => void {
  const host = globalThis as { window?: unknown };
  const originalWindow = host.window;
  host.window = { location: { origin } };
  return () => {
    if (originalWindow === undefined) {
      delete host.window;
      return;
    }
    host.window = originalWindow;
  };
}

test("defaults the API base URL to the local server", () => {
  delete process.env.NEXT_PUBLIC_BIR_API_BASE_URL;

  assert.equal(getApiBaseUrl(), "http://127.0.0.1:8000");
});

test("uses the page origin in the browser when no base URL is configured", () => {
  delete process.env.NEXT_PUBLIC_BIR_API_BASE_URL;
  const restore = withStubbedWindow("http://localhost:8000");
  try {
    assert.equal(getApiBaseUrl(), "http://localhost:8000");
  } finally {
    restore();
  }
});

test("prefers a configured base URL over the page origin", () => {
  process.env.NEXT_PUBLIC_BIR_API_BASE_URL = "http://api.example:9000";
  const restore = withStubbedWindow("http://localhost:8000");
  try {
    assert.equal(getApiBaseUrl(), "http://api.example:9000");
  } finally {
    restore();
    delete process.env.NEXT_PUBLIC_BIR_API_BASE_URL;
  }
});

test("reads the API base URL from the environment and strips a trailing slash", () => {
  process.env.NEXT_PUBLIC_BIR_API_BASE_URL = "http://api.example:9000/";
  try {
    assert.equal(getApiBaseUrl(), "http://api.example:9000");
  } finally {
    delete process.env.NEXT_PUBLIC_BIR_API_BASE_URL;
  }
});

test("fetches traces with the filter query appended", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse([]));
  try {
    const traces = await fetchTraces("status=error");

    assert.deepEqual(traces, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/traces?status=error");
    assert.equal(calls[0]?.init?.cache, "no-store");
  } finally {
    restore();
  }
});

test("fetches traces without a question mark when the query is empty", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse([]));
  try {
    await fetchTraces("");

    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/traces");
  } finally {
    restore();
  }
});

test("passes an optional abort signal to trace requests", async () => {
  const controller = new AbortController();
  const { calls, restore } = withStubbedFetch(async () => jsonResponse([]));
  try {
    await fetchTraces("", { signal: controller.signal });
    await fetchTraceSummary("", { signal: controller.signal });

    assert.equal(calls[0]?.init?.signal, controller.signal);
    assert.equal(calls[1]?.init?.signal, controller.signal);
  } finally {
    restore();
  }
});

test("fetches the complete trace summary with the filter query appended", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse({ trace_count: 2 }));
  try {
    const summary = await fetchTraceSummary("status=error");

    assert.deepEqual(summary, { trace_count: 2 });
    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/traces/summary?status=error");
    assert.equal(calls[0]?.init?.cache, "no-store");
  } finally {
    restore();
  }
});

test("fetches a trace detail with a URL-encoded trace id", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse({}));
  try {
    await fetchTraceDetail("trace/1 weird?");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/traces/trace%2F1%20weird%3F");
  } finally {
    restore();
  }
});

test("fetches experiment summaries and detail with an encoded experiment id", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse({}));
  try {
    await fetchExperimentSummaries();
    await fetchExperimentDetail("exp/1 weird");

    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/experiments");
    assert.equal(calls[1]?.url, "http://127.0.0.1:8000/v1/experiments/exp%2F1%20weird");
  } finally {
    restore();
  }
});

test("fetches playground status and models from server endpoints", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse({}));
  try {
    await fetchPlaygroundStatus();
    await fetchPlaygroundModels();

    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/playground/status");
    assert.equal(calls[1]?.url, "http://127.0.0.1:8000/v1/playground/models");
  } finally {
    restore();
  }
});

test("posts playground chat requests as JSON", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse({ trace_id: "trace-1" }));
  const payload = {
    model: "llama3.2:1b",
    messages: [{ role: "user", content: "Hello" }],
    session_id: "session-1",
  };

  try {
    const reply = await postPlaygroundChat(payload);

    assert.deepEqual(reply, { trace_id: "trace-1" });
    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/playground/chat");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal((calls[0]?.init?.headers as Record<string, string>)["content-type"], "application/json");
    assert.equal(calls[0]?.init?.body, JSON.stringify(payload));
  } finally {
    restore();
  }
});

test("posts the optional playground workflow fields when provided", async () => {
  const { calls, restore } = withStubbedFetch(async () => jsonResponse({ trace_id: "trace-2" }));
  const payload = {
    model: "llama3.2:1b",
    messages: [{ role: "user", content: "What is Bir?" }],
    session_id: "session-1",
    context: "Bir stores traces in JSONL.",
    use_retrieval: true,
    expected_output: "JSONL",
    run_evaluators: true,
  };

  try {
    await postPlaygroundChat(payload);

    assert.equal(calls[0]?.url, "http://127.0.0.1:8000/v1/playground/chat");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    assert.equal(body.context, "Bir stores traces in JSONL.");
    assert.equal(body.use_retrieval, true);
    assert.equal(body.expected_output, "JSONL");
    assert.equal(body.run_evaluators, true);
  } finally {
    restore();
  }
});

test("raises a clear error for non-OK responses", async () => {
  const { restore } = withStubbedFetch(async () => jsonResponse({ detail: "boom" }, 500));
  try {
    await assert.rejects(fetchTraces(""), /Bir server returned HTTP 500/);
  } finally {
    restore();
  }
});

test("raises a clear error when the server is unreachable", async () => {
  const { restore } = withStubbedFetch(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  try {
    await assert.rejects(
      fetchExperimentSummaries(),
      /Could not reach Bir server at http:\/\/127\.0\.0\.1:8000: connect ECONNREFUSED/,
    );
  } finally {
    restore();
  }
});
