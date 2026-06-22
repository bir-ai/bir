# Bir Implementation Roadmap

This roadmap covers the standalone Bir product repository: the FastAPI server,
Next.js dashboard, shared fixtures, and product documentation. It intentionally
stays short and treats tracked code, tests, manifests, and CI as the source of
truth.

## Repository Boundary

- `apps/server` contains the ingestion, query, experiment, Playground, and
  read-only local-data APIs.
- `apps/web` contains the dashboard.
- `tests/fixtures` contains shared event-contract fixtures.
- The Python SDK is developed and published from a separate repository. This
  repository consumes the published `bir-sdk` package for server contract tests
  and documents how product users connect it; SDK development and publishing
  are not work items here.
- Authentication, billing, hosted infrastructure, SQLite migration, and SDK
  publishing are outside the current roadmap.

## Verified Current State

### Trace ingestion and inspection

- The server validates and stores JSONL trace events, rejects invalid payloads,
  redacts common secrets, and handles duplicate event IDs idempotently.
- `GET /v1/traces` supports status, root-name, event-type, service,
  environment, and positive minimum-duration filters. Filters combine with AND.
- Trace results support recent and slowest-first ordering plus a positive
  result limit.
- `GET /v1/traces/{trace_id}` returns one ordered trace or `404`.
- The dashboard fetches the selected trace through the detail endpoint and
  renders its nested timeline, captured values, errors, usage, cost, metadata,
  retrievals, and scores.

### Trace triage

- Failed-trace triage is implemented through the Errors only shortcut and the
  status filter.
- Slow-trace triage is implemented through slowest-first ordering and a
  minimum-duration threshold.
- Errors only, slowest-first, minimum duration, and the remaining filters can be
  combined. A separate slow/failed view would duplicate the current workflow
  and is not planned.
- Summary metrics include error count, p50/p95 latency, token and cost totals,
  and model/provider breakdowns.

### Retrieval and evaluation display

- Retrievals use `tool_call` events with `metadata.kind = "retrieval"` and
  optional `output.documents` records.
- The server validates retrieval document `rank` as a non-negative integer and
  `score` as a non-negative finite number when present.
- The dashboard renders retrieval queries and documents in trace detail.
- Faithfulness and RAG-quality scores are grouped separately from other scores.
  The grouping recognizes the built-in names `answer_context_overlap`,
  `faithfulness`, and `groundedness`, or explicit
  `metadata.group = "faithfulness"`.
- The generic score display remains the contract; the product does not claim
  that a deterministic overlap score proves faithfulness.

### Experiments and Playground

- Experiment upload, list, detail, validation, comparison, and linked traces are
  implemented for JSONL artifacts produced by the external SDK.
- Experiment comparison classifies success-to-error transitions as regressions
  and error-to-success transitions as improvements. Because the stored contract
  has no score-direction field, nonzero score-only deltas remain visible but are
  classified neutrally as changed.
- Playground turns are recorded as normal trace events and can include context,
  a retrieval record, and deterministic scores.
- The server can read SDK-owned `.bir` output in read-only mode and can serve a
  built static dashboard from the same origin.

## CI and Local Checks

CI has two jobs:

- Python 3.12 installs `apps/server[dev]` plus `pyright`, then runs server tests
  and runs `pyright` from the repository root.
- Node.js 22 runs `npm ci`, lint, type checking, and web tests in `apps/web`.

The repository-local equivalents are:

```bash
cd apps/server
../../.venv/bin/python -m pytest

cd ../web
npm run test
npm run typecheck
npm run lint
```

Only report a check as passing after it succeeds in the current environment.
No local command in this roadmap builds, tests, or publishes the external SDK.
Pyright is not part of the server's `[dev]` extra; install it separately and run
`pyright` from the repository root when reproducing that CI check locally.

## Next Minimal Commits

The next verified product gap is bounded trace browsing beyond the current
fixed result limit. Add a small pagination or load-more slice that preserves the
active filters and recent/slowest ordering, with server and dashboard tests for
stable page boundaries. Do not add a duplicate slow/failed-trace view.

After that, choose the next step from observed product usage and keep it within
this repository boundary. Each step should preserve existing behavior, add
tests for new logic, update public documentation when behavior changes, and run
the relevant checks above.
