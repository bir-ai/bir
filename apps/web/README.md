# Bir Web Dashboard

Minimal local dashboard for inspecting traces and experiments from the Bir
FastAPI server.

Current views:

- trace list with event counts, latency, status, and generation totals
- trace detail timeline with spans, generations, retrieval tool calls, scores,
  usage, cost, errors, metadata, input, and output when captured
- experiment list with aggregate scores and error counts
- experiment detail with per-example input, expected output, actual output,
  scores, linked trace IDs, latency, and errors

## Development

```bash
npm install
npm run dev
```

By default the dashboard reads traces from `http://127.0.0.1:8000`.
Override the backend URL with:

```bash
BIR_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

Useful checks:

```bash
npm run lint
npm run typecheck
```
