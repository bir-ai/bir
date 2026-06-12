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
- experiment comparison for two uploaded runs with aggregate score deltas and
  per-example regression status

## Development

```bash
npm install
npm run dev
```

The dashboard calls the Bir FastAPI server straight from the browser; there
are no Next.js API proxy routes. By default it reads from
`http://127.0.0.1:8000`. Override the backend URL at build/dev time with:

```bash
NEXT_PUBLIC_BIR_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

The server allows the dashboard's local origins (`http://localhost:3000` and
`http://127.0.0.1:3000`) through CORS by default; if the dashboard runs on
another origin, set `BIR_CORS_ORIGINS` on the server side as well.

Useful checks:

```bash
npm run test
npm run lint
npm run typecheck
```
