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

export function fetchExperimentSummaries(): Promise<unknown> {
  return requestJson("/v1/experiments");
}

export function fetchExperimentDetail(experimentId: string): Promise<unknown> {
  return requestJson(`/v1/experiments/${encodeURIComponent(experimentId)}`);
}

async function requestJson(path: string): Promise<unknown> {
  const apiBaseUrl = getApiBaseUrl();

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Could not reach Bir server at ${apiBaseUrl}: ${detail}`);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Bir server returned HTTP ${response.status}`);
  }
  return safeJson(body);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
