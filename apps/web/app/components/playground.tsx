"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fetchPlaygroundModels, postPlaygroundChat } from "../api-client";
import {
  normalizePlaygroundChatReply,
  normalizePlaygroundModels,
  type ChatRole,
  type PlaygroundChatReply,
  type PlaygroundStatus,
} from "../playground-contract";
import { buildDatasetRows, datasetFileName, serializeDatasetRows } from "../playground-dataset";
import type { PlaygroundFailedAttempt, PlaygroundHistorySession } from "../playground-history";
import { formatDate } from "./format";
import { InlineField, Metric, PanelHead } from "./primitives";

export type PlaygroundConversationEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  // Expected answer in effect when this user turn was sent, kept for dataset export.
  expected?: string;
  reply?: PlaygroundChatReply;
  failedAttempt?: PlaygroundFailedAttempt;
};

export type PlaygroundSessionState = {
  selectedModel: string | null;
  systemPrompt: string;
  contextText: string;
  useRetrieval: boolean;
  expectedOutput: string;
  runEvaluators: boolean;
  sessionId: string | null;
  entries: PlaygroundConversationEntry[];
  draft: string;
  isSending: boolean;
  chatError: string | null;
};

export function PlaygroundDashboard({
  apiBaseUrl,
  error,
  historyError,
  historySessions,
  hasLoadedHistory,
  hasMoreHistory,
  isHistoryLoading,
  isStatusLoading,
  linkedTraceError,
  onLoadOlderHistory,
  onOpenTrace,
  onRefreshHistory,
  onSelectHistorySession,
  selectedHistorySessionId,
  session,
  setSession,
  status,
}: {
  apiBaseUrl: string;
  error: string | null;
  historyError: string | null;
  historySessions: PlaygroundHistorySession[];
  hasLoadedHistory: boolean;
  hasMoreHistory: boolean;
  isHistoryLoading: boolean;
  isStatusLoading: boolean;
  linkedTraceError: string | null;
  onLoadOlderHistory: () => void;
  onOpenTrace: (traceId: string) => void;
  onRefreshHistory: () => void;
  onSelectHistorySession: (sessionId: string | null) => void;
  selectedHistorySessionId: string | null;
  session: PlaygroundSessionState;
  setSession: Dispatch<SetStateAction<PlaygroundSessionState>>;
  status: PlaygroundStatus | null;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [isModelsLoading, setIsModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const {
    chatError,
    contextText,
    draft,
    entries,
    expectedOutput,
    isSending,
    runEvaluators,
    selectedModel,
    sessionId,
    systemPrompt,
    useRetrieval,
  } = session;
  const selectedHistorySession =
    selectedHistorySessionId === null
      ? null
      : (historySessions.find((historySession) => historySession.sessionId === selectedHistorySessionId) ?? null);
  const visibleEntries = selectedHistorySession?.entries ?? entries;
  const isViewingHistory = selectedHistorySession !== null;
  const pastSessions = historySessions.filter((historySession) => historySession.sessionId !== sessionId);

  const upstreamReady = status?.enabled === true && status.upstream_reachable === true;

  useEffect(() => {
    setSession((current) => (current.sessionId ? current : { ...current, sessionId: crypto.randomUUID() }));
  }, [setSession]);

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
        setSession((current) => {
          if (current.selectedModel && nextModels.includes(current.selectedModel)) {
            return current;
          }
          return { ...current, selectedModel: nextModels[0] ?? null };
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
  }, [setSession, status, upstreamReady]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [visibleEntries, isSending]);

  const startNewSession = useCallback(() => {
    onSelectHistorySession(null);
    setSession((current) => ({
      ...current,
      sessionId: crypto.randomUUID(),
      entries: [],
      chatError: null,
    }));
  }, [onSelectHistorySession, setSession]);

  const sendMessage = useCallback(async () => {
    const content = draft.trim();
    if (!content || !selectedModel || isSending || isViewingHistory) {
      return;
    }

    const history: { role: ChatRole; content: string }[] = entries.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
    setSession((current) => ({
      ...current,
      entries: [
        ...current.entries,
        { id: crypto.randomUUID(), role: "user", content, expected: expectedOutput.trim() || undefined },
      ],
      draft: "",
      chatError: null,
      isSending: true,
    }));

    try {
      const reply = normalizePlaygroundChatReply(
        await postPlaygroundChat({
          model: selectedModel,
          messages: [...history, { role: "user", content }],
          system_prompt: systemPrompt.trim() || undefined,
          session_id: sessionId ?? undefined,
          context: contextText.trim() || undefined,
          use_retrieval: useRetrieval,
          expected_output: expectedOutput.trim() || undefined,
          run_evaluators: runEvaluators,
        }),
      );
      if (!reply) {
        throw new Error("Bir server returned an unexpected playground reply");
      }
      setSession((current) => ({
        ...current,
        entries: [
          ...current.entries,
          { id: crypto.randomUUID(), role: "assistant", content: reply.message.content, reply },
        ],
      }));
      onRefreshHistory();
    } catch (requestError) {
      setSession((current) => ({
        ...current,
        chatError: requestError instanceof Error ? requestError.message : "Playground chat request failed",
      }));
    } finally {
      setSession((current) => ({ ...current, isSending: false }));
    }
  }, [
    contextText,
    draft,
    entries,
    expectedOutput,
    isSending,
    isViewingHistory,
    onRefreshHistory,
    runEvaluators,
    selectedModel,
    sessionId,
    setSession,
    systemPrompt,
    useRetrieval,
  ]);

  const visibleSessionId = isViewingHistory ? selectedHistorySession.sessionId : sessionId;
  const datasetRows = buildDatasetRows(visibleEntries, visibleSessionId);

  const exportDataset = useCallback(() => {
    if (datasetRows.length === 0) {
      return;
    }
    const blob = new Blob([serializeDatasetRows(datasetRows)], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = datasetFileName(visibleSessionId);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [datasetRows, visibleSessionId]);

  const replies = visibleEntries.filter((entry) => entry.reply);
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
                onChange={(event) =>
                  setSession((current) => ({ ...current, selectedModel: event.target.value }))
                }
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
                onChange={(event) =>
                  setSession((current) => ({ ...current, systemPrompt: event.target.value }))
                }
              />
            </label>

            <label className="filter-group">
              <span>Context</span>
              <textarea
                placeholder="Optional context passed to the model as system context"
                rows={4}
                value={contextText}
                onChange={(event) =>
                  setSession((current) => ({ ...current, contextText: event.target.value }))
                }
              />
            </label>

            <label className="toggle-field">
              <input
                type="checkbox"
                checked={useRetrieval}
                onChange={(event) =>
                  setSession((current) => ({ ...current, useRetrieval: event.target.checked }))
                }
              />
              <span>Use context as retrieval</span>
            </label>

            <label className="filter-group">
              <span>Expected Answer</span>
              <textarea
                placeholder="Optional expected answer for the contains_expected evaluator"
                rows={3}
                value={expectedOutput}
                onChange={(event) =>
                  setSession((current) => ({ ...current, expectedOutput: event.target.value }))
                }
              />
            </label>

            <label className="toggle-field">
              <input
                type="checkbox"
                checked={runEvaluators}
                onChange={(event) =>
                  setSession((current) => ({ ...current, runEvaluators: event.target.checked }))
                }
              />
              <span>Run basic evaluators</span>
            </label>

            <button className="filter-clear" type="button" onClick={startNewSession} disabled={isSending}>
              New Session
            </button>
          </div>
          {modelsError ? <div className="state-box error-state">{modelsError}</div> : null}
          {historyError ? <div className="state-box error-state">{historyError}</div> : null}
          <div className="playground-history" aria-label="Playground session history">
            <div className="history-head">
              <h3>Sessions</h3>
              <span>{isHistoryLoading ? "Loading" : `${pastSessions.length} saved`}</span>
            </div>
            <div className="session-items">
              <button
                className={selectedHistorySessionId === null ? "session-row active" : "session-row"}
                type="button"
                onClick={() => onSelectHistorySession(null)}
              >
                <span className="session-name">Current session</span>
                <span className="session-meta">
                  {entries.length === 0 ? "No messages yet" : `${Math.ceil(entries.length / 2)} turns`}
                </span>
              </button>
              {pastSessions.map((historySession) => (
                <button
                  className={
                    historySession.sessionId === selectedHistorySessionId ? "session-row active" : "session-row"
                  }
                  key={historySession.sessionId}
                  type="button"
                  onClick={() => onSelectHistorySession(historySession.sessionId)}
                >
                  <span className="session-name">{formatSessionName(historySession.sessionId)}</span>
                  <span className="session-meta">
                    {formatDate(historySession.endTime)} · {historySession.traceCount} traces
                  </span>
                </button>
              ))}
            </div>
            {!isHistoryLoading && pastSessions.length === 0 ? (
              <p className="subtle">Previous Playground sessions will appear here after traces are recorded.</p>
            ) : null}
            {pastSessions.length > 0 && hasMoreHistory ? (
              <button
                className="history-load-more"
                type="button"
                onClick={onLoadOlderHistory}
                disabled={isHistoryLoading}
              >
                {isHistoryLoading ? "Loading" : "Load older"}
              </button>
            ) : null}
            {hasLoadedHistory && !isHistoryLoading && !hasMoreHistory && pastSessions.length > 0 ? (
              <p className="subtle">End of history.</p>
            ) : null}
          </div>
          <p className="subtle">
            Every reply is recorded as a trace on this Bir server, including the messages you send. Model:{" "}
            {status.upstream_base_url}
          </p>
        </aside>

        <section className="detail-panel chat-panel" aria-label="Playground conversation">
          <div className="detail-head">
            <div>
              <p className="eyebrow">Playground</p>
              <h2>{isViewingHistory ? formatSessionName(selectedHistorySession.sessionId) : (selectedModel ?? "Observed chat")}</h2>
              <p className="subtle">
                {isViewingHistory
                  ? "Reconstructed from stored Playground traces. This session is read-only."
                  : "Each exchange becomes a trace with token usage and latency."}
              </p>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={exportDataset}
              disabled={datasetRows.length === 0}
              title="Download this session's turns as an evals dataset (JSONL) for bir.evals.Dataset.from_jsonl"
            >
              Export dataset
            </button>
          </div>

          <div className="chat-log" ref={logRef}>
            {linkedTraceError ? <div className="error-block">{linkedTraceError} Try refreshing history and opening it again.</div> : null}
            {visibleEntries.length === 0 ? (
              <div className="empty-detail">Send a message to start an observed chat.</div>
            ) : (
              visibleEntries.map((entry) => (
                <article
                  className={`chat-turn ${entry.role}${entry.failedAttempt ? " failed" : ""}`}
                  key={entry.id}
                >
                  <span className="chat-role">
                    {entry.role === "user" ? "You" : (entry.reply?.model ?? entry.failedAttempt?.model ?? "Assistant")}
                  </span>
                  <div className="chat-bubble">
                    {entry.failedAttempt ? (
                      <>
                        <strong>Model call failed</strong>
                        <span>{entry.failedAttempt.error ?? entry.content}</span>
                      </>
                    ) : (
                      entry.content
                    )}
                  </div>
                  {entry.reply ? (
                    <div className="event-fields chat-turn-facts">
                      <InlineField label="Tokens in / out" value={formatTokenCounts(entry.reply)} />
                      <InlineField label="Latency" value={formatLatency(entry.reply.latency_ms)} />
                      {entry.reply.scores.map((score) => (
                        <span
                          className={`score-pill chat-score ${score.value > 0 ? "pass" : "fail"}`}
                          key={score.name}
                        >
                          {score.name} {formatScoreValue(score.value)}
                        </span>
                      ))}
                      <button className="inline-action" type="button" onClick={() => onOpenTrace(entry.reply!.trace_id)}>
                        Open trace
                      </button>
                    </div>
                  ) : null}
                  {entry.failedAttempt ? (
                    <div className="event-fields chat-turn-facts">
                      <InlineField label="Status" value="Error" />
                      <InlineField label="Latency" value={formatLatency(entry.failedAttempt.latency_ms)} />
                      <button
                        className="inline-action"
                        type="button"
                        onClick={() => onOpenTrace(entry.failedAttempt!.traceId)}
                      >
                        Open trace
                      </button>
                    </div>
                  ) : null}
                </article>
              ))
            )}
            {!isViewingHistory && isSending ? <p className="chat-pending">Waiting for {selectedModel ?? "the model"}…</p> : null}
            {!isViewingHistory && chatError ? <div className="error-block">{chatError}</div> : null}
          </div>

          {isViewingHistory ? (
            <div className="chat-readonly">This reconstructed session is read-only. Start a new session to chat.</div>
          ) : (
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
                onChange={(event) => setSession((current) => ({ ...current, draft: event.target.value }))}
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
          )}
        </section>
      </section>
    </>
  );
}

function formatScoreValue(value: number): string {
  // The built-in evaluators are pass/fail; show marks for them and keep
  // numbers for anything else a server might return.
  if (value === 1) {
    return "✓";
  }
  if (value === 0) {
    return "✗";
  }
  return value.toString();
}

function formatTokenCounts(reply: PlaygroundChatReply): string {
  const inputTokens = reply.input_tokens === null ? "-" : reply.input_tokens.toString();
  const outputTokens = reply.output_tokens === null ? "-" : reply.output_tokens.toString();
  return `${inputTokens} / ${outputTokens}`;
}

function formatSessionName(sessionId: string): string {
  return `Session ${sessionId.slice(0, 8)}`;
}

function formatLatency(latencyMs: number): string {
  if (latencyMs < 1000) {
    return `${latencyMs.toFixed(0)} ms`;
  }
  return `${(latencyMs / 1000).toFixed(2)} s`;
}
