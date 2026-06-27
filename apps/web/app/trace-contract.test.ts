import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildTraceTimelineRows,
  buildTraceFilterQuery,
  buildTraceSummaryFilterQuery,
  findTraceById,
  getGenerationChatDetails,
  getPromptDetails,
  getRetrievalDetails,
  getTraceScoreGroups,
  getTraceScores,
  getTraceService,
  getTraceTotals,
  isErrorsOnlyFilter,
  normalizeTraceDetail,
  normalizeTraces,
  normalizeTraceSummary,
  summarizeTraces,
  toggleErrorsOnlyFilter,
  type EventStatus,
  type Trace,
  type TraceEvent,
} from "./trace-contract";
import { compareExperiments, normalizeExperiment, normalizeExperimentSummaries } from "./experiment-contract";
import { TraceTimeline } from "./components/trace-timeline";

const contractTraceResponseFixture = loadSharedContractTraceResponse();
const [contractTrace] = normalizeTraces(contractTraceResponseFixture);
assert.ok(contractTrace);
const integrationTraceResponseFixture = loadProductIntegrationTraceResponse();
const integrationTraces = normalizeTraces(integrationTraceResponseFixture);

test("builds trace filter query strings from non-empty filters", () => {
  const query = buildTraceFilterQuery({
    status: "error",
    name: " answer question ",
    event_type: "generation",
  });

  assert.equal(query, "status=error&name=answer+question&event_type=generation");
});

test("omits empty and default trace filters", () => {
  const query = buildTraceFilterQuery({
    status: "all",
    name: "   ",
    event_type: "all",
  });

  assert.equal(query, "");
});

test("builds summary queries from filters without browse window or ordering", () => {
  assert.equal(
    buildTraceSummaryFilterQuery({ status: "error", min_duration_ms: 12.5, sort: "slowest", limit: 100 }),
    "status=error&min_duration_ms=12.5",
  );
});

test("includes service and environment trace filters in the query", () => {
  const query = buildTraceFilterQuery({
    status: "all",
    name: "",
    event_type: "all",
    service: " rag-api ",
    environment: "production",
  });

  assert.equal(query, "service=rag-api&environment=production");
});

test("includes source and recent cursor filters in the trace query", () => {
  const query = buildTraceFilterQuery({
    name: "playground.chat",
    source: "playground",
    limit: 25,
    before_start_time: "2026-01-02T00:00:00.000Z",
    before_id: "trace-2",
  });

  assert.equal(
    query,
    "name=playground.chat&source=playground&limit=25&before_start_time=2026-01-02T00%3A00%3A00.000Z&before_id=trace-2",
  );
});

test("summary queries drop browse cursor filters", () => {
  assert.equal(
    buildTraceSummaryFilterQuery({
      source: "playground",
      limit: 25,
      before_start_time: "2026-01-02T00:00:00.000Z",
      before_id: "trace-2",
    }),
    "source=playground",
  );
});

test("includes a positive integer limit in the trace filter query", () => {
  assert.equal(buildTraceFilterQuery({ limit: 100 }), "limit=100");
});

test("omits the limit when it is undefined", () => {
  assert.equal(buildTraceFilterQuery({ status: "all", name: "", event_type: "all" }), "");
});

test("omits an invalid limit from the trace filter query", () => {
  assert.equal(buildTraceFilterQuery({ limit: 0 }), "");
  assert.equal(buildTraceFilterQuery({ limit: -5 }), "");
  assert.equal(buildTraceFilterQuery({ limit: 12.5 }), "");
  assert.equal(buildTraceFilterQuery({ limit: Number.NaN }), "");
  assert.equal(buildTraceFilterQuery({ limit: Number.POSITIVE_INFINITY }), "");
});

test("composes the limit with existing trace filters", () => {
  const query = buildTraceFilterQuery({
    status: "error",
    name: " answer question ",
    event_type: "generation",
    source: "playground",
    service: " rag-api ",
    environment: "production",
    limit: 50,
  });

  assert.equal(
    query,
    "status=error&name=answer+question&event_type=generation&source=playground&service=rag-api&environment=production&limit=50",
  );
});

test("forwards a positive, finite min_duration_ms in the trace filter query", () => {
  assert.equal(buildTraceFilterQuery({ min_duration_ms: 250 }), "min_duration_ms=250");
  // Durations are floats on the server (Query(gt=0) has no integer bound), so a
  // fractional threshold forwards unchanged rather than being rejected like limit.
  assert.equal(buildTraceFilterQuery({ min_duration_ms: 12.5 }), "min_duration_ms=12.5");
});

test("omits the min_duration_ms when unset, NaN, infinite, or non-positive", () => {
  assert.equal(buildTraceFilterQuery({ status: "all", name: "", event_type: "all" }), "");
  assert.equal(buildTraceFilterQuery({ min_duration_ms: 0 }), "");
  assert.equal(buildTraceFilterQuery({ min_duration_ms: -5 }), "");
  assert.equal(buildTraceFilterQuery({ min_duration_ms: Number.NaN }), "");
  assert.equal(buildTraceFilterQuery({ min_duration_ms: Number.POSITIVE_INFINITY }), "");
});

test("composes the min_duration_ms with existing trace filters", () => {
  const query = buildTraceFilterQuery({
    status: "error",
    source: "playground",
    min_duration_ms: 250,
    sort: "slowest",
    limit: 50,
  });

  assert.equal(query, "status=error&source=playground&min_duration_ms=250&sort=slowest&limit=50");
});

test("summary queries keep source with other filters while dropping browse-only params", () => {
  assert.equal(
    buildTraceSummaryFilterQuery({
      status: "error",
      name: " playground.chat ",
      source: "playground",
      service: "web",
      environment: "dev",
      min_duration_ms: 250,
      sort: "slowest",
      limit: 25,
      before_start_time: "2026-01-02T00:00:00.000Z",
      before_id: "trace-2",
    }),
    "status=error&name=playground.chat&source=playground&service=web&environment=dev&min_duration_ms=250",
  );
});

test("forwards the slowest sort and omits the default recent sort", () => {
  assert.equal(buildTraceFilterQuery({ sort: "slowest" }), "sort=slowest");
  assert.equal(buildTraceFilterQuery({ sort: "recent" }), "");
  assert.equal(buildTraceFilterQuery({ status: "all", name: "", event_type: "all" }), "");
});

test("composes the slowest sort with existing trace filters", () => {
  const query = buildTraceFilterQuery({ status: "error", sort: "slowest", limit: 50 });

  assert.equal(query, "status=error&sort=slowest&limit=50");
});

test("detects the errors-only status shortcut", () => {
  assert.equal(isErrorsOnlyFilter({ status: "error" }), true);
  assert.equal(isErrorsOnlyFilter({ status: "all" }), false);
  assert.equal(isErrorsOnlyFilter({ status: "success" }), false);
  assert.equal(isErrorsOnlyFilter({}), false);
});

test("toggles the errors-only shortcut on while preserving other filters", () => {
  assert.deepEqual(
    toggleErrorsOnlyFilter({ status: "all", name: "answer", service: "rag-api", sort: "slowest" }),
    { status: "error", name: "answer", service: "rag-api", sort: "slowest" },
  );
  // Any non-error status turns the shortcut on rather than acting as a no-op.
  assert.deepEqual(toggleErrorsOnlyFilter({ status: "success" }), { status: "error" });
});

test("toggles the errors-only shortcut back off to all", () => {
  assert.deepEqual(
    toggleErrorsOnlyFilter({ status: "error", sort: "slowest" }),
    { status: "all", sort: "slowest" },
  );
});

test("orders normalized traces slowest first by root duration", () => {
  const baseStart = "2026-01-01T00:00:00.000+00:00";
  const baseMs = Date.parse(baseStart);
  const response = [100, 400, 200].map((durationMs, index) => ({
    ...summarizableTrace({
      id: `trace-${index}`,
      start: baseStart,
      end: new Date(baseMs + durationMs).toISOString(),
    }),
  }));

  const recent = normalizeTraces(response);
  const slowest = normalizeTraces(response, "slowest");

  // Equal start times, so recency leaves the ids in their original order.
  assert.deepEqual(recent.map((trace) => trace.id), ["trace-0", "trace-1", "trace-2"]);
  // 400ms (trace-1) is slowest, then 200ms (trace-2), then 100ms (trace-0).
  assert.deepEqual(slowest.map((trace) => trace.id), ["trace-1", "trace-2", "trace-0"]);
});

test("extracts service metadata from the trace root event", () => {
  const trace = summarizableTrace({
    id: "trace-service",
    rootMetadata: { service: { name: "rag-api", environment: "production" } },
  });

  assert.deepEqual(getTraceService(trace), { name: "rag-api", environment: "production" });
});

test("returns null when the trace root has no service metadata", () => {
  const trace = summarizableTrace({ id: "trace-bare" });

  assert.equal(getTraceService(trace), null);
});

test("ignores non-string service metadata fields", () => {
  const trace = summarizableTrace({
    id: "trace-partial",
    rootMetadata: { service: { name: "rag-api", environment: 7 } },
  });

  assert.deepEqual(getTraceService(trace), { name: "rag-api" });
});

test("extracts service metadata from the shared contract fixture root", () => {
  assert.deepEqual(getTraceService(contractTrace), { name: "rag-api", environment: "production" });
});

test("normalizes valid trace responses from the shared contract fixture", () => {
  const traces = normalizeTraces(contractTraceResponseFixture);

  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, "trace-fixture-1");
  assert.deepEqual(
    traces[0].events.map((event) => event.type),
    ["trace", "span", "tool_call", "generation", "score"],
  );
  const retrievalEvent = traces[0].events.find((event) => event.type === "tool_call");
  assert.deepEqual(retrievalEvent?.output, {
    documents: [
      {
        id: "doc-1",
        rank: 1,
        score: 0.82,
        source: "docs",
        text: "Bir records local traces with JSONL.",
      },
    ],
  });
  const generationEvent = traces[0].events.find((event) => event.type === "generation");
  assert.deepEqual(generationEvent?.cost, { input_cost: 0.000012, output_cost: 0.000048, total_cost: 0.00006 });
  assert.equal(generationEvent?.currency, "USD");
});

test("normalizes representative SDK integration trace fixtures", () => {
  assert.equal(integrationTraces.length, 6);
  assert.deepEqual(
    integrationTraces.map((trace) => trace.id).sort(),
    [
      "trace-crewai-crew",
      "trace-dspy-program",
      "trace-haystack-pipeline",
      "trace-instructor-call",
      "trace-openai-agents-workflow",
      "trace-pydantic-ai-agent",
    ],
  );

  const haystack = integrationTrace("trace-haystack-pipeline");
  const haystackGeneration = haystack.events.find((event) => event.id === "generation-haystack-llm");
  assert.ok(haystackGeneration);
  assert.equal(haystackGeneration.metadata.integration, "haystack");
  assert.equal(haystackGeneration.metadata.haystack_component_type, "OpenAIGenerator");
  assert.equal(haystackGeneration.model, "gpt-4o");
  assert.deepEqual(haystackGeneration.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  assert.deepEqual(haystackGeneration.cost, {
    input_cost: 0.000025,
    output_cost: 0.00005,
    total_cost: 0.000075,
  });
  assert.equal(haystackGeneration.currency, "USD");

  const pydanticAI = integrationTrace("trace-pydantic-ai-agent");
  const pydanticTool = pydanticAI.events.find((event) => event.id === "tool-pydantic-ai-weather");
  assert.ok(pydanticTool);
  assert.equal(pydanticTool.metadata.integration, "pydantic_ai");
  assert.equal(pydanticTool.metadata.gen_ai_tool_call_id, "call_1");
});

test("accepts omitted optional fields and canonical explicit nulls", () => {
  const sdkStyle = summarizableTrace({ id: "trace-sdk-style" });
  const canonical = summarizableTrace({ id: "trace-canonical" });
  canonical.events[0] = {
    ...canonical.events[0],
    value: null,
    model: null,
    usage: null,
    cost: null,
    currency: null,
  };

  assert.equal(normalizeTraces([sdkStyle]).length, 1);
  const normalizedCanonical = normalizeTraces([canonical]);
  assert.equal(normalizedCanonical.length, 1);
  assert.deepEqual(
    ["value", "model", "usage", "cost", "currency"].map(
      (field) => normalizedCanonical[0].events[0][field as keyof TraceEvent],
    ),
    [null, null, null, null, null],
  );
});

test("requires a numeric value for score events", () => {
  const trace = summarizableTrace({ id: "trace-score-contract" });
  const root = trace.events[0];
  trace.events.push({
    ...root,
    id: "score-contract",
    parent_id: root.id,
    type: "score",
    name: "helpfulness",
    value: null,
  });

  assert.deepEqual(normalizeTraces([trace]), []);
  trace.events[1].value = 0.82;
  assert.equal(normalizeTraces([trace]).length, 1);
});

test("extracts retrieval query and documents from the shared contract fixture", () => {
  const retrievalEvent = contractTrace.events.find(
    (event) => event.type === "tool_call" && event.metadata.kind === "retrieval",
  );
  assert.ok(retrievalEvent);

  const details = getRetrievalDetails(retrievalEvent);

  assert.deepEqual(details, {
    query: "hello",
    documents: [
      {
        id: "doc-1",
        rank: 1,
        score: 0.82,
        source: "docs",
        text: "Bir records local traces with JSONL.",
      },
    ],
  });
});

test("does not treat ordinary tool calls as retrieval events", () => {
  const retrievalEvent = contractTrace.events.find((event) => event.type === "tool_call");
  assert.ok(retrievalEvent);
  const ordinaryToolEvent: TraceEvent = {
    ...retrievalEvent,
    metadata: { kind: "calculator" },
  };

  assert.equal(getRetrievalDetails(ordinaryToolEvent), null);
});

test("extracts prompt metadata from generation events", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const promptedGeneration: TraceEvent = {
    ...generationEvent,
    metadata: {
      prompt: {
        name: "answer_question",
        version: "v1",
        template_sha256: "abc123",
        template: "Answer {question}",
        variables: { question: "What is Bir?" },
        rendered: "Answer What is Bir?",
        metadata: { owner: "evals" },
        ignored_numeric_field: 123,
      },
    },
  };

  const details = getPromptDetails(promptedGeneration);

  assert.deepEqual(details, {
    name: "answer_question",
    version: "v1",
    template_sha256: "abc123",
    template: "Answer {question}",
    variables: { question: "What is Bir?" },
    rendered: "Answer What is Bir?",
    metadata: { owner: "evals" },
  });
});

test("extracts prompt metadata from the shared contract fixture generation", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);

  assert.deepEqual(getPromptDetails(generationEvent), {
    name: "answer_question",
    version: "v1",
    template_sha256: "83ae0f830c7c24dbe19a8c08a882747e09a11257a5153d4a1ac46c9a0ab4374a",
  });
});

test("ignores malformed prompt metadata", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const missingName: TraceEvent = {
    ...generationEvent,
    metadata: { prompt: { version: "v1" } },
  };
  const emptyName: TraceEvent = {
    ...generationEvent,
    metadata: { prompt: { name: "" } },
  };
  const nonObjectPrompt: TraceEvent = {
    ...generationEvent,
    metadata: { prompt: "answer_question" },
  };

  assert.equal(getPromptDetails(missingName), null);
  assert.equal(getPromptDetails(emptyName), null);
  assert.equal(getPromptDetails(nonObjectPrompt), null);
});

test("does not extract prompt metadata from non-generation events", () => {
  const traceEvent = contractTrace.events.find((event) => event.type === "trace");
  assert.ok(traceEvent);
  const eventWithPrompt: TraceEvent = {
    ...traceEvent,
    metadata: { prompt: { name: "answer_question" } },
  };

  assert.equal(getPromptDetails(eventWithPrompt), null);
});

test("extracts chat messages and output text from playground-style generations", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const chatGeneration: TraceEvent = {
    ...generationEvent,
    input: {
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "What is Bir?" },
      ],
    },
    output: "Bir is an observability SDK.",
  };

  const details = getGenerationChatDetails(chatGeneration);

  assert.deepEqual(details, {
    messages: [
      { role: "system", content: "Answer briefly." },
      { role: "user", content: "What is Bir?" },
    ],
    outputText: "Bir is an observability SDK.",
  });
});

test("ignores generations whose input is not a chat message list", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const spanEvent = contractTrace.events.find((event) => event.type === "span");
  assert.ok(spanEvent);
  const malformedMessages: TraceEvent = {
    ...generationEvent,
    input: { messages: [{ role: "user" }] },
  };
  const chatShapedSpan: TraceEvent = {
    ...spanEvent,
    input: { messages: [{ role: "user", content: "hi" }] },
  };

  assert.equal(getGenerationChatDetails(generationEvent), null);
  assert.equal(getGenerationChatDetails(malformedMessages), null);
  assert.equal(getGenerationChatDetails(chatShapedSpan), null);
});

test("keeps a structured generation output out of the chat details text", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);
  const structuredOutput: TraceEvent = {
    ...generationEvent,
    input: { messages: [{ role: "user", content: "hi" }] },
    output: { message: "ok" },
  };

  const details = getGenerationChatDetails(structuredOutput);

  assert.ok(details);
  assert.equal(details.outputText, null);
});

test("collects score events from a trace", () => {
  const scores = getTraceScores(contractTrace.events);

  assert.deepEqual(scores, [{ name: "helpfulness", value: 0.82 }]);
});

test("carries score metadata when present", () => {
  const scoreEvent = contractTrace.events.find((event) => event.type === "score");
  assert.ok(scoreEvent);
  const annotatedScore: TraceEvent = {
    ...scoreEvent,
    metadata: { reason: "cites context", threshold: 0.5 },
  };

  assert.deepEqual(getTraceScores([annotatedScore]), [
    { name: "helpfulness", value: 0.82, metadata: { reason: "cites context", threshold: 0.5 } },
  ]);
});

test("skips score events without a numeric value when collecting scores", () => {
  const scoreEvent = contractTrace.events.find((event) => event.type === "score");
  assert.ok(scoreEvent);
  const valuelessScore: TraceEvent = { ...scoreEvent, id: "score-no-value" };
  delete valuelessScore.value;

  assert.deepEqual(getTraceScores([valuelessScore]), []);
});

test("splits faithfulness scores into their own group ahead of other scores", () => {
  const scoreEvent = contractTrace.events.find((event) => event.type === "score");
  assert.ok(scoreEvent);
  // scoreEvent is the fixture "helpfulness" 0.82 score, an ordinary score.
  const faithfulnessScore: TraceEvent = {
    ...scoreEvent,
    id: "score-overlap",
    name: "answer_context_overlap",
    value: 0.74,
    metadata: { overlap_ratio: 0.74, min_ratio: 0.5 },
  };

  // Faithfulness leads even though its score appears second in the event list.
  assert.deepEqual(getTraceScoreGroups([scoreEvent, faithfulnessScore]), [
    {
      key: "faithfulness",
      scores: [{ name: "answer_context_overlap", value: 0.74, metadata: { overlap_ratio: 0.74, min_ratio: 0.5 } }],
    },
    { key: "other", scores: [{ name: "helpfulness", value: 0.82 }] },
  ]);
});

test("routes scores into the faithfulness group via score metadata", () => {
  const scoreEvent = contractTrace.events.find((event) => event.type === "score");
  assert.ok(scoreEvent);
  const taggedScore: TraceEvent = {
    ...scoreEvent,
    id: "score-tagged",
    name: "custom_grounding",
    metadata: { group: "faithfulness" },
  };

  assert.deepEqual(getTraceScoreGroups([taggedScore]), [
    { key: "faithfulness", scores: [{ name: "custom_grounding", value: 0.82, metadata: { group: "faithfulness" } }] },
  ]);
});

test("returns no score groups when a trace has no scores", () => {
  const generationEvent = contractTrace.events.find((event) => event.type === "generation");
  assert.ok(generationEvent);

  assert.deepEqual(getTraceScoreGroups([generationEvent]), []);
});

test("ignores malformed trace responses without throwing", () => {
  const malformedTrace = {
    ...contractTrace,
    events: [{ ...contractTrace.events[0], type: "unknown" }],
  };

  const traces = normalizeTraces([null, {}, malformedTrace, contractTrace]);

  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, contractTrace.id);
});

test("reports an explicit error result for malformed trace detail", () => {
  const malformedTrace = {
    ...contractTrace,
    events: [{ ...contractTrace.events[0], type: "unknown" }],
  };

  assert.deepEqual(normalizeTraceDetail(malformedTrace, contractTrace.id), {
    kind: "invalid",
    message: "Bir server returned an unexpected trace detail.",
  });
});

test("reports an explicit error result for mismatched trace detail", () => {
  assert.deepEqual(normalizeTraceDetail({ ...contractTrace, id: "other-trace" }, contractTrace.id), {
    kind: "invalid",
    message: "Bir server returned trace detail for a different trace.",
  });
});

test("builds nested timeline rows from parent-child event relationships", () => {
  const rows = buildTraceTimelineRows(contractTrace.events);

  assert.deepEqual(
    rows.map((row) => ({
      name: row.event.name,
      depth: row.depth,
      isOrphan: row.isOrphan,
    })),
    [
      { name: "answer_question", depth: 0, isOrphan: false },
      { name: "retrieve_context", depth: 1, isOrphan: false },
      { name: "search_docs", depth: 2, isOrphan: false },
      { name: "local.llm", depth: 1, isOrphan: false },
      { name: "helpfulness", depth: 2, isOrphan: false },
    ],
  );
});

test("builds timeline rows for nested SDK integration traces", () => {
  const crewaiRows = buildTraceTimelineRows(integrationTrace("trace-crewai-crew").events);
  assert.deepEqual(
    crewaiRows.map((row) => ({
      name: row.event.name,
      depth: row.depth,
      isOrphan: row.isOrphan,
    })),
    [
      { name: "Research crew", depth: 0, isOrphan: false },
      { name: "Summarize", depth: 1, isOrphan: false },
      { name: "Researcher", depth: 2, isOrphan: false },
      { name: "crewai.llm_call", depth: 3, isOrphan: false },
      { name: "web_search", depth: 3, isOrphan: false },
    ],
  );

  const agentsRows = buildTraceTimelineRows(integrationTrace("trace-openai-agents-workflow").events);
  assert.deepEqual(
    agentsRows.map((row) => [row.event.name, row.depth]),
    [
      ["Joke workflow", 0],
      ["Assistant", 1],
      ["openai_agents.generation", 2],
      ["get_weather", 2],
    ],
  );
});

test("renders SDK integration timeline metadata and generation stats", () => {
  const rows = buildTraceTimelineRows(integrationTrace("trace-crewai-crew").events);
  const html = renderToStaticMarkup(createElement(TraceTimeline, { rows }));

  assert.match(html, /Research crew/);
  assert.match(html, /crewai\.llm_call/);
  assert.match(html, /Model/);
  assert.match(html, /gpt-4o/);
  assert.match(html, /Usage/);
  assert.match(html, /total_tokens: 16/);
  assert.match(html, /Cost/);
  assert.match(html, /total_cost: 0\.00008 USD/);
  assert.match(html, /Metadata/);
  assert.match(html, /crewai/);
  assert.match(html, /agent_role/);
});

test("marks events whose parent is missing as orphan timeline rows", () => {
  const spanEvent = contractTrace.events.find((event) => event.type === "span");
  assert.ok(spanEvent);

  const orphanEvent: TraceEvent = {
    ...spanEvent,
    id: "orphan-span",
    parent_id: "missing-parent",
    name: "orphan_step",
  };
  const traceWithOrphan: Trace = {
    ...contractTrace,
    events: [...contractTrace.events, orphanEvent],
  };

  const rows = buildTraceTimelineRows(traceWithOrphan.events);
  const orphanRow = rows.find((row) => row.event.id === orphanEvent.id);

  assert.ok(orphanRow);
  assert.equal(orphanRow.depth, 0);
  assert.equal(orphanRow.isOrphan, true);
});

test("summarizes generation tokens and cost across traces", () => {
  const traces = [
    summarizableTrace({
      id: "trace-a",
      start: "2026-01-01T00:00:00.000+00:00",
      end: "2026-01-01T00:00:00.100+00:00",
      generations: [
        generationEvent({
          id: "gen-a",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          cost: { total_cost: 0.0006 },
          currency: "USD",
        }),
      ],
    }),
    summarizableTrace({
      id: "trace-b",
      start: "2026-01-01T00:00:00.000+00:00",
      end: "2026-01-01T00:00:00.300+00:00",
      generations: [
        generationEvent({
          id: "gen-b",
          // No total_tokens, so the helper falls back to input + output tokens.
          usage: { input_tokens: 30, output_tokens: 10 },
          cost: { total_cost: 0.0004 },
          currency: "USD",
        }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.equal(summary.traceCount, 2);
  assert.equal(summary.eventCount, 4);
  assert.equal(summary.generationCount, 2);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.totalTokens, 160);
  assert.ok(Math.abs(summary.totalCost - 0.001) < 1e-9);
  assert.equal(summary.currency, "USD");
});

test("computes p50 and p95 latency over trace root durations", () => {
  const baseStart = "2026-01-01T00:00:00.000+00:00";
  const baseMs = Date.parse(baseStart);
  const traces = [100, 300, 200, 400].map((durationMs, index) =>
    summarizableTrace({
      id: `trace-${index}`,
      start: baseStart,
      end: new Date(baseMs + durationMs).toISOString(),
    }),
  );

  const summary = summarizeTraces(traces);

  assert.equal(summary.p50LatencyMs, 200);
  assert.equal(summary.p95LatencyMs, 400);
});

test("returns a zeroed summary for an empty trace list", () => {
  assert.deepEqual(summarizeTraces([]), {
    traceCount: 0,
    eventCount: 0,
    generationCount: 0,
    errorCount: 0,
    totalTokens: 0,
    totalCost: 0,
    currency: null,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    models: [],
    providers: [],
    integrations: [],
  });
});

test("normalizes an explicit server trace summary", () => {
  const summary = normalizeTraceSummary({
    trace_count: 250,
    event_count: 500,
    generation_count: 100,
    error_count: 2,
    total_tokens: 1234,
    total_cost: 0.25,
    currency: "USD",
    p50_latency_ms: 20,
    p95_latency_ms: 80,
    models: [
      {
        model: "gpt-4o-mini",
        generation_count: 100,
        total_tokens: 1234,
        input_tokens: 1000,
        output_tokens: 234,
        total_cost: 0.25,
      },
    ],
    providers: [
      {
        provider: "openai",
        generation_count: 100,
        total_tokens: 1234,
        input_tokens: 1000,
        output_tokens: 234,
        total_cost: 0.25,
      },
    ],
    integrations: [
      {
        integration: "crewai",
        generation_count: 25,
        total_tokens: 500,
        input_tokens: 400,
        output_tokens: 100,
        total_cost: 0.1,
      },
    ],
  });

  assert.ok(summary);
  assert.equal(summary.traceCount, 250);
  assert.equal(summary.models[0]?.model, "gpt-4o-mini");
  assert.equal(summary.providers[0]?.provider, "openai");
  assert.equal(summary.integrations[0]?.integration, "crewai");

  const legacySummary = normalizeTraceSummary({
    trace_count: 1,
    event_count: 1,
    generation_count: 0,
    error_count: 0,
    total_tokens: 0,
    total_cost: 0,
    currency: null,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    models: [],
    providers: [],
  });
  assert.deepEqual(legacySummary?.integrations, []);
});

test("rejects malformed or non-finite server trace summaries", () => {
  const valid = {
    trace_count: 0,
    event_count: 0,
    generation_count: 0,
    error_count: 0,
    total_tokens: 0,
    total_cost: 0,
    currency: null,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    models: [],
    providers: [],
    integrations: [],
  };
  assert.equal(normalizeTraceSummary({ ...valid, total_cost: Number.POSITIVE_INFINITY }), null);
  assert.equal(normalizeTraceSummary({ ...valid, trace_count: 1.5 }), null);
  assert.equal(normalizeTraceSummary({ ...valid, currency: "" }), null);
  assert.equal(normalizeTraceSummary({ ...valid, integrations: [{ integration: "" }] }), null);
});

test("server summary state remains independent of loaded page contents", () => {
  const loadedPage = [summarizableTrace({ id: "loaded-only" })];
  const serverSummary = normalizeTraceSummary({
    trace_count: 250,
    event_count: 500,
    generation_count: 0,
    error_count: 0,
    total_tokens: 0,
    total_cost: 0,
    currency: null,
    p50_latency_ms: 10,
    p95_latency_ms: 50,
    models: [],
    providers: [],
    integrations: [],
  });

  assert.equal(summarizeTraces(loadedPage).traceCount, 1);
  assert.equal(serverSummary?.traceCount, 250);
});

test("handles traces without generations or usage and counts errors", () => {
  const traces = [
    summarizableTrace({
      id: "trace-no-gen",
      status: "error",
      start: "2026-01-01T00:00:00.000+00:00",
      end: "2026-01-01T00:00:00.050+00:00",
    }),
    summarizableTrace({
      id: "trace-bare-gen",
      generations: [generationEvent({ id: "gen-bare" })],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.equal(summary.generationCount, 1);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.totalTokens, 0);
  assert.equal(summary.totalCost, 0);
  assert.equal(summary.currency, null);
  // Durations are [0, 50]; nearest-rank p95 picks the max so the 50ms trace counts.
  assert.equal(summary.p95LatencyMs, 50);
});

test("reports null currency when generations mix currencies", () => {
  const traces = [
    summarizableTrace({
      id: "trace-usd",
      generations: [generationEvent({ id: "gen-usd", cost: { total_cost: 0.001 }, currency: "USD" })],
    }),
    summarizableTrace({
      id: "trace-eur",
      generations: [generationEvent({ id: "gen-eur", cost: { total_cost: 0.002 }, currency: "EUR" })],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.equal(summary.currency, null);
  assert.ok(Math.abs(summary.totalCost - 0.003) < 1e-9);
});

test("groups generation tokens and cost by model ordered by generation count", () => {
  const traces = [
    summarizableTrace({
      id: "trace-models",
      generations: [
        generationEvent({
          id: "gen-a1",
          model: "gpt-4o-mini",
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          cost: { total_cost: 0.0006 },
          currency: "USD",
        }),
        generationEvent({
          id: "gen-a2",
          model: "gpt-4o-mini",
          // No total_tokens, so the helper falls back to input + output tokens.
          usage: { input_tokens: 50, output_tokens: 10 },
          cost: { total_cost: 0.0004 },
          currency: "USD",
        }),
        generationEvent({
          id: "gen-b1",
          model: "claude-3-5-sonnet",
          usage: { total_tokens: 240 },
          cost: { total_cost: 0.003 },
          currency: "USD",
        }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  // gpt-4o-mini has two generations, so it sorts ahead of the single-call model.
  assert.equal(summary.models.length, 2);
  const [first, second] = summary.models;

  assert.equal(first.model, "gpt-4o-mini");
  assert.equal(first.generationCount, 2);
  assert.equal(first.totalTokens, 180);
  // Both gpt-4o-mini generations report the split, so it sums field by field.
  assert.equal(first.inputTokens, 150);
  assert.equal(first.outputTokens, 30);
  assert.ok(Math.abs(first.totalCost - 0.001) < 1e-9);

  assert.equal(second.model, "claude-3-5-sonnet");
  assert.equal(second.generationCount, 1);
  assert.equal(second.totalTokens, 240);
  // claude-3-5-sonnet reports only total_tokens, so the split stays unknown (0/0)
  // rather than being derived from the 240-token total.
  assert.equal(second.inputTokens, 0);
  assert.equal(second.outputTokens, 0);
  assert.ok(Math.abs(second.totalCost - 0.003) < 1e-9);
});

test("buckets generations without a model under unknown and breaks count ties by model name", () => {
  const traces = [
    summarizableTrace({
      id: "trace-unknown",
      generations: [
        generationEvent({ id: "gen-zeta", model: "zeta", usage: { total_tokens: 10 } }),
        // No model field, so this generation collapses into the shared "unknown" bucket.
        generationEvent({ id: "gen-none", usage: { total_tokens: 5 } }),
        generationEvent({ id: "gen-alpha", model: "alpha", usage: { total_tokens: 7 } }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  // Each model has one generation, so the tie breaks on model name ascending.
  assert.deepEqual(
    summary.models.map((entry) => entry.model),
    ["alpha", "unknown", "zeta"],
  );
  assert.deepEqual(
    summary.models.find((entry) => entry.model === "unknown"),
    { model: "unknown", generationCount: 1, totalTokens: 5, inputTokens: 0, outputTokens: 0, totalCost: 0 },
  );
});

test("groups generation tokens and cost by provider ordered by generation count", () => {
  const traces = [
    summarizableTrace({
      id: "trace-providers",
      generations: [
        generationEvent({
          id: "gen-p1",
          // metadata.provider wins over the default "playground.llm" name prefix.
          metadata: { provider: "openai" },
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          cost: { total_cost: 0.0006 },
          currency: "USD",
        }),
        generationEvent({
          id: "gen-p2",
          metadata: { provider: "openai" },
          // No total_tokens, so the helper falls back to input + output tokens.
          usage: { input_tokens: 50, output_tokens: 10 },
          cost: { total_cost: 0.0004 },
          currency: "USD",
        }),
        generationEvent({
          id: "gen-p3",
          metadata: { provider: "anthropic" },
          usage: { total_tokens: 240 },
          cost: { total_cost: 0.003 },
          currency: "USD",
        }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  // openai has two generations, so it sorts ahead of the single-call provider.
  assert.equal(summary.providers.length, 2);
  const [first, second] = summary.providers;

  assert.equal(first.provider, "openai");
  assert.equal(first.generationCount, 2);
  assert.equal(first.totalTokens, 180);
  // Both openai generations report the split, so it sums field by field.
  assert.equal(first.inputTokens, 150);
  assert.equal(first.outputTokens, 30);
  assert.ok(Math.abs(first.totalCost - 0.001) < 1e-9);

  assert.equal(second.provider, "anthropic");
  assert.equal(second.generationCount, 1);
  assert.equal(second.totalTokens, 240);
  // anthropic reports only total_tokens, so the split stays unknown (0/0) rather
  // than being derived from the 240-token total.
  assert.equal(second.inputTokens, 0);
  assert.equal(second.outputTokens, 0);
  assert.ok(Math.abs(second.totalCost - 0.003) < 1e-9);
});

test("derives the provider from the generation name and breaks count ties by provider name", () => {
  const traces = [
    summarizableTrace({
      id: "trace-provider-names",
      generations: [
        // Dotted names derive the provider from the namespace prefix.
        generationEvent({ id: "gen-openai", name: "openai.chat.completions", usage: { total_tokens: 10 } }),
        // No provider metadata and a dotless name, so this collapses into "unknown".
        generationEvent({ id: "gen-bare", name: "generate", usage: { total_tokens: 5 } }),
        generationEvent({ id: "gen-anthropic", name: "anthropic.messages", usage: { total_tokens: 7 } }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  // Each provider has one generation, so the tie breaks on provider name ascending.
  assert.deepEqual(
    summary.providers.map((entry) => entry.provider),
    ["anthropic", "openai", "unknown"],
  );
  assert.deepEqual(
    summary.providers.find((entry) => entry.provider === "unknown"),
    { provider: "unknown", generationCount: 1, totalTokens: 5, inputTokens: 0, outputTokens: 0, totalCost: 0 },
  );
});

test("prefers metadata.provider over the generation name prefix", () => {
  const traces = [
    summarizableTrace({
      id: "trace-provider-override",
      generations: [
        generationEvent({
          id: "gen-override",
          // The name would derive "openai", but the explicit provider wins.
          name: "openai.chat.completions",
          metadata: { provider: "azure-openai" },
          usage: { total_tokens: 100 },
        }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.equal(summary.providers.length, 1);
  assert.equal(summary.providers[0].provider, "azure-openai");
});

test("surfaces metadata.integration separately from provider attribution", () => {
  const traces = [
    summarizableTrace({
      id: "trace-integrations",
      generations: [
        generationEvent({
          id: "gen-integration",
          name: "crewai.llm.completion",
          metadata: { integration: "crewai" },
          usage: { total_tokens: 10, input_tokens: 3, output_tokens: 7 },
          cost: { total_cost: 1 },
          currency: "USD",
        }),
        generationEvent({
          id: "gen-explicit-provider",
          name: "crewai.llm.completion",
          metadata: { integration: "crewai", provider: "openai" },
          usage: { total_tokens: 20, input_tokens: 8, output_tokens: 12 },
          cost: { total_cost: 2 },
          currency: "USD",
        }),
        generationEvent({ id: "gen-dotted-provider", name: "openai.chat.completions", usage: { total_tokens: 5 } }),
      ],
    }),
  ];

  const summary = summarizeTraces(traces);

  assert.deepEqual(summary.providers, [
    { provider: "openai", generationCount: 2, totalTokens: 25, inputTokens: 8, outputTokens: 12, totalCost: 2 },
    { provider: "unknown", generationCount: 1, totalTokens: 10, inputTokens: 3, outputTokens: 7, totalCost: 1 },
  ]);
  assert.deepEqual(summary.integrations, [
    { integration: "crewai", generationCount: 2, totalTokens: 30, inputTokens: 11, outputTokens: 19, totalCost: 3 },
  ]);
});

test("summarizes representative SDK integration traces by model, provider, and integration", () => {
  const summary = summarizeTraces(integrationTraces);

  assert.equal(summary.traceCount, 6);
  assert.equal(summary.eventCount, 21);
  assert.equal(summary.generationCount, 6);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.totalTokens, 91);
  assert.ok(Math.abs(summary.totalCost - 0.000455) < 1e-12);
  assert.equal(summary.currency, "USD");
  assert.deepEqual(
    summary.models.map(({ model, generationCount, totalTokens, inputTokens, outputTokens }) => ({
      model,
      generationCount,
      totalTokens,
      inputTokens,
      outputTokens,
    })),
    [
      {
        model: "gpt-4o",
        generationCount: 4,
        totalTokens: 64,
        inputTokens: 43,
        outputTokens: 21,
      },
      {
        model: "gpt-4o-mini-response",
        generationCount: 2,
        totalTokens: 27,
        inputTokens: 18,
        outputTokens: 9,
      },
    ],
  );
  assert.ok(Math.abs((summary.models[0]?.totalCost ?? 0) - 0.00032) < 1e-12);
  assert.ok(Math.abs((summary.models[1]?.totalCost ?? 0) - 0.000135) < 1e-12);
  assert.deepEqual(
    summary.providers.map(({ provider, generationCount, totalTokens, inputTokens, outputTokens }) => ({
      provider,
      generationCount,
      totalTokens,
      inputTokens,
      outputTokens,
    })),
    [
      {
        provider: "unknown",
        generationCount: 5,
        totalTokens: 76,
        inputTokens: 51,
        outputTokens: 25,
      },
      {
        provider: "openai",
        generationCount: 1,
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
      },
    ],
  );
  assert.ok(Math.abs((summary.providers[0]?.totalCost ?? 0) - 0.00038) < 1e-12);
  assert.ok(Math.abs((summary.providers[1]?.totalCost ?? 0) - 0.000075) < 1e-12);
  assert.deepEqual(
    summary.integrations.map((entry) => ({
      integration: entry.integration,
      generationCount: entry.generationCount,
      totalTokens: entry.totalTokens,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    })),
    [
      {
        integration: "crewai",
        generationCount: 1,
        totalTokens: 16,
        inputTokens: 12,
        outputTokens: 4,
      },
      {
        integration: "dspy",
        generationCount: 1,
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        integration: "haystack",
        generationCount: 1,
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        integration: "instructor",
        generationCount: 1,
        totalTokens: 12,
        inputTokens: 8,
        outputTokens: 4,
      },
      {
        integration: "openai_agents",
        generationCount: 1,
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
      },
      {
        integration: "pydantic_ai",
        generationCount: 1,
        totalTokens: 18,
        inputTokens: 11,
        outputTokens: 7,
      },
    ],
  );
  const integrationCosts = Object.fromEntries(
    summary.integrations.map((entry) => [entry.integration, entry.totalCost]),
  );
  assert.ok(Math.abs((integrationCosts.crewai ?? 0) - 0.00008) < 1e-12);
  assert.ok(Math.abs((integrationCosts.dspy ?? 0) - 0.000075) < 1e-12);
  assert.ok(Math.abs((integrationCosts.haystack ?? 0) - 0.000075) < 1e-12);
  assert.ok(Math.abs((integrationCosts.instructor ?? 0) - 0.00006) < 1e-12);
  assert.ok(Math.abs((integrationCosts.openai_agents ?? 0) - 0.000075) < 1e-12);
  assert.ok(Math.abs((integrationCosts.pydantic_ai ?? 0) - 0.00009) < 1e-12);
});

test("totals a trace's generation tokens and cost", () => {
  const events = summarizableTrace({
    id: "trace-totals",
    generations: [
      generationEvent({
        id: "g1",
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        cost: { total_cost: 0.0006 },
        currency: "USD",
      }),
      generationEvent({
        id: "g2",
        usage: { input_tokens: 30, output_tokens: 10 },
        cost: { total_cost: 0.0004 },
        currency: "USD",
      }),
    ],
  }).events;

  const totals = getTraceTotals(events);

  assert.equal(totals.totalTokens, 160);
  assert.ok(Math.abs(totals.totalCost - 0.001) < 1e-9);
  assert.equal(totals.currency, "USD");
});

test("returns zero totals for a trace without generations", () => {
  const events = summarizableTrace({ id: "trace-empty" }).events;

  assert.deepEqual(getTraceTotals(events), { totalTokens: 0, totalCost: 0, currency: null });
});

test("omits currency when a trace mixes generation currencies", () => {
  const events = summarizableTrace({
    id: "trace-mixed",
    generations: [
      generationEvent({ id: "g1", cost: { total_cost: 0.001 }, currency: "USD" }),
      generationEvent({ id: "g2", cost: { total_cost: 0.002 }, currency: "EUR" }),
    ],
  }).events;

  const totals = getTraceTotals(events);

  assert.equal(totals.currency, null);
  assert.ok(Math.abs(totals.totalCost - 0.003) < 1e-9);
});

test("normalizes valid experiment summary responses newest first", () => {
  const summaries = normalizeExperimentSummaries([
    makeExperimentSummary({ experiment_id: "experiment-1", start_time: "2026-01-01T00:00:00+00:00" }),
    makeExperimentSummary({ experiment_id: "experiment-2", start_time: "2026-01-02T00:00:00+00:00" }),
  ]);

  assert.deepEqual(
    summaries.map((summary) => summary.experiment_id),
    ["experiment-2", "experiment-1"],
  );
  assert.deepEqual(summaries[0].aggregate_scores, { contains: 1 });
});

test("normalizes valid experiment detail responses", () => {
  const experiment = normalizeExperiment({
    ...makeExperimentSummary(),
    results: [makeExperimentResult({ trace_id: contractTrace.id })],
  });

  assert.ok(experiment);
  assert.equal(experiment.experiment_id, "experiment-1");
  assert.equal(experiment.results[0].example_id, "q1");
  assert.equal(experiment.results[0].trace_id, contractTrace.id);
  assert.deepEqual(experiment.results[0].scores, [{ name: "contains", value: 1, metadata: { expected: "observability" } }]);
});

test("matches linked experiment trace ids to loaded traces", () => {
  const experiment = normalizeExperiment({
    ...makeExperimentSummary(),
    results: [makeExperimentResult({ trace_id: contractTrace.id })],
  });
  assert.ok(experiment);

  const linkedTrace = findTraceById([contractTrace], experiment.results[0].trace_id ?? "");

  assert.equal(linkedTrace?.id, contractTrace.id);
  assert.equal(findTraceById([contractTrace], "missing-trace"), null);
});

test("rejects malformed experiment responses without throwing", () => {
  const malformedSummary = makeExperimentSummary({ aggregate_scores: { contains: true } });
  const malformedDetail = {
    ...makeExperimentSummary(),
    results: [{ ...makeExperimentResult(), scores: [{ name: "contains", value: true, metadata: {} }] }],
  };

  assert.deepEqual(normalizeExperimentSummaries([malformedSummary, makeExperimentSummary()]), [makeExperimentSummary()]);
  assert.equal(normalizeExperiment(malformedDetail), null);
  assert.equal(normalizeExperiment(null), null);
});

test("compares experiments by aggregate and directional per-example score deltas", () => {
  const baseline = makeLoadedExperiment({
    summary: makeExperimentSummary({
      experiment_id: "baseline",
      name: "prompt-v1",
      aggregate_scores: { contains: 0.5, exact_match: 1 },
    }),
    results: [
      makeExperimentResult({
        id: "baseline-q1",
        example_id: "q1",
        scores: [{ name: "contains", value: 0.5, metadata: {} }],
      }),
      makeExperimentResult({
        id: "baseline-q2",
        example_id: "q2",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
      makeExperimentResult({
        id: "baseline-q3",
        example_id: "q3",
        scores: [{ name: "contains", value: 0.5, metadata: {} }],
      }),
      makeExperimentResult({
        id: "baseline-q4",
        example_id: "q4",
        scores: [{ name: "contains", value: 0.75, metadata: {} }],
      }),
    ],
  });
  const candidate = makeLoadedExperiment({
    summary: makeExperimentSummary({
      experiment_id: "candidate",
      name: "prompt-v2",
      aggregate_scores: { contains: 0.75, latency_under: 1 },
    }),
    results: [
      makeExperimentResult({
        id: "candidate-q1",
        example_id: "q1",
        scores: [{ name: "contains", value: 0.25, metadata: {} }],
      }),
      makeExperimentResult({
        id: "candidate-q2",
        example_id: "q2",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
      makeExperimentResult({
        id: "candidate-q3",
        example_id: "q3",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
      makeExperimentResult({
        id: "candidate-q5",
        example_id: "q5",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
    ],
  });

  const comparison = compareExperiments(baseline, candidate);

  assert.deepEqual(comparison.aggregate_scores, [
    { name: "contains", baseline_value: 0.5, candidate_value: 0.75, delta: 0.25 },
    { name: "exact_match", baseline_value: 1, candidate_value: null, delta: null },
    { name: "latency_under", baseline_value: null, candidate_value: 1, delta: null },
  ]);
  assert.deepEqual(
    comparison.rows.map((row) => [row.example_id, row.status]),
    [
      ["q1", "regressed"],
      ["q4", "missing_candidate"],
      ["q5", "new_candidate"],
      ["q3", "improved"],
      ["q2", "unchanged"],
    ],
  );
  assert.deepEqual(comparison.counts, {
    regressed: 1,
    missing_candidate: 1,
    changed: 0,
    new_candidate: 1,
    improved: 1,
    unchanged: 1,
  });
});

test("classifies execution failures as regressions and recoveries as improvements before score changes", () => {
  const baseline = makeLoadedExperiment({
    results: [
      makeExperimentResult({ example_id: "fails", scores: [{ name: "score", value: 0, metadata: {} }] }),
      makeExperimentResult({
        id: "baseline-recovers",
        example_id: "recovers",
        status: "error",
        error: "provider unavailable",
        scores: [{ name: "score", value: 1, metadata: {} }],
      }),
    ],
  });
  const candidate = makeLoadedExperiment({
    summary: makeExperimentSummary({ experiment_id: "candidate" }),
    results: [
      makeExperimentResult({
        id: "candidate-fails",
        example_id: "fails",
        status: "error",
        error: "provider unavailable",
        scores: [{ name: "score", value: 1, metadata: {} }],
      }),
      makeExperimentResult({
        id: "candidate-recovers",
        example_id: "recovers",
        scores: [{ name: "score", value: 0, metadata: {} }],
      }),
    ],
  });

  const comparison = compareExperiments(baseline, candidate);

  assert.deepEqual(
    comparison.rows.map((row) => [row.example_id, row.status]),
    [
      ["fails", "regressed"],
      ["recovers", "improved"],
    ],
  );
});

test("classifies directional per-example score changes as improved or regressed", () => {
  const baseline = makeLoadedExperiment({
    results: [
      makeExperimentResult({ example_id: "negative", scores: [{ name: "score", value: 1, metadata: {} }] }),
      makeExperimentResult({ id: "baseline-positive", example_id: "positive", scores: [{ name: "score", value: 0, metadata: {} }] }),
    ],
  });
  const candidate = makeLoadedExperiment({
    summary: makeExperimentSummary({ experiment_id: "candidate" }),
    results: [
      makeExperimentResult({ id: "candidate-negative", example_id: "negative", scores: [{ name: "score", value: 0, metadata: {} }] }),
      makeExperimentResult({ id: "candidate-positive", example_id: "positive", scores: [{ name: "score", value: 1, metadata: {} }] }),
    ],
  });

  const comparison = compareExperiments(baseline, candidate);

  assert.deepEqual(comparison.rows.map((row) => [row.example_id, row.status]), [
    ["negative", "regressed"],
    ["positive", "improved"],
  ]);
  assert.deepEqual(comparison.rows.map((row) => row.scores[0].delta), [-1, 1]);
});

test("compares experiments with missing score values without throwing", () => {
  const baseline = makeLoadedExperiment({
    results: [
      makeExperimentResult({
        example_id: "q1",
        scores: [
          { name: "contains", value: 1, metadata: {} },
          { name: "exact_match", value: 1, metadata: {} },
        ],
      }),
    ],
  });
  const candidate = makeLoadedExperiment({
    summary: makeExperimentSummary({ experiment_id: "experiment-2", aggregate_scores: {} }),
    results: [
      makeExperimentResult({
        id: "candidate-q1",
        example_id: "q1",
        scores: [{ name: "contains", value: 1, metadata: {} }],
      }),
    ],
  });

  const comparison = compareExperiments(baseline, candidate);

  assert.equal(comparison.rows[0].status, "unchanged");
  assert.deepEqual(comparison.rows[0].scores, [
    { name: "contains", baseline_value: 1, candidate_value: 1, delta: 0 },
    { name: "exact_match", baseline_value: 1, candidate_value: null, delta: null },
  ]);
});

function loadSharedContractTraceResponse(): unknown[] {
  const fixturePath = path.resolve(process.cwd(), "../../tests/fixtures/valid-events.jsonl");
  const events = readFileSync(fixturePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

  const rootEvent = events.find(
    (event): event is Record<string, unknown> =>
      isRecord(event) && event.type === "trace" && event.id === event.trace_id,
  );
  assert.ok(rootEvent);

  return [
    {
      id: rootEvent.id,
      name: rootEvent.name,
      start_time: rootEvent.start_time,
      end_time: rootEvent.end_time,
      status: rootEvent.status,
      events,
    },
  ];
}

function loadProductIntegrationTraceResponse(): unknown[] {
  const fixturePath = path.resolve(process.cwd(), "../../tests/product-fixtures/integration-events.jsonl");
  const events = readFileSync(fixturePath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

  const eventsByTraceId = new Map<string, Record<string, unknown>[]>();
  for (const event of events) {
    assert.ok(isRecord(event));
    const traceId = event.trace_id;
    if (typeof traceId !== "string") {
      assert.fail("integration fixture event is missing trace_id");
    }
    const traceEvents = eventsByTraceId.get(traceId) ?? [];
    traceEvents.push(event);
    eventsByTraceId.set(traceId, traceEvents);
  }

  return [...eventsByTraceId.entries()].map(([traceId, traceEvents]) => {
    const rootEvent = traceEvents.find(
      (event) => event.type === "trace" && event.id === traceId,
    );
    assert.ok(rootEvent);
    return {
      id: rootEvent.id,
      name: rootEvent.name,
      start_time: rootEvent.start_time,
      end_time: rootEvent.end_time,
      status: rootEvent.status,
      events: traceEvents,
    };
  });
}

function integrationTrace(traceId: string): Trace {
  const trace = findTraceById(integrationTraces, traceId);
  assert.ok(trace);
  return trace;
}

function makeExperimentSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0",
    experiment_id: "experiment-1",
    name: "prompt-v1",
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:01+00:00",
    status: "success",
    example_count: 1,
    error_count: 0,
    aggregate_scores: { contains: 1 },
    result_path: "prompt-v1-experiment-1.jsonl",
    ...overrides,
  };
}

function makeExperimentResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "result-1",
    example_id: "q1",
    input: { question: "What is Bir?" },
    expected: "An observability SDK",
    output: "Bir is an observability SDK.",
    scores: [{ name: "contains", value: 1, metadata: { expected: "observability" } }],
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:01+00:00",
    duration_ms: 1000,
    status: "success",
    error: null,
    ...overrides,
  };
}

function makeLoadedExperiment({
  summary = makeExperimentSummary(),
  results = [makeExperimentResult()],
}: {
  summary?: Record<string, unknown>;
  results?: Record<string, unknown>[];
} = {}) {
  const experiment = normalizeExperiment({
    ...summary,
    example_count: results.length,
    error_count: results.filter((result) => result.status === "error").length,
    results,
  });
  assert.ok(experiment);
  return experiment;
}

function generationEvent(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    schema_version: "1.0",
    id: "generation",
    trace_id: "trace",
    parent_id: "trace",
    name: "playground.llm",
    type: "generation",
    start_time: "2026-01-01T00:00:00+00:00",
    end_time: "2026-01-01T00:00:00+00:00",
    status: "success",
    metadata: {},
    input: null,
    output: null,
    error: null,
    ...overrides,
  };
}

function summarizableTrace(options: {
  id: string;
  status?: EventStatus;
  start?: string;
  end?: string;
  generations?: TraceEvent[];
  rootMetadata?: Record<string, unknown>;
}): Trace {
  const start = options.start ?? "2026-01-01T00:00:00+00:00";
  const end = options.end ?? start;
  const status = options.status ?? "success";
  const root: TraceEvent = {
    schema_version: "1.0",
    id: options.id,
    trace_id: options.id,
    parent_id: null,
    name: "workflow",
    type: "trace",
    start_time: start,
    end_time: end,
    status,
    metadata: options.rootMetadata ?? {},
    input: null,
    output: null,
    error: null,
  };
  return {
    id: options.id,
    name: "workflow",
    start_time: start,
    end_time: end,
    status,
    events: [root, ...(options.generations ?? [])],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
