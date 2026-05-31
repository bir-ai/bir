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
- Keep document text/snippets opt-in because retrieved context can contain
  sensitive user or business data.
- Do not add vector database integrations or provider-specific dependencies in
  this slice.

The underlying event type remains `tool_call`, so the server and dashboard can
continue using the same schema.

## Local Evaluation Experiments

Use `bir.evals` for small deterministic checks before adding LLM-as-judge or
external evaluation services.

```python
from bir.evals import Dataset, DatasetExample, contains, exact_match, run_experiment


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
    return "Bir adds local observability to LLM apps."


result = run_experiment(
    "prompt-v1",
    dataset=dataset,
    task=answer_question,
    evaluators=[contains(), exact_match("Bir adds local observability to LLM apps.")],
)

print(result.aggregate_scores)
```

Dataset JSONL rows use this shape:

```json
{"id":"q1","input":{"question":"What is Bir?"},"expected":"observability"}
```

`run_experiment()` writes one JSONL result per dataset example to
`.bir/experiments/` unless a custom path is provided. Keep this layer
deterministic for now; provider-backed LLM judges can come later after local
evaluators are stable.
