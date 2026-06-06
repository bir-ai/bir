import { NextResponse } from "next/server";

import { buildTraceFilterQuery } from "../../trace-contract";

export const dynamic = "force-dynamic";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";

export async function GET(request: Request) {
  const apiBaseUrl = process.env.BIR_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const requestUrl = new URL(request.url);
  const query = buildTraceFilterQuery({
    status: requestUrl.searchParams.get("status"),
    name: requestUrl.searchParams.get("name"),
    event_type: requestUrl.searchParams.get("event_type"),
  });
  const endpoint = `${apiBaseUrl.replace(/\/$/, "")}/v1/traces${query ? `?${query}` : ""}`;

  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    });

    const body = await response.text();
    if (!response.ok) {
      return NextResponse.json(
        {
          error: `Bir server returned HTTP ${response.status}`,
          detail: safeJson(body),
          apiBaseUrl,
        },
        { status: response.status },
      );
    }

    return NextResponse.json({
      traces: safeJson(body),
      apiBaseUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        error: "Could not reach Bir server",
        detail: message,
        apiBaseUrl,
      },
      { status: 502 },
    );
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
