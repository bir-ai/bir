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

export type ApiRequestOptions = {
  signal?: AbortSignal;
};

export function fetchTraces(query: string, options?: ApiRequestOptions): Promise<unknown> {
  return requestJson(`/v1/traces${query ? `?${query}` : ""}`, options);
}

export function fetchTraceSummary(query: string, options?: ApiRequestOptions): Promise<unknown> {
  return requestJson(`/v1/traces/summary${query ? `?${query}` : ""}`, options);
}

export function fetchTraceDetail(traceId: string, options?: ApiRequestOptions): Promise<unknown> {
  return requestJson(`/v1/traces/${encodeURIComponent(traceId)}`, options);
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
  options?: ApiRequestOptions & { method?: "POST"; body?: unknown },
): Promise<unknown> {
  const apiBaseUrl = getApiBaseUrl();
  const hasBody = options?.body !== undefined;

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options?.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: options?.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
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

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
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
