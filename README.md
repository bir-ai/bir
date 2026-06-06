<p align="center">
  <img src="bir_logo.png" alt="bir logo" width="160">
</p>

# bir

**/biɾ/** · Turkish for "one"

LLM Evaluation, Tracing & Observability Platform

Bir is an early-stage toolkit for tracing and evaluating LLM applications.

Current focus:

- Python SDK
- Local trace storage
- Trace, span, generation, retrieval, tool call, and score recording
- Safe opt-in input/output capture
- Local datasets and deterministic experiment runs
- FastAPI ingestion and a minimal local dashboard for traces and experiments

## Python SDK

```python
from bir import observe, retrieval, score, span

@observe()
def answer_question(question: str) -> str:
    with span("retrieve_context"):
        with retrieval("search_docs", query=question) as result:
            result.add_document(id="doc-1", text="local context")
            context = "local context"

    score("helpfulness", 0.82)
    return f"{context}: {question}"
```

Traces are written locally to `.bir/traces.jsonl`. Run the FastAPI server and
send local events when you want to inspect them through the ingestion API:

```python
from bir import send_events

send_events("http://127.0.0.1:8000")
```

## Local MVP Loop

Install server and web dependencies once if they are not already available:

```bash
cd apps/server
python3 -m pip install -e ".[dev]"

cd ../web
npm install
```

From the repository root, run the dependency-free OpenAI-style demo:

```bash
cd examples/openai-demo
PYTHONPATH=../../packages/python-sdk/src python3 demo.py
```

Start the ingestion server in another terminal from the repository root:

```bash
cd apps/server
uvicorn app.main:app --reload
```

Send the demo trace to the server from the repository root:

```bash
cd examples/openai-demo
PYTHONPATH=../../packages/python-sdk/src python3 demo.py --send
```

Start the dashboard in another terminal from the repository root:

```bash
cd apps/web
npm run dev
```

Open `http://localhost:3000` to inspect traces.
Use the dashboard filters to narrow traces by status, trace name, or event type.

For local evaluation runs, `bir.evals.run_experiment()` writes JSONL results and
a sibling summary under `.bir/experiments/`. Send one completed experiment to the
server so it appears in the dashboard's Experiments view:

```python
from bir.evals import send_experiment

send_experiment(".bir/experiments/prompt-v1-<experiment-id>.jsonl")
```

When you want each dataset example to produce an inspectable trace, run the
experiment with `record_traces=True`. Bir runs each example inside its linked
trace, so task-level spans, generations, retrievals, tool calls, and evaluator
scores appear together in the dashboard:

```python
from bir import generation, span
from bir.evals import contains, run_experiment


def answer_question(question: str) -> str:
    with span("draft_answer"):
        with generation("local.llm", model="demo") as gen:
            answer = f"Bir helps inspect: {question}"
            gen.set_output(answer)
            return answer


result = run_experiment(
    "prompt-v1",
    dataset=dataset,
    task=answer_question,
    evaluators=[contains()],
    record_traces=True,
)
```

Send the local trace events with `send_events()`, and upload the experiment
result with `send_experiment()`. Experiment rows with uploaded trace events
include an Open trace action in the dashboard.

## License

Bir is source-available under the Functional Source License 1.1 with Apache 2.0
as the future license (`FSL-1.1-ALv2`). You may use it for permitted purposes
such as internal use, non-commercial education, non-commercial research, and
professional services for licensees. You may not use it to offer a competing
commercial product or service with the same or substantially similar
functionality.

Each version becomes available under Apache License 2.0 two years after it is
made available. FSL is not an OSI-approved open source license.
