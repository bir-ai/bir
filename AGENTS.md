# AGENTS.md

## Project Overview

This repository is a source-available LLM Evaluation, Tracing, and Observability Platform licensed under FSL-1.1-ALv2.

The goal is to help developers add tracing, evaluation, and monitoring to LLM applications in minutes.

Core product promise:

> Add observability to a Python LLM app with a few lines of code.

The project is currently early-stage. Prefer simple, clean, extensible architecture over feature-heavy implementation.

## Current Development Posture

The project is not being prepared for immediate public release. Treat release
verification, package metadata, and CI as quality gates for ongoing development,
not as a signal to publish.

Do not publish packages, create release tags, configure PyPI publishing, or
shift work toward release operations unless the user explicitly asks for it.
Prefer continuing small, tested product slices that improve the local-first SDK,
server, dashboard, evaluation, dataset, experiment, and prompt workflows.

## Repository Structure

```text
apps/
  server/        # FastAPI backend, ingestion API, and playground proxy (app/playground.py)
  web/           # Dashboard UI, incl. Playground tab (app/components/playground.tsx, app/playground-*.ts)
packages/
  python-sdk/    # Python SDK for tracing, spans, generations, tool calls, eval scores
examples/
  openai-demo/   # Minimal OpenAI tracing example
  langchain-demo/# LangChain integration example
  ollama-demo/   # Real local LLM tracing demo against a running Ollama model
scripts/
  dev-local      # One-command local dev loop (FastAPI server + dashboard)
docs/            # Documentation
```

## Product Direction

Prioritize this development order:

1. Python SDK
2. Local trace storage
3. FastAPI ingestion server
4. Minimal dashboard
5. Evaluation layer
6. Integrations

Do not start with complex enterprise features.

Avoid building:

* auth systems too early
* billing
* organizations/teams
* RBAC
* complex deployment logic
* over-engineered plugin systems

## Core Concepts

The platform should support these concepts:

* Trace: one full LLM workflow execution
* Span: a nested operation inside a trace
* Generation: an LLM call
* Tool Call: external function/tool usage
* Eval Score: quality, correctness, safety, or custom metric score
* Dataset: collection of examples for evaluation
* Experiment: evaluation run over a dataset

## Python SDK Expectations

The SDK should be the first-class developer experience.

Target API style:

```python
from bir import observe, score

@observe()
def answer_question(question: str):
    response = llm.call(question)
    score("helpfulness", 0.82)
    return response
```

SDK design rules:

* Keep the public API minimal.
* Prefer decorators and context managers.
* Support sync code first.
* Add async support only when the sync path is stable.
* Do not require a server for the first useful experience.
* Support local JSONL storage first; consider SQLite later only when JSONL becomes limiting.
* Never silently swallow errors in development mode.
* Do not log secrets, API keys, auth headers, or raw environment variables.

## Backend Expectations

The backend should be built with FastAPI.

Initial responsibilities:

* receive traces from SDK
* validate payloads
* persist traces
* expose trace query endpoints
* support a minimal health endpoint

Preferred stack:

* Python
* FastAPI
* Pydantic
* JSONL for the current local MVP
* SQLite later if local query needs outgrow JSONL
* PostgreSQL later

Do not introduce distributed systems, queues, or Kubernetes-related complexity unless explicitly requested.

## Web Dashboard Expectations

The dashboard should be minimal and useful.

Initial screens:

* traces list
* trace detail
* spans timeline
* generation input/output
* latency and error display
* eval score display

Preferred stack:

* Next.js
* TypeScript
* Tailwind
* shadcn/ui where useful

Do not over-design the UI. Prioritize clarity.

## Playground

The dashboard includes a Playground tab for sending chat turns to a local
OpenAI-compatible model server and recording each exchange as a normal trace.

* Server proxy in `apps/server/app/playground.py`; UI in
  `apps/web/app/components/playground.tsx`.
* Forwards chat turns to a local model server (Ollama by default) and records
  each exchange as a regular trace in the same event store.
* Local-default and stdlib-only (uses `urllib`; adds no new dependencies).
* User-initiated from the dashboard, not background traffic.
* Configurable via `BIR_PLAYGROUND_BASE_URL` (for example LM Studio or vLLM).
* Disabled in read-only `BIR_DATA_DIR` mode, like ingestion.

## Data Model Guidelines

Use explicit, versioned schemas.

Every trace-related event should include:

* id
* trace_id
* parent_id when nested
* name
* type
* start_time
* end_time
* status
* metadata
* input when safe
* output when safe
* error when present

Prefer append-friendly event models over highly coupled relational models in the early phase.

## Coding Style

General:

* Write boring, readable code.
* Prefer small modules.
* Prefer explicit names over clever abstractions.
* Avoid premature abstraction.
* Avoid global mutable state unless required for SDK ergonomics.
* Add comments only when they explain non-obvious decisions.

Python:

* Use type hints.
* Use Pydantic models for external schemas.
* Keep public SDK APIs stable and small.
* Prefer standard library where possible.
* Avoid unnecessary dependencies.

TypeScript:

* Use strict types.
* Avoid `any` unless there is a clear reason.
* Keep UI components small.
* Separate data fetching from presentation when practical.

## Testing Expectations

Add tests for core logic.

Prioritize tests for:

* SDK trace creation
* nested spans
* score recording
* payload serialization
* backend validation
* ingestion endpoint behavior

Do not add brittle snapshot tests early.

When modifying Python SDK or backend code, add or update relevant tests.

## Security and Privacy

This project handles sensitive LLM inputs and outputs.

Rules:

* Never log API keys.
* Never hardcode secrets.
* Never commit `.env` files.
* Redact common secret patterns when possible.
* Make input/output capture configurable.
* Prefer safe defaults for data collection.
* Do not send telemetry to third-party services without explicit user configuration.

## Dependency Policy

Before adding a production dependency:

* check whether the standard library is enough
* prefer mature, widely used packages
* avoid large frameworks for small tasks
* document why the dependency is needed

Do not add new databases, queues, or infrastructure services unless the task explicitly requires them.

## Development Commands

If commands are not yet available, create minimal ones as the project matures.

Use the project root `.venv` when it is available.

Current commands:

```bash
# Python SDK
cd packages/python-sdk
PYTHONPATH=src ../../.venv/bin/python -m unittest discover -s tests

# Backend
cd apps/server
../../.venv/bin/python -m pytest
../../.venv/bin/uvicorn app.main:app --reload

# Web
cd apps/web
npm run dev
npm run lint
npm run typecheck
```

## Documentation Rules

Update docs when changing public behavior.

Documentation should be developer-first and example-heavy.

Prefer:

* quickstart examples
* copy-paste snippets
* minimal explanations
* clear API references

Avoid vague marketing language inside technical docs.

## MVP Definition

The first meaningful MVP is complete when:

1. A user can install the Python SDK.
2. A user can decorate a Python function.
3. A trace is recorded locally.
4. A trace can be sent to the FastAPI server.
5. The dashboard can show the trace and its spans.
6. A basic eval score can be attached to the trace.

## Decision-Making Principles

When unsure, choose the option that is:

1. simpler
2. easier to test
3. better for developer experience
4. easier to replace later
5. less dependent on external services

## Agent Behavior

When working in this repository:

* First inspect the existing structure before creating files.
* Keep changes focused on the requested task.
* Do not rewrite unrelated code.
* Do not introduce large architectural changes without explaining why.
* Prefer incremental implementation.
* If a requested feature is too broad, implement the smallest useful vertical slice.
* After changes, summarize what changed and which commands should be run.
