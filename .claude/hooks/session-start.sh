#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH" >&2
  exit 1
fi

npm install --no-audit --no-fund
