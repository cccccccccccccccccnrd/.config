#!/usr/bin/env bash
set -euo pipefail

# Apply a random Ghostty theme to only the focused Ghostty terminal surface.
# This does NOT edit ~/.config/ghostty/config. It writes OSC color sequences to
# the focused terminal's tty, so other Ghostty windows keep their colors.

GHOSTTY_BIN="${GHOSTTY_BIN:-/Applications/Ghostty.app/Contents/MacOS/ghostty}"
GHOSTTY_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ghostty"
GHOSTTY_CUSTOM_THEMES_DIR="$GHOSTTY_CONFIG_DIR/themes"
GHOSTTY_RESOURCE_THEMES_DIR="/Applications/Ghostty.app/Contents/Resources/ghostty/themes"
DEFAULT_THEME="${GHOSTTY_FOCUSED_DEFAULT_THEME:-cnrd}"
STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ghostty-focused-random-theme"
STATE_FILE="$STATE_DIR/state.tsv"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--reset|--status|--set THEME]

No args      Apply a random Ghostty theme to the focused Ghostty terminal.
--reset      Apply the default theme ($DEFAULT_THEME) to the focused terminal.
--status     Print the last theme this script applied to the focused terminal.
--set THEME  Apply a specific available Ghostty theme to the focused terminal.
EOF
}

frontmost_is_ghostty() {
  local frontmost
  frontmost="$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null || true)"
  [[ "$frontmost" == "Ghostty" || "$frontmost" == "ghostty" ]]
}

focused_terminal_info() {
  osascript <<'OSA'
tell application "Ghostty"
  set term to focused terminal of selected tab of front window
  return (id of term) & linefeed & (working directory of term)
end tell
OSA
}

focused_tty_for_cwd() {
  local focused_cwd="$1"

  python3 - "$focused_cwd" <<'PY'
import os
import re
import subprocess
import sys

focused_cwd = os.path.realpath(sys.argv[1])

ps = subprocess.check_output(
    ["ps", "-axo", "pid=,ppid=,tty=,stat=,comm="],
    text=True,
    errors="replace",
)

rows = []
ghostty_pids = set()
for line in ps.splitlines():
    parts = line.strip().split(None, 4)
    if len(parts) < 5:
        continue
    pid, ppid, tty, stat, comm = parts
    try:
        pid_i = int(pid)
        ppid_i = int(ppid)
    except ValueError:
        continue
    base = os.path.basename(comm)
    rows.append((pid_i, ppid_i, tty, stat, base))
    if base in {"ghostty", "Ghostty"}:
        ghostty_pids.add(pid_i)

# Candidate ttys are those that belong to login/shell processes launched by a
# Ghostty process. This avoids matching unrelated Terminal.app/iTerm ttys.
ghostty_ttys = {
    tty for _pid, ppid, tty, _stat, _base in rows
    if tty.startswith("ttys") and ppid in ghostty_pids
}

# Prefer the foreground process on each Ghostty tty. macOS marks foreground
# process groups with '+' in STAT.
matches = []
for pid, _ppid, tty, stat, _base in rows:
    if tty not in ghostty_ttys or "+" not in stat:
        continue
    try:
        out = subprocess.check_output(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            stderr=subprocess.DEVNULL,
            text=True,
            errors="replace",
        )
    except subprocess.CalledProcessError:
        continue
    cwd = None
    for l in out.splitlines():
        if l.startswith("n"):
            cwd = os.path.realpath(l[1:])
            break
    if cwd == focused_cwd:
        matches.append((tty, pid))

if len(matches) == 1:
    print(matches[0][0])
    sys.exit(0)

# Fallback: if there is exactly one Ghostty tty, use it.
if len(ghostty_ttys) == 1:
    print(next(iter(ghostty_ttys)))
    sys.exit(0)

if not matches:
    print("Could not identify focused Ghostty tty.", file=sys.stderr)
else:
    print("Focused Ghostty tty is ambiguous: " + ", ".join(t for t, _ in matches), file=sys.stderr)
sys.exit(1)
PY
}

list_themes() {
  "$GHOSTTY_BIN" +list-themes \
    | sed -E 's/ \([^()]*\)$//' \
    | awk 'NF && !seen[$0]++'
}

theme_path() {
  local theme="$1"
  if [[ -f "$GHOSTTY_CUSTOM_THEMES_DIR/$theme" ]]; then
    printf '%s\n' "$GHOSTTY_CUSTOM_THEMES_DIR/$theme"
  elif [[ -f "$GHOSTTY_RESOURCE_THEMES_DIR/$theme" ]]; then
    printf '%s\n' "$GHOSTTY_RESOURCE_THEMES_DIR/$theme"
  else
    return 1
  fi
}

random_theme() {
  list_themes | python3 -c 'import random, sys
exclude = sys.argv[1]
themes = [line.strip() for line in sys.stdin if line.strip() and line.strip() != exclude]
if not themes:
    raise SystemExit(1)
print(random.choice(themes))
' "$DEFAULT_THEME"
}

build_osc() {
  local theme_file="$1"

  python3 - "$theme_file" <<'PY'
import re
import sys

path = sys.argv[1]
colors = {}
palette = {}

hex_re = re.compile(r"#[0-9a-fA-F]{6}\b")
kv_re = re.compile(r"^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$")
palette_re = re.compile(r"^\s*palette\s*=\s*(\d+)\s*=\s*(#[0-9a-fA-F]{6})\b")

with open(path, "r", encoding="utf-8") as f:
    for raw in f:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        pm = palette_re.match(raw)
        if pm:
            palette[int(pm.group(1))] = pm.group(2).lower()
            continue
        m = kv_re.match(raw)
        if not m:
            continue
        key, value = m.groups()
        hm = hex_re.search(value)
        if hm:
            colors[key] = hm.group(0).lower()

required = ["background", "foreground"]
missing = [k for k in required if k not in colors]
if missing:
    raise SystemExit(f"Theme is missing parseable color(s): {', '.join(missing)}")

cursor = colors.get("cursor-color", colors["foreground"])

esc = "\x1b"
st = esc + "\\"
seq = []

# Dynamic colors: foreground, background, cursor.
seq.append(f"{esc}]10;{colors['foreground']};11;{colors['background']};12;{cursor}{st}")

# ANSI palette 0-15.
parts = []
for i in range(16):
    if i in palette:
        parts.extend([str(i), palette[i]])
if parts:
    seq.append(f"{esc}]4;" + ";".join(parts) + st)

sys.stdout.buffer.write("".join(seq).encode())
PY
}

apply_theme_to_tty() {
  local theme="$1" tty="$2" path seq
  path="$(theme_path "$theme")" || {
    echo "Theme not found: $theme" >&2
    exit 1
  }

  seq="$(build_osc "$path")"
  printf '%s' "$seq" > "/dev/$tty"
}

remember_theme() {
  local term_id="$1" tty="$2" theme="$3"
  mkdir -p "$STATE_DIR"
  python3 - "$STATE_FILE" "$term_id" "$tty" "$theme" <<'PY'
import os
import sys

state_path, term_id, tty, theme = sys.argv[1:5]
rows = []
if os.path.exists(state_path):
    with open(state_path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) == 3 and parts[0] != term_id:
                rows.append(parts)
rows.append([term_id, tty, theme])
with open(state_path, "w", encoding="utf-8") as f:
    for row in rows:
        f.write("\t".join(row) + "\n")
PY
}

last_theme() {
  local term_id="$1"
  awk -F '\t' -v id="$term_id" '$1 == id { print $3; found = 1 } END { exit found ? 0 : 1 }' "$STATE_FILE" 2>/dev/null || true
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  if ! frontmost_is_ghostty; then
    echo "Ghostty is not the focused application; refusing to change a background window." >&2
    exit 1
  fi

  local info term_id focused_cwd tty theme
  info="$(focused_terminal_info)"
  term_id="$(printf '%s\n' "$info" | sed -n '1p')"
  focused_cwd="$(printf '%s\n' "$info" | sed -n '2p')"
  tty="$(focused_tty_for_cwd "$focused_cwd")"

  case "${1:-}" in
    "")
      theme="$(random_theme)"
      ;;
    --reset)
      theme="$DEFAULT_THEME"
      ;;
    --status)
      last_theme "$term_id"
      exit 0
      ;;
    --set)
      if [[ -z "${2:-}" ]]; then
        echo "--set requires a theme name." >&2
        exit 2
      fi
      theme="$2"
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac

  apply_theme_to_tty "$theme" "$tty"
  remember_theme "$term_id" "$tty" "$theme"
  printf 'Focused Ghostty theme: %s\n' "$theme"
}

main "$@"
