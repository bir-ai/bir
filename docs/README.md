# Bir Docs

Bir is currently focused on the local MVP path: record traces with the Python
SDK, persist them as JSONL, send them to the FastAPI server, and inspect them in
the dashboard.

## Local Quickstart

Install server and web dependencies once if they are not already available:

```bash
cd apps/server
python3 -m pip install -e ".[dev]"

cd ../web
npm install
```

From the repository root, run the OpenAI-style local demo:

```bash
cd examples/openai-demo
PYTHONPATH=../../packages/python-sdk/src python3 demo.py
```

Start the ingestion server in another terminal from the repository root:

```bash
cd apps/server
uvicorn app.main:app --reload
```

Send demo events to the server from the repository root:

```bash
cd examples/openai-demo
PYTHONPATH=../../packages/python-sdk/src python3 demo.py --send
```

Start the dashboard in another terminal from the repository root:

```bash
cd apps/web
npm run dev
```

Open `http://localhost:3000`.

## Core SDK Pattern

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

Input and output capture is disabled by default. Enable it only when you want to
store request and response payloads locally.
Generation token usage and cost are optional user-provided values. Bir records
the values you pass and does not calculate provider pricing automatically.
The SDK and server both apply best-effort redaction for common secret-like keys
and text patterns before events are written, but capture should still stay
opt-in for sensitive payloads.

## Event Contract

Trace events use schema version `1.0`. The shared contract artifact lives at
`tests/fixtures/event-schema-v1.json`, and `tests/fixtures/valid-events.jsonl`
contains a representative trace with trace, span, tool call, generation, and
score events. Keep the SDK, server, and dashboard aligned with those fixtures
when changing event fields.

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

## Local Evaluation Experiments

Use `bir.evals` for small deterministic checks before adding LLM-as-judge or
external evaluation services.

For the detailed evaluator implementation plan, see
`docs/EVALUATOR_IMPLEMENTATION_GUIDE.md`.

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
