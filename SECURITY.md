# Security Policy

Bir is a local-first LLM tracing and evals platform. This repository is the **Bir
product**: a FastAPI ingestion server and a Next.js dashboard. What gets captured in
the first place is decided in the instrumented application by the separately released
[`bir-sdk`](https://pypi.org/project/bir-sdk/) package (capture is opt-in and
redaction runs SDK-side before anything is written); this document describes the
**server's own, independent** security posture — what it stores, how it redacts, the
cross-repo redaction contract, and how to report a vulnerability.

For the full endpoint and environment-variable reference, see
[apps/server/README.md](apps/server/README.md); this page is the security-focused
summary.

## What the server stores

- **Storage is local-first.** Ingested events are appended to a JSONL file on your
  own machine (default `.bir/server-events.jsonl`) and uploaded experiments are
  stored under `.bir/experiments/`. The server does not transmit anything on its
  own; the only network call it makes is the Playground proxy to the local
  OpenAI-compatible model server you configure.
- **The server stores what applications explicitly send.** Events arrive via
  `send_events()` / `send_experiment()` from the SDK, which captures inputs and
  outputs only when the application opted in. Playground chat turns are the one
  intentional exception: they are captured by design, because every turn is an
  explicit user action for prompt inspection. Do not paste secrets into the
  Playground.

## Server-side redaction

The server does not trust incoming payloads to be pre-redacted. It applies its own
best-effort redaction **during validation** — inside the Pydantic payload models —
so a secret is replaced **before** the event is written to disk and **before** any
response is built from it. This applies on every path that accepts or parses data:

- ingested trace events (`POST /v1/events`, `POST /v1/events/batch`): event
  `metadata`, `input`, `output`, `error` text, and any extra payload fields;
- uploaded experiments (`POST /v1/experiments`): per-example `input`, `expected`,
  `output`, `error` text, and evaluator score metadata;
- Playground traces: the recorded chat turns and upstream error text pass through
  the same redaction before the events are written, on both successful and failed
  attempts.

**The dashboard is display-only.** It renders values the server already redacted and
never sees pre-redaction payloads, so it cannot reintroduce a secret.

**Built-in redaction rules always apply and cannot be disabled.** The server redacts
two ways:

- **Secret-like field names.** A mapping key whose normalized name is or contains a
  known secret term has its value replaced — including `access_key`, `api_key`,
  `apikey`, `authorization`, `auth_header`, `client_secret`, `password`,
  `private_key`, `secret`, `token`, and the standalone names `auth`, `credential`,
  `credentials`, and `creds`.
- **Secret-like text patterns.** Captured strings and error text are scanned for,
  and the matches replaced with `[redacted]`:
  - Labeled secrets (`api_key=...`, `password: ...`, `Authorization: ...`) and
    `Bearer ...` tokens.
  - `sk-...` tokens and JWTs (`eyJ....`).
  - AWS access key IDs (`AKIA...`, `ASIA...`).
  - Google API keys (`AIza...`).
  - Slack tokens (`xox[baprs]-...`).
  - GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`).
  - Stripe secret/restricted keys (`sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`).
  - Azure storage-style account keys (88-character base64 ending in `==`).
  - PEM private-key blocks (`-----BEGIN ... PRIVATE KEY----- ... -----END ...
    PRIVATE KEY-----`).
  - Credit-card / PAN numbers: 13–19 digit runs (optionally space- or
    hyphen-grouped) that pass the Luhn checksum. The checksum gate leaves ordinary
    long integers, IDs, and phone numbers untouched.

### Limitations — redaction is best-effort

Pattern-based redaction is a safety net, **not a guarantee**. It recognizes common,
well-known credential shapes; it can miss novel, proprietary, or unusually formatted
secrets, and it cannot understand the meaning of free-form prose. The server's rules
are fixed — unlike the SDK, it has no configuration to widen them — so treat it as
the second net behind SDK-side controls:

- For highly sensitive payloads, keep SDK capture **off**. The strongest guarantee
  is the data that is never sent to the server.
- Widen redaction at the source with the SDK's
  `configure(additional_secret_keys=[...], additional_redaction_patterns=[...])`.
- Review what your application actually sends before relying on redaction.

### Redaction contract with the SDK

The SDK and the server redact **independently**, and the two implementations are
pinned to identical behavior by a shared fixture:

- `tests/fixtures/redaction-cases.json` is kept **byte-for-byte identical** with the
  copy in the SDK repository (`bir-python`, the fixture's canonical source), and
  `apps/server/tests/test_redaction_parity.py` runs every case against the server's
  redactor.
- CI runs `python3 scripts/fixtures.py check`, which fails if any shared fixture no
  longer matches the committed `tests/fixtures/CHECKSUMS.sha256` manifest.
- When the SDK expands its redaction rules, the fixture change must land in this
  repository in lockstep (via `python3 scripts/fixtures.py sync`, committed in
  paired PRs) together with the matching server-side rule — the parity test and the
  checksum guard catch a drift in either repo.

See [tests/fixtures/README.md](tests/fixtures/README.md) for the full contract and
sync workflow.

## Read-only local data mode

With `BIR_DATA_DIR` set, the server browses SDK-written `.bir` artifacts
(`traces.jsonl`, `experiments/`) **strictly read-only**:

- The server never writes to, rewrites, or reorders SDK-owned files; only the SDK
  (e.g. `bir prune`) modifies them.
- Because the server does not own the data files, the write surface is disabled:
  `POST /v1/events`, `POST /v1/events/batch`, and `POST /v1/experiments` return
  `403`, and the Playground endpoints are disabled too.
- Rows are parsed through the same validated payload models on read, so served
  values still pass through the server's redaction in memory — on top of the
  redaction the SDK already applied when it captured them — while the files on disk
  stay untouched.

## Deployment posture

The server is a local development tool: it has no built-in authentication or TLS,
and CORS defaults to the local dashboard origins (`http://localhost:3000`,
`http://127.0.0.1:3000`). Anyone who can reach the port can read every stored trace
and, outside read-only mode, write events. Keep it bound to localhost or behind
infrastructure you control; do not expose it to untrusted networks.

## Supported versions

The product is run from this repository rather than consumed as a published package.
Security fixes land on `main`; run the latest `main` and update by pulling.

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue
for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository:

- **[Report a vulnerability](https://github.com/bir-ai/bir/security/advisories/new)**
  (the **Security** tab → **Report a vulnerability** on
  [bir-ai/bir](https://github.com/bir-ai/bir)).

Vulnerabilities in the SDK itself (capture, SDK-side redaction, the local trace
store) should go to the SDK repository's own private reporting instead:
[bir-ai/bir-python](https://github.com/bir-ai/bir-python/security/advisories/new).

Please include enough detail to reproduce the issue — the commit or version you ran,
a minimal example, and the impact you observed. We will acknowledge your report,
investigate, and coordinate a fix and disclosure timeline with you. We appreciate
responsible disclosure and will credit reporters who wish to be named.
