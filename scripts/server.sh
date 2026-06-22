#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT_DIR/.venv/bin/python"

if ! "$PYTHON" -c 'import uvicorn' >/dev/null 2>&1; then
  echo "Server dependencies are missing. Run ./scripts/setup.sh first." >&2
  exit 1
fi

cd "$ROOT_DIR/apps/server"
exec "$PYTHON" -m uvicorn app.main:app --reload "$@"
