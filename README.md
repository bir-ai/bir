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
- FastAPI ingestion and a minimal local dashboard for traces, experiments, and
  observed prompt playground runs
- Dependency-free LangChain callback tracing

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

Alternatively, browse `.bir/traces.jsonl` in the dashboard without uploading
anything — see [Browse traces locally](#browse-traces-locally) below.

## Browse traces locally

Record traces with the SDK, then read them back in the dashboard from one server
process — no uploading. The server reads the SDK's trace file directly and serves
the dashboard on the same origin.

1. Record traces. The SDK writes them to `.bir/traces.jsonl` in your working
   directory by default (override with `configure(trace_path="...")`). To
   generate a trace without writing any code, run the bundled demo from the
   repository root — it writes to `examples/openai-demo/.bir/traces.jsonl`:

   ```bash
   cd examples/openai-demo
   PYTHONPATH=../../packages/python-sdk/src python3 demo.py
   ```

2. Build the dashboard's static export once. This emits a static site to
   `apps/web/out/`:

   ```bash
   cd apps/web
   npm run build
   ```

3. Start the server pointed at the `.bir` directory that holds `traces.jsonl`,
   serving the dashboard from the same origin. Use your project's `.bir`
   directory, or the demo's for the trace recorded above:

   ```bash
   cd apps/server
   BIR_DATA_DIR=../../examples/openai-demo/.bir \
   BIR_DASHBOARD_DIR=../web/out \
   ../../.venv/bin/uvicorn app.main:app --reload
   ```

4. Open `http://127.0.0.1:8000/` in a browser. The dashboard and the API
   (`/health`, `/v1/*`) share one origin, so no CORS setup is needed.

The server re-reads `traces.jsonl` as the SDK appends to it, and `run_experiment()`
results under `.bir/experiments/` show up without a `send_experiment()` upload.
Because this is read-only local data mode, ingestion and Playground endpoints
return `403`. See `apps/server/README.md` for the full reference.

## Local MVP Loop

Install server and web dependencies once if they are not already available:

```bash
python3 -m venv .venv

cd apps/server
../../.venv/bin/python -m pip install -e ".[dev]"

cd ../web
npm install
```

From the repository root, start the local ingestion server and dashboard
together:

```bash
scripts/dev-local
```

The runner prints the local URLs, checks for the repo `.venv`, server
dependencies, and web dependencies, then starts:

- API: `http://127.0.0.1:8000`
- Dashboard: `http://localhost:3000`

It does not install dependencies. Use `scripts/dev-local --check` for a
non-mutating prerequisite check.

### Playground

The dashboard includes a Playground for quick observed prompt experiments
against a local OpenAI-compatible model server. With Ollama running locally,
open `http://localhost:3000`, choose Playground, select `llama3.2:1b` or another
available model, and send a message. Bir proxies the model call through the
FastAPI server, records the exchange as a normal trace, and links the reply back
to the trace detail view with token usage and latency.

The Playground setup panel also has optional observed-workflow controls. Paste
context to inject it into the model call as system context (recorded as a
`playground.prepare_context` span), enable "Use context as retrieval" to record
the context as a retrieval tool call with one document, and enable "Run basic
evaluators" to record deterministic `answered`, `length_ok`, and — when an
expected answer is provided — `contains_expected` scores on the trace. The
trace detail view shows the full workflow: span, retrieval, generation, and
scores.

A Playground session can also be exported as an evals dataset: the "Export
dataset" button downloads the session's turns as JSONL that loads directly
with `bir.evals.Dataset.from_jsonl`, so a conversation you liked can be
re-run as an experiment against another model or prompt and compared in the
Experiments tab.

The model server defaults to `http://127.0.0.1:11434`, which works with Ollama.
Set `BIR_PLAYGROUND_BASE_URL` before starting the server to use LM Studio,
vLLM, or another OpenAI-compatible server:

```bash
BIR_PLAYGROUND_BASE_URL=http://127.0.0.1:1234 scripts/dev-local
```

Playground prompts and responses are captured intentionally because each chat
turn is an explicit user action for trace inspection. Do not paste secrets into
the Playground. When the server runs with `BIR_DATA_DIR` read-only local data
mode, Playground endpoints are disabled because that mode does not write server
events.

From the repository root, run the dependency-free OpenAI-style demo:

```bash
cd examples/openai-demo
PYTHONPATH=../../packages/python-sdk/src python3 demo.py
```

Start the ingestion server in another terminal from the repository root:

```bash
cd apps/server
../../.venv/bin/python -m uvicorn app.main:app --reload
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

## LangChain

Use the optional callback handler in apps that already use LangChain:

```python
from bir.integrations.langchain import BirCallbackHandler

result = chain.invoke(
    {"question": "What is Bir?"},
    config={"callbacks": [BirCallbackHandler()]},
)
```

The handler records root chains as traces, LLM calls as generations, retrievers
as retrieval tool calls, and tools as tool calls without adding LangChain as an
SDK dependency.

## Anthropic

Wrap an Anthropic Messages call to record it as a generation, without adding
`anthropic` as an SDK dependency:

```python
import anthropic

from bir import observe
from bir.integrations.anthropic import trace_messages


@observe()
def answer_question(question: str) -> str:
    client = anthropic.Anthropic()
    response = trace_messages(
        client.messages.create,
        model="claude-opus-4-8",
        max_tokens=1024,
        messages=[{"role": "user", "content": question}],
    )
    return response.content[0].text
```

`trace_messages` forwards the call to `client.messages.create` unchanged and
returns its response, recording one generation with the request as input and the
model and token usage read from the response. Its own options are prefixed
`bir_` (for example `bir_name` or `bir_metadata`) so they never collide with
Anthropic `create` arguments such as `metadata`.

## Google Gemini

Wrap a Gemini `generate_content` call to record it as a generation, without
adding `google-genai` as an SDK dependency:

```python
from google import genai

from bir import observe
from bir.integrations.google import trace_generate_content


@observe()
def answer_question(question: str) -> str:
    client = genai.Client()
    response = trace_generate_content(
        client.models.generate_content,
        model="gemini-2.5-flash",
        contents=question,
    )
    return response.text
```

`trace_generate_content` forwards the call to `client.models.generate_content`
unchanged and returns its response, recording one generation with the request as
input, the model read from the request `model` argument, and token usage read
from the response `usage_metadata`. Its own options are prefixed `bir_` (for
example `bir_name` or `bir_metadata`) so they never collide with Gemini
`generate_content` arguments such as `config`.

## LiteLLM

Wrap a LiteLLM `completion` call to record it as a generation, without adding
`litellm` as an SDK dependency. One wrapper covers the many providers LiteLLM
routes to:

```python
import litellm

from bir import observe
from bir.integrations.litellm import trace_completion


@observe()
def answer_question(question: str) -> str:
    response = trace_completion(
        litellm.completion,
        model="anthropic/claude-3-5-sonnet",
        messages=[{"role": "user", "content": question}],
    )
    return response.choices[0].message.content
```

`trace_completion` forwards the call to `litellm.completion` unchanged and
returns its OpenAI-shaped response, recording one generation with the request as
input and the model and token usage read from the response. The provider is
derived from the request `model` id (the prefix before the first `/`, for
example `anthropic`) and recorded as `metadata["provider"]`. Its own options are
prefixed `bir_` (for example `bir_name` or `bir_metadata`) so they never collide
with LiteLLM `completion` arguments such as `metadata`.

## License

Bir is source-available under the Functional Source License 1.1 with Apache 2.0
as the future license (`FSL-1.1-ALv2`). You may use it for permitted purposes
such as internal use, non-commercial education, non-commercial research, and
professional services for licensees. You may not use it to offer a competing
commercial product or service with the same or substantially similar
functionality.

Each version becomes available under Apache License 2.0 two years after it is
made available. FSL is not an OSI-approved open source license.
