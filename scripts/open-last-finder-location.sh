#!/usr/bin/env bash
# Focus Finder when the current Space already has a Finder window; otherwise,
# open one there. New windows reuse the front Finder folder when available,
# falling back to the last saved folder or $HOME.

set -u

state_file="${XDG_STATE_HOME:-$HOME/.local/state}/finder-last-location"
mkdir -p "$(dirname "$state_file")"

finder_window_id="$(
  yabai -m query --windows --space 2>/dev/null |
    jq -r '.[] | select(.app == "Finder") | .id' 2>/dev/null |
    head -n 1
)"

if [[ -n "$finder_window_id" ]]; then
  yabai -m window "$finder_window_id" --focus
  exit 0
fi

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
  target_path="$current_path"
  printf '%s\n' "$target_path" > "$state_file"
else
  target_path=""
  if [[ -f "$state_file" ]]; then
    target_path="$(cat "$state_file" 2>/dev/null || true)"
  fi

  if [[ ! -d "$target_path" ]]; then
    target_path="$HOME"
  fi
fi

osascript - "$target_path" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  set targetFolder to (POSIX file (item 1 of argv) as alias)
  tell application "Finder"
    make new Finder window to targetFolder
  end tell
end run
APPLESCRIPT
