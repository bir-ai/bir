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
from bir import generation, observe, retrieval, score, span


@observe(capture_inputs=True, capture_outputs=True)
def answer_question(question: str) -> str:
    with span("retrieve_context"):
        with retrieval("search_docs", query=question) as result:
            documents = ["local context"]
            result.add_document(id="doc-1", text=documents[0])

    with generation("openai.chat.completions", model="demo-gpt-4o-mini") as gen:
        answer = f"{documents[0]}: {question}"
        gen.set_output(answer)
        gen.set_usage(input_tokens=12, output_tokens=24)
        gen.set_cost(input_cost=0.000012, output_cost=0.000048)

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
Generation token usage and cost are optional user-provided values. When provided,
usage and cost calls require at least one field. Bir records the values you pass
and does not calculate provider pricing automatically.
The server applies best-effort redaction for common secret-like keys and text
patterns before events are written. Contract tests exercise the installed
`bir-sdk` against the shared redaction cases, but capture should still stay
opt-in for sensitive payloads.

## Event Contract

Trace events use schema version `1.0`. The shared contract artifact lives at
`tests/fixtures/event-schema-v1.json`, and `tests/fixtures/valid-events.jsonl`
contains a representative trace with trace, span, tool call, generation, and
score events. Keep the server and dashboard aligned with those fixtures when
changing event fields, and coordinate corresponding SDK contract changes in the
external SDK repository.

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
`sort=slowest`; the default `sort=recent` preserves the most-recent-first order.
The dashboard exposes the same choice as a Recent/Slowest toggle. To isolate slow
traces, drop everything under a threshold with `min_duration_ms`, a positive
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

## LangChain Callback Integration

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
from bir.evals import Dataset, DatasetExample, contains, exact_match, latency_under, list_experiments, load_experiment, run_experiment, send_experiment


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
)

print(result.aggregate_scores)
print(load_experiment(result.path).status)
print([summary.name for summary in list_experiments()])

send_experiment(result.path, "http://127.0.0.1:8000")
```

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

`latency_under()` uses the measured task duration in `run_experiment()`.
`cost_under()` reads explicit user-provided cost fields from task output, either
as `{"total_cost": 0.01}` or `{"cost": {"total_cost": 0.01}}`; Bir does not
calculate provider pricing. `numeric_between()` evaluates numeric task outputs,
or a numeric field when `field=` is provided.

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
