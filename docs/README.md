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
from bir import generation, observe, score, span, tool_call


@observe(capture_inputs=True, capture_outputs=True)
def answer_question(question: str) -> str:
    with span("retrieve_context"):
        with tool_call("search_docs", input={"query": question}) as tool:
            documents = ["local context"]
            tool.set_output(documents)

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

## Event Contract

Trace events use schema version `1.0`. The shared contract artifact lives at
`tests/fixtures/event-schema-v1.json`, and `tests/fixtures/valid-events.jsonl`
contains a representative trace with trace, span, tool call, generation, and
score events. Keep the SDK, server, and dashboard aligned with those fixtures
when changing event fields.
