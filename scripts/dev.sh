#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! "$ROOT_DIR/.venv/bin/python" -c 'import uvicorn' >/dev/null 2>&1 || [[ ! -d "$ROOT_DIR/apps/web/node_modules" ]]; then
  echo "Dependencies are missing. Run ./scripts/setup.sh first." >&2
  exit 1
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

"$ROOT_DIR/scripts/server.sh" &
SERVER_PID=$!

cd "$ROOT_DIR/apps/web"
npm run dev
