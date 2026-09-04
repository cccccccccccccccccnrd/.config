#!/usr/bin/env bash
# Focus Finder when the current Space already has a Finder window; otherwise,
# open one there. New windows reuse the front Finder folder when available,
# falling back to the last saved folder or $HOME.

set -u

state_file="${XDG_STATE_HOME:-$HOME/.local/state}/finder-last-location"
mkdir -p "$(dirname "$state_file")"

mouse_display=""
finder_bounds=""

if command -v yabai >/dev/null 2>&1; then
  mouse_display_json="$(yabai -m query --displays --display mouse 2>/dev/null || true)"
  if [[ -n "$mouse_display_json" ]] && command -v jq >/dev/null 2>&1; then
    mouse_display="$(printf '%s' "$mouse_display_json" | jq -r '.index // empty' 2>/dev/null || true)"
    finder_bounds="$(printf '%s' "$mouse_display_json" | jq -r '
      .frame as $f
      | (if ($f.w - 160) < 1200 then ($f.w - 160) else 1200 end) as $ww
      | (if ($f.h - 160) < 800 then ($f.h - 160) else 800 end) as $hh
      | [
          ($f.x + (($f.w - $ww) / 2) | floor),
          ($f.y + (($f.h - $hh) / 2) | floor),
          ($f.x + (($f.w + $ww) / 2) | floor),
          ($f.y + (($f.h + $hh) / 2) | floor)
        ]
      | @tsv
    ' 2>/dev/null || true)"
  fi

  yabai -m display --focus mouse >/dev/null 2>&1 || true
fi

finder_window_id="$(
  if [[ -n "$mouse_display" ]]; then
    yabai -m query --windows --display "$mouse_display" 2>/dev/null
  else
    yabai -m query --windows --space 2>/dev/null
  fi |
    jq -r '.[] | select(.app == "Finder" and ."is-visible") | .id' 2>/dev/null |
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

read -r left top right bottom <<< "$finder_bounds"

osascript - "$target_path" "${left:-}" "${top:-}" "${right:-}" "${bottom:-}" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  set targetFolder to (POSIX file (item 1 of argv) as alias)
  set hasBounds to ((count of argv) is 5 and item 2 of argv is not "")

  tell application "Finder"
    set finderWindow to make new Finder window to targetFolder
    if hasBounds then
      set bounds of finderWindow to {(item 2 of argv as integer), (item 3 of argv as integer), (item 4 of argv as integer), (item 5 of argv as integer)}
    end if
    activate
  end tell
end run
APPLESCRIPT
