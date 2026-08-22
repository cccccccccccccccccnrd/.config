#!/usr/bin/env bash
# Single Alt+L focuses south in yabai.
# Double-tap Alt+L quickly to type @ (German keyboard fallback).

set -u

state_file="${TMPDIR:-/tmp}/skhd-alt-l-last"
threshold_ms=350
threshold_s="0.35"

now_ms() {
  /usr/bin/python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

now="$(now_ms)"

if [[ -f "$state_file" ]]; then
  last="$(cat "$state_file" 2>/dev/null || true)"
  if [[ "$last" =~ ^[0-9]+$ ]] && (( now - last <= threshold_ms )); then
    rm -f "$state_file"
    skhd -t '@'
    exit 0
  fi
fi

printf '%s\n' "$now" > "$state_file"
sleep "$threshold_s"

current="$(cat "$state_file" 2>/dev/null || true)"
if [[ "$current" == "$now" ]]; then
  rm -f "$state_file"
  yabai -m window --focus south
fi
