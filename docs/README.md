# Bir Docs

This repository contains the standalone Bir product: the FastAPI server, Next.js
dashboard, shared contract fixtures, and product documentation. The Python SDK
is developed and published from a separate repository and is installed as
`bir-sdk` (its import name is `bir`). SDK implementation and publishing changes
must be made in that external repository, not here.

## Local Quickstart

Install server and web dependencies once if they are not already available:

```bash
python3 -m venv .venv

cd apps/server
../../.venv/bin/python -m pip install -e ".[dev]"

cd ../web
npm install
```

Node.js 22 is the supported dashboard development version and is also used by
CI.

From the repository root, run the local dev loop:

```bash
./scripts/dev.sh
```

The runner starts the API at `http://127.0.0.1:8000` and dashboard at
`http://localhost:3000`. Open the dashboard after both processes are ready.
Use `./scripts/server.sh` when only the API is needed. These scripts do not
develop or publish the external SDK.

To run the server tests against unreleased SDK changes from a sibling checkout,
use the local-only wrapper:

```bash
./scripts/test-server-local-sdk.sh
```

It uses `BIR_SDK_PATH` when set and otherwise defaults to `../bir-python` if
that sibling directory exists. The wrapper does not install the SDK or change
`apps/server[dev]`; it prepends the sibling SDK's `src/` directory to
`PYTHONPATH` for one pytest invocation. If the sibling checkout is absent, run
the normal PyPI-backed server tests instead.

The manual fallback is to run the server and dashboard separately:

```bash
cd apps/server
../../.venv/bin/python -m uvicorn app.main:app --reload

cd apps/web
npm run dev
```

### Serve the dashboard from the server

For a single process that serves both the API and the UI, build the dashboard's
static export once and point the server at it with `BIR_DASHBOARD_DIR`:

```bash
cd apps/web
npm run build  # emits the static site to apps/web/out

cd ../server
BIR_DASHBOARD_DIR=../web/out ../../.venv/bin/python -m uvicorn app.main:app --reload
```

Open `http://127.0.0.1:8000`. The dashboard is served at `/`, the API stays at
`/health` and `/v1/*`, and the UI calls the API on the same origin (no CORS
setup). This also works in read-only local data mode (`BIR_DATA_DIR`). When
`BIR_DASHBOARD_DIR` is unset or the export is not built yet, the server serves
only the API, unchanged.

## External SDK Pattern

Install the published SDK in the application being instrumented:

```bash
pip install bir-sdk
```

The following is a consumer example. It describes the published package API;
the implementation is not part of this repository.

```python
from bir import configure, generation, observe, retrieval, score, span


configure(
    sample_rate=0.25,
    sample_rules={"answer_question": 1.0, "chatty": 0.0},
    model_prices={"demo-gpt-4o-mini": {"input": 0.00000015, "output": 0.0000006}},
)


@observe(
    capture_inputs=True,
    capture_outputs=True,
    metadata={"route": "/answer"},
)
def answer_question(question: str) -> str:
    with span("retrieve_context") as current_span:
        with retrieval("search_docs", query=question) as result:
            documents = ["local context"]
            result.add_document(id="doc-1", text=documents[0])
        current_span.set_metadata({"documents": len(documents)})

    with generation("openai.chat.completions") as gen:
        answer = f"{documents[0]}: {question}"
        gen.set_model("demo-gpt-4o-mini")
        gen.set_output(answer)
        gen.set_usage(input_tokens=12, output_tokens=24)

    score("helpfulness", 0.82)
    return answer
```

Use `trace()` for workflows that are easier to wrap manually than decorate:

```python
from bir import generation, score, span, trace

with trace("answer_question"):
    with span("draft_answer"):
        with generation("local.llm") as gen:
            gen.set_output("ok")
    score("helpfulness", 0.82)
```

Input and output capture is disabled by default. Enable it only when you want to
store request and response payloads locally.
Generation token usage and cost are optional. Bir records the values the SDK
emits: an application can call `set_cost()` explicitly, or it can opt into a
local SDK price table with `configure(model_prices=...)` so cost is derived from
token usage before events reach this product. The SDK ships no bundled provider
prices, and this server does not infer costs from model names.
The server applies best-effort redaction for common secret-like keys and text
patterns before events are written. Contract tests exercise the installed
`bir-sdk` against the shared redaction cases, but capture should still stay
opt-in for sensitive payloads.

## Current SDK Surface Snapshot

This product consumes SDK output; it does not implement the SDK APIs below.
Implementation and release work for these surfaces belongs in the external
`bir-python` repository.

- `configure(sample_rules=...)` sets exact trace-root sampling overrides on top
  of `sample_rate`. Passing `{}` clears the table; omitting the argument leaves
  existing rules unchanged.
- `configure(model_prices=...)` installs a local per-token price table. The SDK
  validates the table, derives generation cost only when token usage and model
  match, and preserves explicit `set_cost()` values.
- `@observe(metadata=...)` attaches static metadata to the trace root opened by
  the decorated call. Nested observed calls become spans and do not carry that
  root metadata.
- `set_metadata(...)` is available on `trace()`, `span()`, `generation()`,
  `tool_call()`, and `retrieval()` context managers for metadata learned while a
  block runs. It merges with constructor metadata and is redacted before write.
- `generation.set_model(...)` records or refines the model at generation exit,
  useful when a router or stream only reveals the concrete model after the call.
- `bir.logging.install_trace_id_filter()` stamps Python log records with
  `bir_trace_id` and `bir_span_id`; direct accessors are also available as
  `get_current_trace_id()` and `get_current_span_id()`.
- `bir.testing.capture_traces()` redirects writes to a temporary trace file for
  instrumentation tests and reads captured events/traces through the public
  loaders.
- The SDK CLI entry point is `bir`, or `python -m bir <command>` when the
  console script is not on `PATH`. Commands include `bir show`, `bir stats`,
  `bir experiment-show`, and `bir export-otel`.
- Optional integrations include dependency-free provider wrappers, async and
  streaming wrappers, Instructor, DSPy, LangChain, LlamaIndex, OpenAI Agents,
  Pydantic AI, CrewAI, Haystack, and OpenTelemetry/OTLP export.

## Event Contract

Trace events use schema version `1.0`. The shared contract artifact lives at
`tests/fixtures/event-schema-v1.json`, and `tests/fixtures/valid-events.jsonl`
contains a representative trace with trace, span, tool call, generation, and
score events. Keep the server and dashboard aligned with those fixtures when
changing event fields, and coordinate corresponding SDK contract changes in the
external SDK repository.

For product-side SDK parity audits, use [`PARITY_AUDIT.md`](PARITY_AUDIT.md) as
the checklist for mapping recent SDK capability areas to server handling,
dashboard display, shared fixtures, docs, and intentional no-op product areas.

## Trace Filtering

Use the dashboard's trace filters, or query the ingestion server directly, to
triage local traces by root status, root trace name, contained event type, or
the service and environment recorded by `configure()`:

```bash
curl "http://127.0.0.1:8000/v1/traces?status=error"
curl "http://127.0.0.1:8000/v1/traces?name=answer"
curl "http://127.0.0.1:8000/v1/traces?event_type=generation"
curl "http://127.0.0.1:8000/v1/traces?service=rag-api"
curl "http://127.0.0.1:8000/v1/traces?environment=production"
```

Filters match root trace status, root trace name, contained event type, the
service and environment from `metadata.service`, and a minimum root-trace
duration. They do not search arbitrary captured input, output, other metadata,
or error payloads.

To triage slow traces, order results by root-trace duration (longest first) with
`sort=slowest`; the default `sort=recent` returns the most recent page, ordered
oldest-first within that page. The dashboard displays recent traces newest-first.
The dashboard exposes the same choice as a Recent/Slowest toggle. To isolate
slow traces, drop everything under a threshold with `min_duration_ms`, a positive
number that keeps only traces whose root duration (`end_time - start_time`) is at
least that many milliseconds. The dashboard exposes it as a "Min Duration (ms)"
input, and it combines with the other filters and the sort.

```bash
curl "http://127.0.0.1:8000/v1/traces?sort=slowest"
curl "http://127.0.0.1:8000/v1/traces?sort=slowest&status=error&limit=20"
curl "http://127.0.0.1:8000/v1/traces?min_duration_ms=250"
curl "http://127.0.0.1:8000/v1/traces?min_duration_ms=250&sort=slowest"
```

## Trace Sampling

For high-volume local runs, set a sample rate so the JSONL store stays bounded.
`sample_rate` is the probability (`0.0` to `1.0`) that a trace is recorded and
defaults to `1.0`. The decision is made once per trace root and inherited by
every nested span, generation, tool call, retrieval, and score, so a sampled-out
trace writes nothing. The observed function still runs and still raises its own
exceptions; only the writes are skipped.

```python
from bir import configure

configure(sample_rate=0.25)  # keep about a quarter of traces
```

Use `sample_rules` when specific trace roots need a different rate. Rule names
match `@observe(name=...)`, the decorated function name for plain `@observe()`,
or the name passed to `trace("...")`:

```python
configure(
    sample_rate=0.01,
    sample_rules={
        "checkout": 1.0,
        "chatty": 0.0,
    },
)
```

Passing `sample_rules={}` clears the overrides; leaving `sample_rules` out of a
later `configure()` call keeps the current table.

## Retrieval Events

RAG retrieval inspection builds on the current event contract instead of adding
a new event type. Use `retrieval()` to emit a `tool_call` inside a retrieval
span:

```python
with span("retrieve_context"):
    with retrieval(
        "vector_search",
        query=question,
        metadata={"provider": "local"},
        capture_input=True,
        capture_output=True,
    ) as result:
        result.add_document(
            id="doc-1",
            rank=1,
            score=0.82,
            source="docs",
            text="Bir records local traces with JSONL.",
            metadata={"section": "quickstart"},
        )
```

Recommended retrieval payload rules:

- `retrieval()` sets `metadata.kind = "retrieval"` so the dashboard can
  distinguish retrieval tool calls from other tools.
- Put the retrieval query in `input.query` only when input capture is enabled.
- Put retrieved records in `output.documents` only when output capture is
  enabled.
- Each document should include `id` when available, plus optional `rank`,
  `score`, `source`, `text`, and `metadata`.
- `rank` must be a non-negative integer, and `score` must be a non-negative
  finite number.
- Keep document text/snippets opt-in because retrieved context can contain
  sensitive user or business data.
- Do not add vector database integrations or provider-specific dependencies in
  this slice.

The underlying event type remains `tool_call`, so the server and dashboard can
continue using the same schema.

## Prompt Version Metadata

Attach prompt identity to generation events with `prompt()`:

```python
from bir import generation, prompt

answer_prompt = prompt(
    "answer_question",
    version="v1",
    template="Answer using this context: {context}",
    variables={"context": "local context"},
)

with generation("local.llm", prompt=answer_prompt) as gen:
    gen.set_output("ok")
```

By default, Bir stores the prompt name, version, and template hash in
`metadata.prompt`. Template text, variables, and rendered prompt text remain
opt-in through `capture_template=True`, `capture_variables=True`, and
`capture_rendered=True`. Sent generation traces show this prompt metadata in
the dashboard trace detail view.

## Trace Metadata and Log Correlation

The SDK supports metadata at creation time and during a trace-work block. The
dashboard renders event metadata exactly as it appears in the ingested event
after redaction:

```python
from bir import generation, observe, span, trace


@observe(metadata={"route": "/checkout"})
def checkout() -> str:
    with span("load_cart") as current_span:
        items = ["sku-1"]
        current_span.set_metadata({"items": len(items)})

    with generation("router.chat") as gen:
        response = call_router()
        gen.set_model(response.model)
        gen.set_metadata({"cache_hit": response.cache_hit})
        gen.set_output(response.text)

    return "ok"


with trace("background_job", metadata={"kind": "maintenance"}) as current_trace:
    current_trace.set_metadata({"shard": "a"})
```

`set_metadata(...)` is available on `trace()`, `span()`, `generation()`,
`tool_call()`, and `retrieval()` context managers. Later keys win when metadata
is set more than once.

For logs, the SDK-owned `bir.logging` helper can stamp Python log records with
the current trace and span ids:

```python
import logging

from bir import observe
from bir.logging import install_trace_id_filter

install_trace_id_filter()
logging.basicConfig(
    format="%(asctime)s %(levelname)s [trace=%(bir_trace_id)s span=%(bir_span_id)s] %(message)s"
)


@observe()
def answer() -> str:
    logging.info("handling request")
    return "ok"
```

The filter adds `bir_trace_id` and `bir_span_id` attributes to records; outside a
trace they are `None`.

## Testing Instrumentation

Use the SDK's `bir.testing.capture_traces()` in application tests when you need
to assert on generated trace events without writing to the real `.bir/`
directory:

```python
from bir.testing import capture_traces

with capture_traces() as captured:
    answer_question("hello")

trace_record = captured.traces()[0]
assert trace_record.name == "answer_question"
```

The helper is part of the SDK, not this product. The product repo only uses the
published SDK in contract tests and can read the resulting JSONL through the
server/dashboard.

## SDK CLI for Local Data

The product repo has no `bir` command. Installing `bir-sdk` in an instrumented
application provides the SDK CLI, which inspects local `.bir/` output before
anything is sent to this server:

```bash
python -m bir show <trace-id>
bir show <trace-id>
bir stats
bir experiment-show <experiment-id>
bir export-otel --endpoint http://localhost:4318/v1/traces
python -m bir stats
```

`bir show` and `bir stats` read SDK-written `.bir/traces.jsonl`.
`bir experiment-show` reads SDK-written summaries and result rows under
`.bir/experiments/`. `bir export-otel` reads local traces and forwards them to
an OTLP endpoint when the SDK's `otel` extra is installed. `python -m bir ...`
exposes the same command surface when the console script is not on `PATH`.

The product server/dashboard consume those artifact shapes; they do not call the
SDK CLI. For local visual inspection, start the FastAPI server with
`BIR_DATA_DIR=/path/to/project/.bir`. The server then serves
`$BIR_DATA_DIR/traces.jsonl` and `$BIR_DATA_DIR/experiments/` through the normal
`/v1/traces` and `/v1/experiments` APIs, and the dashboard renders those local
records in read-only mode. Ingestion and Playground writes are disabled because
the SDK owns those files.

OpenTelemetry/OTLP export stays SDK-owned. Use `bir export-otel` or
`bir.integrations.otel.export_traces_to_otlp(...)` for forwarding traces to a
collector; the product dashboard remains a local trace and experiment
inspection surface.

## SDK Integrations

Integrations live in the SDK. This product stores and displays the emitted Bir
events, but it does not import provider SDKs or frameworks.

Provider wrappers cover OpenAI Chat Completions and Responses, Anthropic, Google
Gemini, Google Vertex AI, AWS Bedrock, Mistral, Cohere, and LiteLLM. Structured
and programmatic LLM wrappers include Instructor and DSPy. The SDK includes
async counterparts such as
`trace_chat_completion_async`, `trace_messages_async`, `trace_completion_async`,
and provider-specific async wrappers; streaming wrappers pass provider chunks
through unchanged and record output, model, and usage after the stream is
consumed.

Framework handlers include LangChain, LlamaIndex, OpenAI Agents, Pydantic AI,
CrewAI, and Haystack. OpenAI Agents runs are mapped through
`BirAgentsTracingProcessor`; Pydantic AI uses its OpenTelemetry instrumentation;
CrewAI events are forwarded through `BirCrewAIHandler.on_event`; Haystack 2.x
uses `BirHaystackTracer` via `haystack.tracing.enable_tracing(...)`.

OpenTelemetry/OTLP export is SDK-owned too. Install the SDK's `otel` extra and
use `bir.integrations.otel.export_traces_to_otlp(...)` or `bir export-otel` to
replay local Bir traces to an existing observability backend; the product
dashboard does not export OTLP.

### LangChain Callback Integration

LangChain apps can pass Bir's dependency-free callback handler through runnable
config:

```python
from bir import configure
from bir.integrations.langchain import BirCallbackHandler

configure(capture_inputs=True, capture_outputs=True)

result = chain.invoke(
    {"question": "What is Bir?"},
    config={"callbacks": [BirCallbackHandler()]},
)
```

The handler records root chains as traces, nested chains as spans, LLM/chat model
callbacks as generation events, retrievers as retrieval tool calls, and tools as
tool call events. Bir does not install LangChain; use this in applications that
already depend on LangChain.

## Local Evaluation Experiments

Use `bir.evals` for small deterministic checks before adding LLM-as-judge or
external evaluation services.

Evaluator implementation and publishing belong to the external SDK repository;
the examples below show how this product consumes the published API.

```python
from bir import generation, span
from bir.evals import (
    Dataset,
    DatasetExample,
    contains,
    exact_match,
    latency_under,
    list_experiments,
    load_experiment,
    run_experiment,
    send_experiment,
)


dataset = Dataset(
    [
        DatasetExample(
            id="q1",
            input={"question": "What is Bir?"},
            expected="observability",
        )
    ]
)


def answer_question(question: str) -> str:
    with span("draft_answer"):
        with generation("local.llm", model="demo") as gen:
            answer = "Bir adds local observability to LLM apps."
            gen.set_output(answer)
            return answer


result = run_experiment(
    "prompt-v1",
    dataset=dataset,
    task=answer_question,
    evaluators=[
        contains(),
        exact_match("Bir adds local observability to LLM apps."),
        latency_under(1000),
    ],
    max_workers=4,
)

print(result.aggregate_scores)
print(load_experiment(result.path).status)
print([summary.name for summary in list_experiments()])

send_experiment(result.path, "http://127.0.0.1:8000")
```

`run_experiment(max_workers=N)` runs synchronous tasks in a thread pool while
preserving dataset order in results, JSONL rows, and aggregate summaries. Leave
`max_workers` at `1` for sequential execution.

Use `run_experiment_async()` for coroutine tasks or async provider clients:

```python
import asyncio

from bir.evals import Dataset, DatasetExample, contains, run_experiment_async


async def answer_question_async(question: str) -> str:
    response = await async_model_client(question)
    return response.text


async_result = asyncio.run(
    run_experiment_async(
        "prompt-v1-async",
        dataset=Dataset([DatasetExample(id="q1", input={"question": "What is Bir?"})]),
        task=answer_question_async,
        evaluators=[contains("observability")],
        max_concurrency=8,
    )
)
```

The async runner accepts async tasks, sync callables, and sync callables that
return awaitables. It keeps persisted rows and returned results in dataset order.

To link experiment examples to local Bir traces, opt in with
`record_traces=True`:

```python
result = run_experiment(
    "prompt-v1",
    dataset=dataset,
    task=answer_question,
    evaluators=[contains(), latency_under(1000)],
    record_traces=True,
)

print(result.results[0].trace_id)
```

Bir writes one trace per dataset example, runs the task inside that trace, and
records evaluator results as score events on the same trace. Task-level spans,
generations, retrievals, and tool calls are visible under the linked
`experiment.<experiment_name>.<example_id>` trace. The trace metadata includes
`kind="experiment"`, `experiment_id`, `experiment_name`, and `example_id`. Start
the FastAPI server and dashboard, send trace events with `send_events()`, then
upload the experiment with `send_experiment()`. Experiment rows with uploaded
trace events include an Open trace action that selects the linked trace in the
dashboard.

Dataset JSONL rows use this shape:

```json
{"id":"q1","input":{"question":"What is Bir?"},"expected":"observability"}
```

`run_experiment()` writes one JSONL result per dataset example to
`.bir/experiments/` unless a custom path is provided. It also writes a sibling
`.summary.json` file containing the experiment id, status, example count, error
count, aggregate scores, and result path. Use `load_experiment()` for result
rows and `list_experiments()` for local summaries. Use `send_experiment()` to
upload one completed local experiment to the FastAPI server so the dashboard's
Experiments view can read it through `/v1/experiments`. Duplicate uploads are
idempotent and do not overwrite the server's existing experiment artifact. Keep
this layer deterministic for now; provider-backed LLM judges can come later
after local evaluators are stable.

After uploading at least two experiments, use the dashboard's Experiments view
to compare a baseline run against a candidate run. The comparison aligns result
rows by `example_id`, shows aggregate score deltas, and lists regressed, missing,
new, improved, and unchanged examples.

Use threshold evaluators for local operational gates:

```python
from bir.evals import cost_under, latency_under, numeric_between

evaluators = [
    latency_under(1000),
    cost_under(0.05),
    numeric_between(min_value=0.0, max_value=1.0),
]
```

`latency_under()` uses the measured task duration in `run_experiment()` or
`run_experiment_async()`. `cost_under()` reads cost fields from task output,
either as `{"total_cost": 0.01}` or `{"cost": {"total_cost": 0.01}}`; return an
explicit task cost, or return a cost your instrumented code already derived from
the SDK's `configure(model_prices=...)`. The evaluator itself does not fetch
provider prices or inspect trace events. `numeric_between()` evaluates numeric
task outputs, or a numeric field when `field=` is provided.

Use structured output evaluators for JSON-like task results:

```python
from bir.evals import field_contains, field_equals, numeric_between

evaluators = [
    field_contains("answer", "observability"),
    field_equals("citations[0].id", "doc-1"),
    numeric_between(min_value=0.7, max_value=1.0, field="confidence"),
]
```

Field paths support dot paths and list indexes, such as `answer`,
`usage.total_tokens`, and `items[0].name`. Missing paths produce a `0.0` score
with failure metadata instead of failing the experiment.

Use `custom_evaluator()` for local checks that are specific to your task:

```python
from bir.evals import EvalResult, custom_evaluator

has_citation = custom_evaluator(
    "has_citation",
    lambda output, expected: "[1]" in str(output),
)

debuggable = custom_evaluator(
    "debuggable",
    lambda output, expected: EvalResult(
        name="debuggable",
        value=1.0,
        metadata={"expected": expected},
    ),
)
```

Custom evaluators may return `bool`, `int`, `float`, or `EvalResult`. Exceptions
from custom evaluator functions surface normally during development.

Use `retrieved_context_contains()` to check retrieval quality without an LLM
judge:

```python
from bir.evals import retrieved_context_contains

evaluators = [
    retrieved_context_contains("observability"),
]
```

`retrieved_context_contains()` reads the `contexts` list from a structured RAG
output such as `{"answer": "...", "contexts": ["doc text", ...]}` and scores
`1.0` when `expected` appears in one of the retrieved strings. Missing or empty
`contexts` produce a `0.0` score with failure metadata instead of failing the
experiment. Pass `case_sensitive=False` for case-insensitive matching. This is a
deterministic retrieval check, not proof that the answer used the context.

Use `answer_context_overlap()` to flag answers that may not be grounded in the
retrieved context, also without an LLM judge:

```python
from bir.evals import answer_context_overlap

evaluators = [
    answer_context_overlap(0.5),
]
```

`answer_context_overlap()` reads the same structured RAG output
(`{"answer": "...", "contexts": ["doc text", ...]}`) and scores `1.0` when at
least `min_ratio` of the answer's word tokens also appear in the retrieved
contexts. It is a deterministic faithfulness heuristic, not proof of
faithfulness: paraphrased but faithful answers can score low, and unfaithful
answers that reuse context words can score high. Missing answers or contexts
produce a `0.0` score with failure metadata instead of failing the experiment.

Use `answer_contains_citation()` to check that an answer cites a source, also
without an LLM judge:

```python
from bir.evals import answer_contains_citation

evaluators = [
    answer_contains_citation(),
]
```

`answer_contains_citation()` reads a plain answer string or the `answer` field
of a structured RAG output (`{"answer": "...", "contexts": [...]}`) and scores
`1.0` when the answer contains a citation marker. By default any bracketed
marker such as `[1]` or `[doc-1]` counts; pass `pattern` to require a custom
citation format such as `pattern=r"\(\d+\)"` for markers like `(1)`. This is a
deterministic format check, not proof that the citation is correct or that the
cited source supports the answer. Non-text output or a missing `answer` produces
a `0.0` score with failure metadata instead of failing the experiment.
