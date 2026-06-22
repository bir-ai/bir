<p align="center">
  <img src="bir_logo.png" alt="bir logo" width="160">
</p>

# bir

**/biɾ/** · Turkish for "one"

LLM Evaluation, Tracing & Observability Platform

This repository is the **Bir product**: a FastAPI ingestion server and a Next.js
dashboard for inspecting traces, experiments, and Playground runs.

> **The Python SDK is developed and published from a separate repository** and
> is consumed here from PyPI as
> [`bir-sdk`](https://pypi.org/project/bir-sdk/) (the import name stays `bir`).
> Instrument your app with the SDK, then point it at the server in this repo to
> explore the results in the dashboard.

## What's in this repo

```text
apps/
  server/   # FastAPI ingestion API + Playground proxy — see apps/server/README.md
  web/      # Next.js dashboard — see apps/web/README.md
docs/       # Design notes and implementation roadmap
```

The SDK surface — `@observe`, spans, generations, scores, datasets, experiments,
and the LangChain / LlamaIndex / OpenAI / Anthropic / Gemini / LiteLLM
integrations — is **not** in this repo. See the separate
[`bir-sdk`](https://pypi.org/project/bir-sdk/) package.

## Requirements

- Python 3.10+
- Node.js 22+

## Run the server and dashboard locally

The helper scripts provide the shortest setup and development flow:

```bash
./scripts/setup.sh   # first run only; runtime dependencies
./scripts/dev.sh     # API and dashboard
```

To run only the API server:

```bash
./scripts/server.sh
```

Install dependencies once. The repo uses a single root virtualenv, and the
server's `[dev]` extra pulls the published `bir-sdk` for its contract test:

```bash
python3 -m venv .venv

cd apps/server
../../.venv/bin/python -m pip install -e ".[dev]"

cd ../web
npm install
```

Start the API server (terminal 1):

```bash
cd apps/server
../../.venv/bin/uvicorn app.main:app --reload
# API: http://127.0.0.1:8000
```

Start the dashboard (terminal 2):

```bash
cd apps/web
npm run dev
# Dashboard: http://localhost:3000
```

The dashboard calls the API directly from the browser. `npm run dev` points it
at `http://127.0.0.1:8000`, and the server allows that origin through CORS by
default. Open `http://localhost:3000` and use the filters to narrow traces by
status, name, or event type.

By default the server stores ingested events in `.bir/server-events.jsonl` and
uploaded experiments under `.bir/experiments/`. See
[apps/server/README.md](apps/server/README.md) for every endpoint and
environment variable.

## Connect the SDK

Install the SDK from PyPI in your application's environment:

```bash
pip install bir-sdk    # import name is `bir`
```

Instrument your code with the SDK (it writes traces to `.bir/traces.jsonl`
locally), then send the recorded events to this server:

```python
from bir import send_events

send_events("http://127.0.0.1:8000")
```

The uploaded traces, spans, generations, and scores then show up in the
dashboard. See the external [`bir-sdk`](https://pypi.org/project/bir-sdk/)
package documentation for the full SDK API and framework integrations.

## Browse traces locally (no upload)

The SDK writes traces to `.bir/traces.jsonl` in your project. The server can read
that file directly in read-only mode, so you can browse SDK output without
running any ingestion:

```bash
cd apps/server
BIR_DATA_DIR=/path/to/your/project/.bir \
  ../../.venv/bin/uvicorn app.main:app --reload
```

The server re-reads `traces.jsonl` as the SDK appends to it, and the SDK's
`run_experiment()` results under `.bir/experiments/` appear without a separate
upload. Because this mode does not own the data files, ingestion and Playground
endpoints return `403`.

## Serve the dashboard from the server (single origin)

Build the dashboard's static export once, then have the server serve both the API
and the UI from one origin — no CORS setup needed:

```bash
cd apps/web
npm run build          # emits a static site to apps/web/out/

cd ../server
BIR_DASHBOARD_DIR=../web/out \
  ../../.venv/bin/uvicorn app.main:app --reload
```

Open `http://127.0.0.1:8000/`. The dashboard and the API (`/health`, `/v1/*`)
share one origin. This composes with `BIR_DATA_DIR`, so a single process can both
serve the UI and browse SDK-written traces.

## Playground

The dashboard includes a Playground tab for quick prompt experiments against a
local OpenAI-compatible model server. With Ollama running, open the dashboard,
choose Playground, pick a model, and send a message. The server proxies the call,
records the exchange as a normal trace, and links the reply to its trace detail
with token usage and latency. Optional controls inject context, record it as a
retrieval, run basic evaluators, and export a session as a `bir-sdk` evals
dataset (JSONL).

The model server defaults to Ollama at `http://127.0.0.1:11434`. Point it at LM
Studio, vLLM, or another OpenAI-compatible server before starting:

```bash
cd apps/server
BIR_PLAYGROUND_BASE_URL=http://127.0.0.1:1234 \
  ../../.venv/bin/uvicorn app.main:app --reload
```

Do not paste secrets into the Playground; chat turns are captured intentionally.
Playground is disabled in read-only `BIR_DATA_DIR` mode. See
[apps/server/README.md](apps/server/README.md) and
[apps/web/README.md](apps/web/README.md) for the full reference.

## Tests

```bash
# Server
cd apps/server
../../.venv/bin/python -m pytest

# Dashboard
cd apps/web
npm run lint
npm run typecheck
npm run test
```

## License

Bir is source-available under the Functional Source License 1.1 with Apache 2.0
as the future license (`FSL-1.1-ALv2`). You may use it for permitted purposes
such as internal use, non-commercial education, non-commercial research, and
professional services for licensees. You may not use it to offer a competing
commercial product or service with the same or substantially similar
functionality.

Each version becomes available under Apache License 2.0 two years after it is
made available. FSL is not an OSI-approved open source license.
