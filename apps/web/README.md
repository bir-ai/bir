# Bir Web Dashboard

Minimal local dashboard for inspecting traces from the Bir FastAPI server.

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
