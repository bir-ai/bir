export type ChatRole = "system" | "user" | "assistant";

export type PlaygroundStatus = {
  enabled: boolean;
  upstream_base_url: string;
  upstream_reachable: boolean | null;
  detail: string | null;
};

export type PlaygroundChatReply = {
  trace_id: string;
  message: { role: ChatRole; content: string };
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number;
};

export function normalizePlaygroundStatus(value: unknown): PlaygroundStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.upstream_base_url !== "string" ||
    !(typeof value.upstream_reachable === "boolean" || value.upstream_reachable === null) ||
    !(typeof value.detail === "string" || value.detail === null)
  ) {
    return null;
  }
  return {
    enabled: value.enabled,
    upstream_base_url: value.upstream_base_url,
    upstream_reachable: value.upstream_reachable,
    detail: value.detail,
  };
}

export function normalizePlaygroundModels(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return [];
  }
  return value.models.filter((model): model is string => typeof model === "string");
}

export function normalizePlaygroundChatReply(value: unknown): PlaygroundChatReply | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.trace_id !== "string" ||
    typeof value.model !== "string" ||
    typeof value.latency_ms !== "number" ||
    !isNullableNumber(value.input_tokens) ||
    !isNullableNumber(value.output_tokens) ||
    !isNullableNumber(value.total_tokens) ||
    !isChatMessage(value.message)
  ) {
    return null;
  }
  return {
    trace_id: value.trace_id,
    message: value.message,
    model: value.model,
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
    total_tokens: value.total_tokens,
    latency_ms: value.latency_ms,
  };
}

function isChatMessage(value: unknown): value is { role: ChatRole; content: string } {
  return (
    isRecord(value) &&
    (value.role === "system" || value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string"
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === "number" || value === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
