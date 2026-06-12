"""Playground proxy that chats with a local OpenAI-compatible model server.

The playground forwards chat turns to an upstream server such as Ollama,
LM Studio, or vLLM and records every exchange as a regular Bir trace, so
playground traffic flows through the same event store and trace endpoints
as SDK-ingested events.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any

from .schemas import (
    PlaygroundChatRequest,
    PlaygroundChatResponse,
    PlaygroundMessage,
    TraceEventPayload,
)

DEFAULT_PLAYGROUND_BASE_URL = "http://127.0.0.1:11434"
CHAT_TIMEOUT_SECONDS = 120.0
MODELS_TIMEOUT_SECONDS = 10.0
STATUS_TIMEOUT_SECONDS = 3.0


class PlaygroundUpstreamError(Exception):
    """Raised when the upstream model server is unreachable or misbehaves."""


def playground_base_url_from_env() -> str:
    configured_url = os.environ.get("BIR_PLAYGROUND_BASE_URL")
    if configured_url and configured_url.strip():
        return configured_url.strip().rstrip("/")
    return DEFAULT_PLAYGROUND_BASE_URL


class PlaygroundClient:
    """Minimal stdlib HTTP client for an OpenAI-compatible model server."""

    def __init__(self, base_url: str) -> None:
        """Create a client for the model server at the given base URL."""

        self.base_url = base_url.rstrip("/")

    def chat_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Forward one non-streaming chat completion request upstream."""

        return self._request_json("POST", "/v1/chat/completions", payload=payload, timeout=CHAT_TIMEOUT_SECONDS)

    def list_models(self) -> list[str]:
        """List upstream model names, preferring the OpenAI-compatible endpoint.

        Falls back to Ollama's native ``/api/tags`` when ``/v1/models`` is not
        available, so older Ollama builds still populate the model picker.
        """

        try:
            payload = self._request_json("GET", "/v1/models", timeout=MODELS_TIMEOUT_SECONDS)
            models = _openai_model_names(payload)
        except PlaygroundUpstreamError:
            payload = self._request_json("GET", "/api/tags", timeout=MODELS_TIMEOUT_SECONDS)
            models = _ollama_model_names(payload)
        return sorted(models)

    def is_reachable(self) -> bool:
        """Return whether the upstream model server answers a models request."""

        try:
            self.list_models()
        except PlaygroundUpstreamError:
            return False
        return True

    def _request_json(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        timeout: float,
    ) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        upstream_request = urllib.request.Request(
            url,
            data=data,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(upstream_request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = _upstream_error_detail(exc)
            raise PlaygroundUpstreamError(
                f"Model server at {self.base_url} returned HTTP {exc.code} for {path}{detail}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", None) or exc
            raise PlaygroundUpstreamError(
                f"Could not reach a model server at {self.base_url}: {reason}. "
                "Start your local model server (for example Ollama) or set BIR_PLAYGROUND_BASE_URL."
            ) from exc

        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            raise PlaygroundUpstreamError(f"Model server at {self.base_url} returned invalid JSON for {path}") from exc
        if not isinstance(parsed, dict):
            raise PlaygroundUpstreamError(f"Model server at {self.base_url} returned an unexpected payload for {path}")
        return parsed


def run_chat(
    client: PlaygroundClient,
    chat: PlaygroundChatRequest,
) -> tuple[PlaygroundChatResponse, list[TraceEventPayload]]:
    """Run one chat turn upstream and build the trace events that record it."""

    messages = [{"role": message.role, "content": message.content} for message in chat.messages]
    if chat.system_prompt is not None and chat.system_prompt.strip():
        messages.insert(0, {"role": "system", "content": chat.system_prompt})
    payload: dict[str, Any] = {"model": chat.model, "messages": messages, "stream": False}
    if chat.temperature is not None:
        payload["temperature"] = chat.temperature

    start_time = datetime.now(timezone.utc)
    started_at = time.perf_counter()
    completion = client.chat_completion(payload)
    latency_ms = (time.perf_counter() - started_at) * 1000
    end_time = datetime.now(timezone.utc)

    assistant_content = _assistant_content(client.base_url, completion)
    upstream_model = completion.get("model")
    response_model = upstream_model if isinstance(upstream_model, str) else chat.model
    input_tokens = _usage_token_count(completion, "prompt_tokens")
    output_tokens = _usage_token_count(completion, "completion_tokens")
    total_tokens = _usage_token_count(completion, "total_tokens")

    trace_id = f"playground-{uuid.uuid4().hex}"
    metadata: dict[str, Any] = {"source": "playground"}
    if chat.session_id is not None:
        metadata["session_id"] = chat.session_id
    usage = {
        key: value
        for key, value in (
            ("input_tokens", input_tokens),
            ("output_tokens", output_tokens),
            ("total_tokens", total_tokens),
        )
        if value is not None
    }
    shared_event_fields: dict[str, Any] = {
        "schema_version": "1.0",
        "trace_id": trace_id,
        "start_time": start_time.isoformat(),
        "end_time": end_time.isoformat(),
        "status": "success",
        "error": None,
    }
    trace_event = TraceEventPayload.model_validate(
        {
            **shared_event_fields,
            "id": trace_id,
            "parent_id": None,
            "name": "playground.chat",
            "type": "trace",
            "metadata": metadata,
            "input": None,
            "output": None,
        }
    )
    generation_event = TraceEventPayload.model_validate(
        {
            **shared_event_fields,
            "id": f"{trace_id}-generation",
            "parent_id": trace_id,
            "name": "playground.llm",
            "type": "generation",
            "metadata": {**metadata, "latency_ms": latency_ms},
            "input": {"messages": messages},
            "output": assistant_content,
            "model": response_model,
            "usage": usage or None,
        }
    )

    response = PlaygroundChatResponse(
        trace_id=trace_id,
        message=PlaygroundMessage(role="assistant", content=assistant_content),
        model=response_model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        latency_ms=latency_ms,
    )
    return response, [trace_event, generation_event]


def _assistant_content(base_url: str, completion: dict[str, Any]) -> str:
    choices = completion.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message["content"]
    raise PlaygroundUpstreamError(f"Model server at {base_url} returned an unexpected chat completion payload")


def _usage_token_count(completion: dict[str, Any], field: str) -> int | None:
    usage = completion.get("usage")
    if not isinstance(usage, dict):
        return None
    value = usage.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _openai_model_names(payload: dict[str, Any]) -> list[str]:
    data = payload.get("data")
    if not isinstance(data, list):
        raise PlaygroundUpstreamError("Model server returned an unexpected /v1/models payload")
    return [entry["id"] for entry in data if isinstance(entry, dict) and isinstance(entry.get("id"), str)]


def _ollama_model_names(payload: dict[str, Any]) -> list[str]:
    data = payload.get("models")
    if not isinstance(data, list):
        raise PlaygroundUpstreamError("Model server returned an unexpected /api/tags payload")
    return [entry["name"] for entry in data if isinstance(entry, dict) and isinstance(entry.get("name"), str)]


def _upstream_error_detail(exc: urllib.error.HTTPError) -> str:
    try:
        body = exc.read().decode("utf-8")
        parsed = json.loads(body)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return ""
    message = parsed.get("error") if isinstance(parsed, dict) else None
    if isinstance(message, dict):
        message = message.get("message")
    if isinstance(message, str) and message.strip():
        return f": {message.strip()[:300]}"
    return ""
