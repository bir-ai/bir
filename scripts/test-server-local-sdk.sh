#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT_DIR/.venv/bin/python"
DEFAULT_SDK_DIR="$ROOT_DIR/../bir-python"

resolve_path() {
  local candidate="$1"

  if [[ -d "$candidate" ]]; then
    cd "$candidate"
    pwd
    return 0
  fi

  if [[ "$candidate" != /* && -d "$ROOT_DIR/$candidate" ]]; then
    cd "$ROOT_DIR/$candidate"
    pwd
    return 0
  fi

  return 1
}

if [[ ! -x "$PYTHON" ]]; then
  echo "Server virtualenv is missing. Run from the repo root:" >&2
  echo "  python3 -m venv .venv" >&2
  echo "  cd apps/server" >&2
  echo "  ../../.venv/bin/python -m pip install -e \".[dev]\"" >&2
  exit 1
fi

if ! "$PYTHON" -c 'import fastapi, httpx, pytest' >/dev/null 2>&1; then
  echo "Server test dependencies are missing. Run from the repo root:" >&2
  echo "  python3 -m venv .venv" >&2
  echo "  cd apps/server" >&2
  echo "  ../../.venv/bin/python -m pip install -e \".[dev]\"" >&2
  exit 1
fi

if [[ -n "${BIR_SDK_PATH:-}" ]]; then
  SDK_ROOT_CANDIDATE="$BIR_SDK_PATH"
elif [[ -d "$DEFAULT_SDK_DIR" ]]; then
  SDK_ROOT_CANDIDATE="$DEFAULT_SDK_DIR"
else
  echo "Local bir-python checkout not found." >&2
  echo "Set BIR_SDK_PATH=/path/to/bir-python, or run the normal PyPI-backed server tests:" >&2
  echo "  cd apps/server" >&2
  echo "  ../../.venv/bin/python -m pytest" >&2
  exit 1
fi

if ! SDK_ROOT="$(resolve_path "$SDK_ROOT_CANDIDATE")"; then
  echo "BIR_SDK_PATH does not point to a readable checkout: $SDK_ROOT_CANDIDATE" >&2
  exit 1
fi

SDK_SRC="$SDK_ROOT/src"
if [[ ! -f "$SDK_ROOT/pyproject.toml" || ! -f "$SDK_SRC/bir/__init__.py" ]]; then
  echo "Expected a bir-python checkout with pyproject.toml and src/bir/__init__.py:" >&2
  echo "  $SDK_ROOT" >&2
  exit 1
fi

SERVER_DIR="$ROOT_DIR/apps/server"
export BIR_SDK_SRC="$SDK_SRC"
export PYTHONPATH="$SDK_SRC:$SERVER_DIR${PYTHONPATH:+:$PYTHONPATH}"

"$PYTHON" - <<'PY'
from __future__ import annotations

import os
import sys
from pathlib import Path

import bir

sdk_src = Path(os.environ["BIR_SDK_SRC"]).resolve()
bir_file = Path(bir.__file__).resolve()
try:
    bir_file.relative_to(sdk_src)
except ValueError:
    print(
        f"Expected to import bir from {sdk_src}, but imported {bir_file}",
        file=sys.stderr,
    )
    sys.exit(1)

print(f"Using local bir SDK source: {bir_file}")
PY

cd "$SERVER_DIR"
exec "$PYTHON" -m pytest "$@"
