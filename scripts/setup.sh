#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! "$ROOT_DIR/.venv/bin/python" -c 'import sys' >/dev/null 2>&1; then
  if [[ -d "$ROOT_DIR/.venv" ]]; then
    python3 -m venv --clear "$ROOT_DIR/.venv"
  else
    python3 -m venv "$ROOT_DIR/.venv"
  fi
fi

"$ROOT_DIR/.venv/bin/python" -m pip install -e "$ROOT_DIR/apps/server"
npm --prefix "$ROOT_DIR/apps/web" install

echo "Setup complete. Run ./scripts/dev.sh"
