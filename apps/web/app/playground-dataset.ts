import type { PlaygroundChatReply } from "./playground-contract";

// Structural subset of PlaygroundConversationEntry / PlaygroundHistoryEntry so
// both live sessions and reconstructed history sessions can be exported.
export type DatasetSourceEntry = {
  role: "user" | "assistant";
  content: string;
  expected?: string;
  reply?: PlaygroundChatReply;
};

// One row in the SDK's evals dataset JSONL format, loadable with
// bir.evals.Dataset.from_jsonl and runnable with run_experiment.
export type PlaygroundDatasetRow = {
  id: string;
  input: string;
  expected: string | null;
  metadata: Record<string, unknown>;
};

export function buildDatasetRows(
  entries: DatasetSourceEntry[],
  sessionId: string | null,
): PlaygroundDatasetRow[] {
  const rows: PlaygroundDatasetRow[] = [];

  for (let index = 0; index < entries.length - 1; index += 1) {
    const userEntry = entries[index];
    const assistantEntry = entries[index + 1];
    if (userEntry.role !== "user" || assistantEntry.role !== "assistant") {
      continue;
    }

    const metadata: Record<string, unknown> = { source: "playground" };
    if (sessionId) {
      metadata.session_id = sessionId;
    }
    if (assistantEntry.reply) {
      metadata.trace_id = assistantEntry.reply.trace_id;
      metadata.model = assistantEntry.reply.model;
    }
    rows.push({
      id: `turn-${rows.length + 1}`,
      input: userEntry.content,
      expected: userEntry.expected ?? null,
      metadata,
    });
  }

  return rows;
}

export function serializeDatasetRows(rows: PlaygroundDatasetRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

export function datasetFileName(sessionId: string | null): string {
  const suffix = sessionId ? sessionId.slice(0, 8) : "session";
  return `playground-dataset-${suffix}.jsonl`;
}
