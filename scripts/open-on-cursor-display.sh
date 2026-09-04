#!/usr/bin/env bash
set -euo pipefail

if command -v yabai >/dev/null 2>&1; then
  yabai -m display --focus mouse >/dev/null 2>&1 || true
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

exec "$@"
