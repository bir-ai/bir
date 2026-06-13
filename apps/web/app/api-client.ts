const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";

export function getApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_BIR_API_BASE_URL;
  if (configured && configured.trim()) {
    return configured.trim().replace(/\/$/, "");
  }
  // The static export is meant to be served by the Bir server itself, so the
  // API shares the page origin unless a base URL was baked in at build time.
  if (typeof window !== "undefined" && window.location.origin) {
    return window.location.origin.replace(/\/$/, "");
  }
  return DEFAULT_API_BASE_URL;
}

export function fetchTraces(query: string): Promise<unknown> {
  return requestJson(`/v1/traces${query ? `?${query}` : ""}`);
}

export function fetchTraceDetail(traceId: string): Promise<unknown> {
  return requestJson(`/v1/traces/${encodeURIComponent(traceId)}`);
}

export function fetchExperimentSummaries(): Promise<unknown> {
  return requestJson("/v1/experiments");
}

export function fetchExperimentDetail(experimentId: string): Promise<unknown> {
  return requestJson(`/v1/experiments/${encodeURIComponent(experimentId)}`);
}

export function fetchPlaygroundStatus(): Promise<unknown> {
  return requestJson("/v1/playground/status");
}

export function fetchPlaygroundModels(): Promise<unknown> {
  return requestJson("/v1/playground/models");
}

export function postPlaygroundChat(chatRequest: unknown): Promise<unknown> {
  return requestJson("/v1/playground/chat", { method: "POST", body: chatRequest });
}

async function requestJson(
  path: string,
  options?: { method: "POST"; body: unknown },
): Promise<unknown> {
  const apiBaseUrl = getApiBaseUrl();

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options?.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options ? { "content-type": "application/json" } : {}),
      },
      body: options ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Could not reach Bir server at ${apiBaseUrl}: ${detail}`);
  }

  const body = await response.text();
  if (!response.ok) {
    const detail = errorDetail(body);
    throw new Error(`Bir server returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return safeJson(body);
}

function errorDetail(body: string): string | null {
  const parsed = safeJson(body);
  if (parsed && typeof parsed === "object" && "detail" in parsed) {
    const detail = (parsed as { detail: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) {
      return detail;
    }
  }
  return null;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
