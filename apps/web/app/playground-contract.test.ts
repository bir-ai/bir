import assert from "node:assert/strict";
import test from "node:test";

import { normalizePlaygroundChatReply } from "./playground-contract";

function makeReplyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: "playground-1",
    message: { role: "assistant", content: "Hello." },
    model: "llama3.2:1b",
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    latency_ms: 250,
    ...overrides,
  };
}

test("normalizes playground chat replies with evaluator scores", () => {
  const reply = normalizePlaygroundChatReply(
    makeReplyPayload({
      scores: [
        { name: "answered", value: 1 },
        { name: "contains_expected", value: 0 },
      ],
    }),
  );

  assert.ok(reply);
  assert.deepEqual(reply.scores, [
    { name: "answered", value: 1 },
    { name: "contains_expected", value: 0 },
  ]);
});

test("defaults scores to an empty list for replies from older servers", () => {
  const reply = normalizePlaygroundChatReply(makeReplyPayload());

  assert.ok(reply);
  assert.deepEqual(reply.scores, []);
});

test("drops malformed score entries instead of rejecting the reply", () => {
  const reply = normalizePlaygroundChatReply(
    makeReplyPayload({
      scores: [{ name: "answered", value: 1 }, { name: "broken" }, "junk", null],
    }),
  );

  assert.ok(reply);
  assert.deepEqual(reply.scores, [{ name: "answered", value: 1 }]);
});

test("still rejects replies missing required fields", () => {
  assert.equal(normalizePlaygroundChatReply(makeReplyPayload({ trace_id: 7 })), null);
  assert.equal(normalizePlaygroundChatReply(null), null);
});
