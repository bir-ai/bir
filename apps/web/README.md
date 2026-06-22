# Bir Web Dashboard

Minimal local dashboard for inspecting traces and experiments from the Bir
FastAPI server.

Development and CI use Node.js 22. The Python SDK is an external published
package; this dashboard consumes server responses and contains no SDK source.

Current views:

- trace list with event counts, latency, status, and generation totals
- trace detail timeline with spans, generations, retrieval tool calls, scores,
  usage, cost, errors, metadata, input, and output when captured
- trace triage with an errors-only shortcut, recent/slowest ordering, and a
  minimum-duration filter; these controls combine with the other trace filters
- selected trace details fetched from `GET /v1/traces/{trace_id}`
- faithfulness and RAG-quality scores grouped separately from other scores
- experiment list with aggregate scores and error counts
- experiment detail with per-example input, expected output, actual output,
  scores, linked trace IDs, latency, and errors
- experiment comparison for two uploaded runs with aggregate score deltas and
  per-example regression status
- Playground for observed local prompt experiments through the Bir server, with
  model selection, token/latency badges, and trace links
- Playground workflow controls: optional context (recorded as a
  `playground.prepare_context` span and, when "Use context as retrieval" is on,
  a retrieval tool call), an expected answer, and a "Run basic evaluators"
  toggle that records `answered`, `length_ok`, and `contains_expected` scores
  on the resulting trace; pass/fail score chips appear directly under the
  assistant reply next to the token and latency badges
- dataset export: the "Export dataset" button above the conversation downloads
  the session's turns as JSONL rows (`{id, input, expected, metadata}`) that
  load directly with `bir.evals.Dataset.from_jsonl` for `run_experiment`;
  reconstructed history sessions can be exported too, recovering the expected
  answer from recorded `contains_expected` scores

## Development

```bash
npm install
npm run dev
```

The dashboard calls the Bir FastAPI server straight from the browser; there
are no Next.js API proxy routes. The API base URL resolves in this order:

1. `NEXT_PUBLIC_BIR_API_BASE_URL`, baked in at build/dev time when set
2. the page origin, so a static export served by the Bir server itself needs
   no configuration
3. `http://127.0.0.1:8000` as the fallback outside the browser

`npm run dev` pins the base URL to `http://127.0.0.1:8000` so the dev server
keeps talking to a separately running API. Override it the same way as before:

```bash
NEXT_PUBLIC_BIR_API_BASE_URL=http://127.0.0.1:9000 npm run dev
```

The server allows the dashboard's local origins (`http://localhost:3000` and
`http://127.0.0.1:3000`) through CORS by default; if the dashboard runs on
another origin, set `BIR_CORS_ORIGINS` on the server side as well.

The Playground tab uses the same direct browser-to-server API calls. It is
enabled when `/v1/playground/status` reports writable server mode and a reachable
model server. In read-only `BIR_DATA_DIR` mode the tab shows the server's
disabled state instead of sending chat requests.
Failed Playground model calls still return HTTP 502 to the tab, and the server
records them as ordinary error traces. They are available in the trace dashboard
through the existing **Errors only** triage filter and trace detail timeline.

Useful checks:

```bash
npm run test
npm run lint
npm run typecheck
```

## Static export

`npm run build` produces a fully static dashboard in `out/` (`output: "export"`
in `next.config.ts`); there is no `next start` server. Serve the directory with
any static file server:

```bash
npm run build
python3 -m http.server 4173 -d out
```

When the static files are served from a different origin than the API, build
with `NEXT_PUBLIC_BIR_API_BASE_URL` pointing at the API and allow that origin
via `BIR_CORS_ORIGINS` on the server. When the Bir server serves the export
itself, the dashboard uses the page origin and needs neither.
