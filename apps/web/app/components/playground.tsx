"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPlaygroundModels, postPlaygroundChat } from "../api-client";
import {
  normalizePlaygroundChatReply,
  normalizePlaygroundModels,
  type ChatRole,
  type PlaygroundChatReply,
  type PlaygroundStatus,
} from "../playground-contract";
import { InlineField, Metric, PanelHead } from "./primitives";

type ConversationEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reply?: PlaygroundChatReply;
};

export function PlaygroundDashboard({
  apiBaseUrl,
  error,
  isStatusLoading,
  onOpenTrace,
  status,
}: {
  apiBaseUrl: string;
  error: string | null;
  isStatusLoading: boolean;
  onOpenTrace: (traceId: string) => void;
  status: PlaygroundStatus | null;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [isModelsLoading, setIsModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const upstreamReady = status?.enabled === true && status.upstream_reachable === true;

  useEffect(() => {
    setSessionId(crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (!upstreamReady) {
      setModels([]);
      return;
    }

    let isCurrentRequest = true;
    setIsModelsLoading(true);
    setModelsError(null);

    void fetchPlaygroundModels()
      .then((payload) => {
        if (!isCurrentRequest) {
          return;
        }
        const nextModels = normalizePlaygroundModels(payload);
        setModels(nextModels);
        setSelectedModel((current) => {
          if (current && nextModels.includes(current)) {
            return current;
          }
          return nextModels[0] ?? null;
        });
      })
      .catch((requestError) => {
        if (!isCurrentRequest) {
          return;
        }
        setModelsError(requestError instanceof Error ? requestError.message : "Model list request failed");
        setModels([]);
      })
      .finally(() => {
        if (isCurrentRequest) {
          setIsModelsLoading(false);
        }
      });

    return () => {
      isCurrentRequest = false;
    };
  }, [status, upstreamReady]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries, isSending]);

  const startNewSession = useCallback(() => {
    setSessionId(crypto.randomUUID());
    setEntries([]);
    setChatError(null);
  }, []);

  const sendMessage = useCallback(async () => {
    const content = draft.trim();
    if (!content || !selectedModel || isSending) {
      return;
    }

    const history: { role: ChatRole; content: string }[] = entries.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
    setEntries((current) => [...current, { id: crypto.randomUUID(), role: "user", content }]);
    setDraft("");
    setChatError(null);
    setIsSending(true);

    try {
      const reply = normalizePlaygroundChatReply(
        await postPlaygroundChat({
          model: selectedModel,
          messages: [...history, { role: "user", content }],
          system_prompt: systemPrompt.trim() || undefined,
          session_id: sessionId ?? undefined,
        }),
      );
      if (!reply) {
        throw new Error("Bir server returned an unexpected playground reply");
      }
      setEntries((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "assistant", content: reply.message.content, reply },
      ]);
    } catch (requestError) {
      setChatError(requestError instanceof Error ? requestError.message : "Playground chat request failed");
    } finally {
      setIsSending(false);
    }
  }, [draft, entries, isSending, selectedModel, sessionId, systemPrompt]);

  const replies = entries.filter((entry) => entry.reply);
  const sessionTokens = replies.reduce((total, entry) => total + (entry.reply?.total_tokens ?? 0), 0);
  const averageLatencyMs =
    replies.length > 0
      ? replies.reduce((total, entry) => total + (entry.reply?.latency_ms ?? 0), 0) / replies.length
      : null;

  if (error || (!status && !isStatusLoading)) {
    return (
      <section className="workspace playground-blocked" aria-label="Playground unavailable">
        <div className="state-box error-state">{error ?? "Playground status is unavailable."}</div>
      </section>
    );
  }

  if (!status) {
    return (
      <section className="workspace playground-blocked" aria-label="Playground loading">
        <div className="state-box">Checking playground availability…</div>
      </section>
    );
  }

  if (!status.enabled) {
    return (
      <section className="workspace playground-blocked" aria-label="Playground disabled">
        <div className="state-box">{status.detail ?? "The playground is disabled on this server."}</div>
      </section>
    );
  }

  if (status.upstream_reachable === false) {
    return (
      <section className="workspace playground-blocked" aria-label="Model server unreachable">
        <div className="state-box error-state">
          {status.detail ??
            `Could not reach a model server at ${status.upstream_base_url}. ` +
              "Start your local model server (for example Ollama) or set BIR_PLAYGROUND_BASE_URL."}
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="metric-strip" aria-label="Playground summary">
        <Metric label="Models" value={models.length.toString()} />
        <Metric label="Replies" value={replies.length.toString()} />
        <Metric label="Session Tokens" value={sessionTokens.toString()} />
        <Metric label="Avg Latency" value={averageLatencyMs === null ? "-" : formatLatency(averageLatencyMs)} />
      </section>

      <section className="workspace">
        <aside className="trace-list playground-setup" aria-label="Playground setup">
          <PanelHead title="Playground" subtitle={apiBaseUrl} />
          <div className="trace-filters" aria-label="Playground settings">
            <label className="filter-group">
              <span>Model</span>
              <select
                value={selectedModel ?? ""}
                disabled={isModelsLoading || models.length === 0}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                {models.length === 0 ? <option value="">{isModelsLoading ? "Loading…" : "No models"}</option> : null}
                {models.map((model) => (
                  <option value={model} key={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>

            <label className="filter-group">
              <span>System Prompt</span>
              <textarea
                placeholder="Optional system prompt"
                rows={4}
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </label>

            <button className="filter-clear" type="button" onClick={startNewSession} disabled={isSending}>
              New Session
            </button>
          </div>
          {modelsError ? <div className="state-box error-state">{modelsError}</div> : null}
          <p className="subtle">
            Every reply is recorded as a trace on this Bir server, including the messages you send. Model:{" "}
            {status.upstream_base_url}
          </p>
        </aside>

        <section className="detail-panel chat-panel" aria-label="Playground conversation">
          <div className="detail-head">
            <div>
              <p className="eyebrow">Playground</p>
              <h2>{selectedModel ?? "Observed chat"}</h2>
              <p className="subtle">Each exchange becomes a trace with token usage and latency.</p>
            </div>
          </div>

          <div className="chat-log" ref={logRef}>
            {entries.length === 0 ? (
              <div className="empty-detail">Send a message to start an observed chat.</div>
            ) : (
              entries.map((entry) => (
                <article className={`chat-turn ${entry.role}`} key={entry.id}>
                  <span className="chat-role">{entry.role === "user" ? "You" : (entry.reply?.model ?? "Assistant")}</span>
                  <div className="chat-bubble">{entry.content}</div>
                  {entry.reply ? (
                    <div className="event-fields chat-turn-facts">
                      <InlineField label="Tokens in / out" value={formatTokenCounts(entry.reply)} />
                      <InlineField label="Latency" value={formatLatency(entry.reply.latency_ms)} />
                      <button className="inline-action" type="button" onClick={() => onOpenTrace(entry.reply!.trace_id)}>
                        Open trace
                      </button>
                    </div>
                  ) : null}
                </article>
              ))
            )}
            {isSending ? <p className="chat-pending">Waiting for {selectedModel ?? "the model"}…</p> : null}
            {chatError ? <div className="error-block">{chatError}</div> : null}
          </div>

          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              placeholder="Message the model…"
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button className="refresh-button" type="submit" disabled={isSending || !draft.trim() || !selectedModel}>
              {isSending ? "Sending" : "Send"}
            </button>
          </form>
        </section>
      </section>
    </>
  );
}

function formatTokenCounts(reply: PlaygroundChatReply): string {
  const inputTokens = reply.input_tokens === null ? "-" : reply.input_tokens.toString();
  const outputTokens = reply.output_tokens === null ? "-" : reply.output_tokens.toString();
  return `${inputTokens} / ${outputTokens}`;
}

function formatLatency(latencyMs: number): string {
  if (latencyMs < 1000) {
    return `${latencyMs.toFixed(0)} ms`;
  }
  return `${(latencyMs / 1000).toFixed(2)} s`;
}
