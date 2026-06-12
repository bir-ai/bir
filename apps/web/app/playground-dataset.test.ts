import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDatasetRows,
  datasetFileName,
  serializeDatasetRows,
  type DatasetSourceEntry,
} from "./playground-dataset";

function makeReply(traceId: string, model = "llama3.2:1b") {
  return {
    trace_id: traceId,
    message: { role: "assistant" as const, content: "Hello." },
    model,
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    latency_ms: 250,
    scores: [],
  };
}

test("builds one dataset row per completed user-assistant turn", () => {
  const entries: DatasetSourceEntry[] = [
    { role: "user", content: "What is Bir?", expected: "observability" },
    { role: "assistant", content: "An observability SDK.", reply: makeReply("trace-1") },
    { role: "user", content: "What format does it use?" },
    { role: "assistant", content: "JSONL.", reply: makeReply("trace-2") },
  ];

  const rows = buildDatasetRows(entries, "session-1");

  assert.deepEqual(rows, [
    {
      id: "turn-1",
      input: "What is Bir?",
      expected: "observability",
      metadata: { source: "playground", session_id: "session-1", trace_id: "trace-1", model: "llama3.2:1b" },
    },
    {
      id: "turn-2",
      input: "What format does it use?",
      expected: null,
      metadata: { source: "playground", session_id: "session-1", trace_id: "trace-2", model: "llama3.2:1b" },
    },
  ]);
});

test("skips incomplete turns and tolerates a missing session id", () => {
  const entries: DatasetSourceEntry[] = [
    { role: "assistant", content: "Orphan reply." },
    { role: "user", content: "Answered question" },
    { role: "assistant", content: "Answer." },
    { role: "user", content: "Pending question without a reply yet" },
  ];

  const rows = buildDatasetRows(entries, null);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, "Answered question");
  assert.deepEqual(rows[0].metadata, { source: "playground" });
});

test("returns no rows for an empty session", () => {
  assert.deepEqual(buildDatasetRows([], "session-1"), []);
});

test("serializes rows as newline-terminated JSONL", () => {
  const serialized = serializeDatasetRows(
    buildDatasetRows(
      [
        { role: "user", content: "Hi", expected: "hello" },
        { role: "assistant", content: "Hello." },
      ],
      "session-1",
    ),
  );

  assert.ok(serialized.endsWith("\n"));
  const lines = serialized.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    id: "turn-1",
    input: "Hi",
    expected: "hello",
    metadata: { source: "playground", session_id: "session-1" },
  });
});

test("names the export file after the session id", () => {
  assert.equal(datasetFileName("32ad9671-58e6-4f6b"), "playground-dataset-32ad9671.jsonl");
  assert.equal(datasetFileName(null), "playground-dataset-session.jsonl");
});
