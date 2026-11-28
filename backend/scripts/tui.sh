#!/usr/bin/env bash
# Launch the reactive Etymos Server TUI Dashboard.
# Default (on server): Local Server Mode with always-on host/GPU/supervisor + loopback API live stream.
# Remote (from dev workstation): pass `--remote https://api.etymos.site [--login]`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  PY="$BACKEND_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"
else
  echo "Error: Python interpreter not found (expected $BACKEND_DIR/.venv/bin/python or python3)." >&2
  exit 1
fi

export PYTHONPATH="$BACKEND_DIR${PYTHONPATH:+:$PYTHONPATH}"
exec "$PY" -m tui "$@"
