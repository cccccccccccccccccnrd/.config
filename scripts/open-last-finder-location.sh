#!/usr/bin/env bash
# Bring Finder forward. If Finder has no open window, reopen the last
# Finder folder this script saw; otherwise fall back to $HOME.

set -u

state_file="${XDG_STATE_HOME:-$HOME/.local/state}/finder-last-location"
mkdir -p "$(dirname "$state_file")"

current_path="$(osascript <<'APPLESCRIPT' 2>/dev/null
try
  tell application "Finder"
    if (count of Finder windows) > 0 then
      return POSIX path of (target of front Finder window as alias)
    end if
  end tell
end try
return ""
APPLESCRIPT
)"

if [[ -n "$current_path" && -d "$current_path" ]]; then
  printf '%s\n' "$current_path" > "$state_file"
  osascript -e 'tell application "Finder" to activate' >/dev/null 2>&1
  exit 0
fi

last_path=""
if [[ -f "$state_file" ]]; then
  last_path="$(cat "$state_file" 2>/dev/null || true)"
fi

if [[ -n "$last_path" && -d "$last_path" ]]; then
  open "$last_path"
else
  open "$HOME"
fi
