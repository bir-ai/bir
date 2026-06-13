# Bir Implementation Roadmap

This document is a practical, commit-sized roadmap for building Bir into a
source-available LLM evaluation, tracing, and observability platform.

Bir should help developers monitor, debug, evaluate, and improve LLM
applications, AI agents, and RAG systems. The product should grow in small,
working vertical slices instead of jumping directly to enterprise features.

## Product Scope

Bir should eventually support:

- LLM tracing
- prompt and response logging
- token and cost tracking
- latency and error monitoring
- prompt versioning
- evaluation pipelines
- hallucination and faithfulness evaluation
- RAG retrieval inspection
- regression testing
- experiment comparison

The early product promise should stay narrow:

> A Python developer can add a few lines of code, record local JSONL traces,
> send them to a local FastAPI server, inspect them in a dashboard, and attach
> basic evaluation scores.

## Current Development Posture

Publishing is intentionally deferred. The project should continue accumulating
small, tested product slices before a public SDK release. Treat release
verification, package metadata, and CI as quality gates that keep the codebase
publishable later, not as the current milestone.

Agents should not create release tags, configure PyPI publishing, or prioritize
release operations unless the user explicitly asks for publishing work.

## Non-Goals For The Early Stages

Do not prioritize:

- authentication
- billing
- organizations or teams
- RBAC
- distributed queues
- Kubernetes deployment logic
- complex plugin systems
- hosted telemetry
- large database infrastructure

These can wait until the local developer experience is reliable.

## Engineering Principles

- Keep the Python SDK first-class.
- Keep the public API small.
- Prefer decorators and context managers.
- Support sync Python first.
- Keep local JSONL storage useful before adding SQLite.
- Make input and output capture opt-in.
- Redact common secret patterns before writing events.
- Use explicit schema versions.
- Keep SDK, server, dashboard, and fixtures aligned.
- Add tests for each user-visible behavior.
- Ship each stage as small, reviewable commits.

## Current Foundation

The repository already has a useful foundation:

- Python SDK in `packages/python-sdk`
- FastAPI server in `apps/server`
- Next.js dashboard in `apps/web`
- shared event fixtures in `tests/fixtures`
- local OpenAI-style demo in `examples/openai-demo`

The current trace contract includes:

- `trace`
- `span`
- `generation`
- `tool_call`
- `score`

The current implementation has moved beyond the first foundation commits:

- the SDK package metadata, package README, changelog, and release-candidate
  checklist are present
- local JSONL tracing works without a server
- input/output capture is opt-in and redacts common secret-like fields and text
  patterns
- SDK event loading validates schema version `1.0`
- `send_events()` posts local events to the FastAPI server root-first
- the FastAPI server validates, persists, lists, and retrieves trace events from
  JSONL
- duplicate event IDs are idempotent on ingestion
- `GET /v1/traces/{trace_id}` exists and is tested
- generation events support optional model, token usage, user-provided cost, and
  currency
- the dashboard lists traces, renders a nested event timeline, and displays
  model, score, usage, cost, latency, errors, metadata, input, and output when
  present
- dashboard contract tests read the shared JSONL fixture directly instead of a
  duplicated TypeScript fixture
- RAG retrieval is supported by a small `retrieval()` SDK helper that emits a
  `tool_call` with `metadata.kind = "retrieval"` and `output.documents`
- prompt metadata is supported through `prompt()` and is attached to generation
  events under `metadata.prompt`
- local deterministic evals, datasets, experiment JSONL persistence, experiment
  summaries, and optional experiment trace recording are implemented in
  `bir.evals`
- the server accepts, stores, lists, and returns experiment detail artifacts
- the dashboard includes Traces and Experiments views with experiment
  list/detail inspection
- the dashboard renders a focused prompt panel with prompt name, version,
  template hash, and opt-in rendered prompt on generation details
- the server and dashboard filter traces by root status, root name, contained
  event type, service, and environment
- the dashboard compares a baseline experiment against a candidate run and
  reports aggregate score deltas plus regressed, missing, new, improved, and
  unchanged examples
- `bir.evals.answer_context_overlap()` provides a deterministic RAG
  answer/context faithfulness heuristic
- the dashboard trace summary shows error counts, p50/p95 latency, total tokens,
  and total cost
- the FastAPI server can serve the dashboard's static export from
  `BIR_DASHBOARD_DIR` on the same origin as the API
- a shared redaction fixture pins SDK and server secret redaction together, and
  the shared trace fixture covers prompt and service metadata

The next work should build on this contract instead of replacing it. With prompt
display, experiment comparison, faithfulness scoring, trace filtering, and trace
summaries already shipped, the highest-confidence remaining slices are trace
query ergonomics (recency ordering and a result limit) and the remaining
production-observability breakdowns.

## Stage 1: Python SDK Release Candidate Hygiene

Status: mostly complete. Package build verification and fresh virtualenv smoke
testing are covered by `packages/python-sdk/scripts/verify_release.py`. CI now
runs SDK, server, pyright, web, contract, and SDK release verification checks.
Publishing is deferred; keep this stage as a regression and quality gate while
development continues.

Goal: keep the SDK close to release-candidate quality without shifting current
work toward publication.

Deliverables:

- complete package metadata in `packages/python-sdk/pyproject.toml`
- SDK README with a future `pip install bir` path clearly marked as post-release
- local trace quickstart
- privacy and redaction notes
- changelog entry for `0.1.0`
- clean package build workflow
- fresh virtualenv install smoke test
- CI checks for SDK, server, dashboard, and release verification
- SDK tests passing
- pyright passing

Acceptance checks:

```bash
cd packages/python-sdk
PYTHONPATH=src ../../.venv/bin/python -m unittest discover -s tests

cd ../..
./.venv/bin/pyright
```

Build checks, only if publishing work is explicitly requested:

```bash
cd packages/python-sdk
python -m build
python -m twine check dist/*
```

Suggested commits:

1. Add complete SDK package metadata.
2. Keep SDK README clear for local development and future package users.
3. Add changelog and release checklist.
4. Add clean build and install smoke-test documentation.
5. Add minimal CI for SDK tests and type checking: implemented.

Codex task brief:

```text
Inspect the Python SDK packaging and documentation. Make one small commit-sized
documentation/config change that preserves release-candidate quality without
starting publishing work. Do not change runtime SDK behavior. Run the SDK
unittest command and pyright if available. Summarize the exact files changed and
the next smallest development step.
```

## Stage 2: Trace Contract Hardening

Status: mostly complete. The SDK, server, dashboard, and shared JSONL fixture are
covered by tests. Continue tightening this stage whenever event fields change.

Goal: make the trace event model stable enough for SDK, server, dashboard, and
examples to evolve safely.

Deliverables:

- clearly documented event schema rules
- SDK validation aligned with server validation
- fixture covering all current event types
- tests proving SDK-generated events are accepted by the server
- tests proving dashboard contract parsing handles fixture data
- explicit handling for schema version changes

Recommended event fields:

- `schema_version`
- `id`
- `trace_id`
- `parent_id`
- `name`
- `type`
- `start_time`
- `end_time`
- `status`
- `metadata`
- `input`
- `output`
- `error`

Acceptance checks:

```bash
cd packages/python-sdk
PYTHONPATH=src ../../.venv/bin/python -m unittest discover -s tests

cd ../../apps/server
../../.venv/bin/python -m pytest

cd ../../apps/web
npm run typecheck
```

Suggested commits:

1. Document the event contract and compatibility rules.
2. Add or tighten SDK contract tests.
3. Add or tighten server contract tests.
4. Add or tighten dashboard fixture parsing tests.

Codex task brief:

```text
Inspect the shared trace event contract across SDK, server, dashboard, and
tests/fixtures. Make one small commit-sized improvement that increases contract
confidence without changing unrelated behavior. Update tests if behavior changes.
Run the relevant SDK/server/web checks that are already available.
```

## Stage 3: Token And Cost Tracking

Status: implemented for explicit, user-provided generation usage and cost values.
Do not add provider pricing tables yet.

Goal: make generation events useful for monitoring model usage and spend.

Deliverables:

- token usage fields for generations
- cost fields for generations
- currency field, defaulting to `USD` when cost is present
- validation that numeric values are finite
- SDK tests for usage and cost
- server validation for usage and cost
- dashboard display for tokens and cost

Suggested SDK shape:

```python
with generation("openai.chat.completions", model="gpt-4o-mini") as gen:
    response = call_model()
    gen.set_output(response)
    gen.set_usage(input_tokens=120, output_tokens=80)
    gen.set_cost(input_cost=0.000018, output_cost=0.000048, currency="USD")
```

Schema guidance:

- keep usage and cost optional
- do not require provider-specific pricing logic yet
- do not calculate cost automatically in the first version
- allow users to pass known cost values explicitly

Suggested commits:

1. Add cost fields to the event contract.
2. Add SDK `set_cost()` behavior and tests.
3. Add server validation tests for cost fields.
4. Add dashboard token and cost display.
5. Update docs and demo.

Codex task brief:

```text
Add the smallest useful token/cost tracking improvement for generation events.
Keep cost user-provided; do not add provider pricing tables. Update SDK, schema,
server, dashboard, fixtures, and docs only as required for this one increment.
Run the relevant existing checks.
```

## Stage 4: Trace Detail API And Dashboard

Status: mostly complete. The server trace detail endpoint is implemented, the
dashboard renders the nested timeline, and focused generation, prompt, and
retrieval panels surface details without scanning raw metadata. Remaining
optional work is to use the dedicated detail endpoint where it improves UX.

Goal: make the local dashboard useful for debugging one trace.

Deliverables:

- `GET /v1/traces/{trace_id}` endpoint
- trace detail view in the dashboard
- nested event timeline
- generation input/output panel
- tool call panel
- score panel
- latency and error display
- token and cost display when present

Dashboard priorities:

- clarity over visual complexity
- readable event hierarchy
- fast scanning of failures
- compact display of timings and model calls
- safe display of captured input/output

Suggested commits:

1. Add server trace detail endpoint and tests.
2. Add dashboard trace detail route.
3. Add timeline rendering.
4. Add generation/tool/score detail panels.
5. Add error, latency, token, and cost summaries.

Codex task brief:

```text
Improve the trace detail experience by one small vertical slice. Prefer one
endpoint, one UI component, or one tested rendering behavior per change. Keep
the dashboard minimal and focused on debugging traces.
```

## Stage 5: RAG Retrieval Inspection

Status: mostly complete. The SDK has a first-class `retrieval()` helper that
emits the recommended `tool_call` shape, the shared fixture uses
`output.documents`, SDK tests cover capture/redaction/defaults, the OpenAI-style
demo uses the helper, and the dashboard renders retrieval query/document
details.

Goal: help users debug RAG retrieval quality.

Current direction: keep retrieval on the existing event model instead of adding
a dedicated event type. `retrieval()` emits a `tool_call` event with
`metadata.kind = "retrieval"`, query data in `input.query` when capture is
enabled, and retrieved records in `output.documents` when capture is enabled.

Deliverables:

- SDK context manager for retrieval: implemented
- retrieved document records: implemented through `output.documents`
- rank, score, source, text, and metadata fields: implemented in the SDK helper
- SDK, server, fixture, and dashboard contract coverage: implemented
- dashboard display for query and retrieved documents: implemented
- retrieval-specific server validation: defer until generic JSON validation is
  not enough for real RAG debugging

Suggested SDK shape:

```python
from bir import retrieval

with retrieval("vector_search", query=question) as r:
    r.add_document(
        id="doc-1",
        text="Bir records local traces with JSONL.",
        score=0.82,
        rank=1,
        metadata={"source": "docs"},
    )
```

Schema guidance:

- preserve the existing event model where possible
- start with `tool_call` events marked by `metadata.kind = "retrieval"` unless
  the contract needs a dedicated retrieval event later
- represent retrieved documents as `output.documents`
- document records should support `id`, `rank`, `score`, `source`, `text`, and
  `metadata`
- keep document text/snippets opt-in or configurable
- support document ids even when text is not captured
- do not add vector database integrations yet

Completed commits:

1. Document retrieval event shape.
2. Add SDK retrieval context manager and tests.
3. Add fixture coverage.
4. Update OpenAI-style demo to use retrieval.
5. Keep server and dashboard contract tests aligned with the shared fixture.

Next suggested commits:

1. Add focused retrieval document validation only if the generic event contract
   becomes too loose.

Codex task brief:

```text
Add the smallest useful dashboard retrieval inspection slice. Render retrieval
tool calls marked with metadata.kind = "retrieval" so users can scan the query
and retrieved documents. Preserve the existing event contract and do not add
external vector database dependencies.
```

## Stage 6: Prompt Logging And Prompt Versioning

Status: mostly complete. The SDK `prompt()` helper attaches prompt name,
version, template hash, and optional prompt payload metadata to generation
events under `metadata.prompt`, and the dashboard renders a focused prompt panel
on generation details.

Goal: let users connect model outputs to the prompt versions that produced them.

Deliverables:

- prompt fields linked to generations: implemented
- prompt name: implemented
- prompt version: implemented
- template hash: implemented
- template and variables: opt-in capture implemented
- rendered prompt, only when capture is enabled: implemented
- dashboard display for prompt version and rendered prompt: implemented through
  the prompt panel
- dedicated prompt-version comparison: not yet; run-level comparison is
  available through experiment comparison

Suggested SDK shape:

```python
from bir import prompt

p = prompt(
    name="answer_question",
    version="v1",
    template="Answer using this context: {context}",
    variables={"context": context},
)
```

Early constraints:

- do not build a complex prompt registry yet
- do not add hosted prompt management
- keep prompt data local and event-based first
- keep rendered prompt capture configurable

Suggested commits:

1. Document prompt event shape.
2. Add SDK prompt helper and tests.
3. Link prompt metadata to generation events.
4. Add server validation.
5. Add dashboard prompt display.
6. Update docs and demo.

Codex task brief:

```text
Add one small prompt logging or prompt versioning improvement. Keep it local and
event-based. Do not build a prompt registry or hosted prompt management system.
Preserve opt-in capture for rendered prompt text.
```

## Stage 7: Evaluation Layer

Status: mostly complete for the local deterministic slice. `bir.evals` includes
exact match, substring containment, regex matching, JSON validity, structured
field checks, latency and cost thresholds, numeric ranges, custom evaluators,
and an `EvalResult` model.

Goal: support basic local evaluation without requiring external services.

Deliverables:

- stable `score()` behavior: implemented
- built-in deterministic evaluators: implemented for the current local MVP
- local evaluator result serialization: implemented through experiment results
- docs for custom evaluators: implemented
- tests for each evaluator: implemented for the current local MVP

Initial evaluators:

- exact match
- contains
- regex match
- JSON validity
- latency threshold
- cost threshold
- custom Python function

Avoid LLM-as-judge until deterministic evaluation is solid.

Suggested API shape:

```python
from bir.evals import contains, exact_match

result = exact_match(expected="Paris").evaluate(output="Paris")
score("exact_match", result.value)
```

Suggested commits:

1. Add `bir.evals` package with one deterministic evaluator.
2. Add evaluator result model and tests.
3. Add more deterministic evaluators.
4. Document custom evaluator pattern.
5. Connect evaluator outputs to `score()`.

Codex task brief:

```text
Add one deterministic local evaluator with tests and documentation. Keep the API
small and avoid external LLM/provider dependencies. Connect the result to the
existing score model only if that can be done cleanly in this small change.
```

## Stage 8: Datasets, Regression Testing, And Experiments

Status: mostly complete for the local JSONL slice. The SDK can load/store local
dataset JSONL files and run sync tasks over examples with deterministic
evaluators, writing one JSONL result row per example plus a sibling summary. The
server can ingest experiment artifacts, and the dashboard can list experiments,
show per-example detail, and compare a baseline run against a candidate run.

Goal: let users run a task over examples and compare results.

Deliverables:

- local dataset JSONL format: implemented
- dataset loader: implemented
- experiment runner: implemented for sync callables
- per-example results: implemented
- aggregate scores: implemented
- latency per example: implemented
- dashboard experiment list: implemented
- dashboard experiment detail: implemented
- baseline comparison: implemented through the dashboard experiment comparison
  view

Suggested local dataset format:

```json
{"id":"q1","input":{"question":"What is Bir?"},"expected":"An observability SDK"}
```

Suggested API shape:

```python
from bir.evals import Dataset, exact_match, run_experiment

dataset = Dataset.from_jsonl("questions.jsonl")

run_experiment(
    name="prompt-v2",
    dataset=dataset,
    task=answer_question,
    evaluators=[exact_match()],
)
```

Storage guidance:

- start with `.bir/datasets/*.jsonl`
- start with `.bir/experiments/*.jsonl`
- do not add a database until local query needs justify it

Suggested commits:

1. Document dataset and experiment JSONL formats.
2. Add dataset loader tests.
3. Add simple experiment runner.
4. Add evaluator integration.
5. Add experiment result persistence.
6. Add dashboard experiment list.
7. Add dashboard comparison view.

Codex task brief:

```text
Add one small local experiment or dataset feature. Keep storage JSONL-based.
Avoid databases and background workers. Include tests for serialization and one
example-driven workflow.
```

## Stage 9: Hallucination And Faithfulness Evaluation

Status: first slice implemented. `bir.evals.answer_context_overlap()` scores the
fraction of answer word tokens supported by retrieved context texts, covers the
"retrieved context empty while answer is confident" case, and documents that
overlap is a heuristic rather than proof of faithfulness.

Goal: help users detect unsupported answers, especially in RAG systems.

Deliverables:

- faithfulness evaluator interface: implemented through the shared deterministic
  evaluator interface
- context relevance metrics: not yet
- answer/context overlap baseline: implemented via `answer_context_overlap()`
- optional LLM judge: deferred
- dashboard score display: covered by generic score display; faithfulness-specific
  grouping not yet
- docs explaining limitations: implemented in the evaluator docstring

Initial non-LLM metrics:

- answer contains cited context
- retrieved context empty while answer is confident
- simple answer/context overlap
- custom user-provided faithfulness function

LLM-as-judge should come later because it introduces provider dependencies,
cost, latency, and prompt management.

Suggested commits:

1. Document faithfulness evaluation scope and limitations: implemented.
2. Add one deterministic RAG faithfulness helper: implemented.
3. Add tests with retrieved documents: implemented.
4. Add dashboard score grouping for faithfulness metrics.
5. Add optional LLM judge design document, not implementation: deferred.

Codex task brief:

```text
Add one small hallucination or faithfulness evaluation improvement. Prefer a
deterministic local metric first. Document limitations clearly. Do not add LLM
judge provider dependencies in this step.
```

## Stage 10: Production Observability Basics

Status: in progress. `configure()` records `service_name` and `environment`
under `metadata.service`. The server and dashboard now filter traces by root
status, root name, contained event type, service, and environment, and the
dashboard trace summary shows error counts, p50/p95 latency, total tokens, and
total cost. Remaining work is a model/provider breakdown, dedicated slow and
failed trace views beyond the status filter, and optional sampling
configuration.

Goal: make local traces useful for production debugging without adding enterprise
management features.

Deliverables:

- service name: implemented
- environment name: implemented
- trace filtering: implemented for status, name, event type, service, and
  environment
- trace search: partial through the root-name substring filter
- error rate summaries: implemented as dashboard error counts
- latency summaries: implemented as dashboard p50/p95 latency
- token and cost totals: implemented in the dashboard trace summary
- model/provider breakdown: not yet
- slow traces view: not yet; sort and dedicated view still open
- failed traces view: covered by the `status=error` filter
- optional sampling configuration: not yet

Suggested SDK configuration:

```python
from bir import configure

configure(
    service_name="rag-api",
    environment="production",
)
```

Suggested commits:

1. Add service and environment metadata: implemented.
2. Add server query filters: implemented.
3. Add dashboard trace filters: implemented.
4. Add latency and error summaries: implemented.
5. Add a model/provider breakdown to the trace summary.
6. Add sampling configuration, if needed.

Codex task brief:

```text
Add one production observability improvement that builds on existing trace data.
Keep it local-first. Do not add auth, organizations, RBAC, queues, or deployment
systems. Include tests for any new query or SDK behavior.
```

## Recommended Milestone Order

Already delivered:

- release-candidate checks and trace contract hardening kept passing
- focused dashboard prompt panel for generation prompt metadata
- trace filtering across the server and dashboard
- experiment comparison dashboard
- deterministic faithfulness and hallucination scoring
- core production-observability summaries (error counts, latency p50/p95, token
  and cost totals)

Remaining order:

1. Keep release-candidate checks and trace contract hardening passing as schemas
   change
2. Add `/v1/traces` recency ordering and a result limit
3. Add the remaining production-observability breakdowns (model/provider) and
   optional sampling
4. Add SQLite storage, only when JSONL becomes limiting

## First Ten Minimal Commits

Completed or effectively covered:

1. Complete SDK package metadata.
2. Add SDK quickstart for local development and future package users.
3. Add changelog and release checklist.
4. Add generation cost fields to the schema.
5. Add SDK `set_cost()` and tests.
6. Add server validation for cost fields.
7. Add trace detail endpoint.
8. Add dashboard trace detail page.
9. Add retrieval event shape documentation and SDK helper.
10. Harden dashboard contract tests against the shared JSONL fixture.

Next minimal commits:

The previous four (dashboard prompt panel, server query filters, experiment
comparison, and a deterministic faithfulness evaluator) are now implemented. The
next high-confidence slices are:

1. Add `/v1/traces` recency ordering and a `limit` query parameter (server
   `storage.py` and `main.py` plus the web client) so large local stores stay
   fast to browse.
2. Add a model/provider breakdown to the dashboard trace summary using the
   existing `summarizeTraces` aggregation.

Deferred until the sync path is explicitly declared stable: async `@observe`
(the decorator raises `TypeError` for coroutine functions today by design).
SQLite storage, authentication, billing, LLM-as-judge evaluation, and publishing
remain deferred.

## Definition Of Done For Each Step

Each step should:

- be small enough for one focused review
- preserve existing behavior unless intentionally changed
- include tests for new logic
- update docs when public behavior changes
- keep SDK, server, dashboard, and fixtures aligned when schema changes
- avoid unrelated refactors
- pass the relevant existing checks

## Standard Check Commands

Python SDK:

```bash
cd packages/python-sdk
PYTHONPATH=src ../../.venv/bin/python -m unittest discover -s tests
```

Backend:

```bash
cd apps/server
../../.venv/bin/python -m pytest
```

Type checking:

```bash
./.venv/bin/pyright
```

Web:

```bash
cd apps/web
npm run lint
npm run typecheck
```

Use only checks whose dependencies are already installed. Do not install new
dependencies unless the current task explicitly asks for it.
