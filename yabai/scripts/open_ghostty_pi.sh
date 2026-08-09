#!/usr/bin/env bash
set -euo pipefail

# Open Ghostty normally, then type `pi` into the shell.
# This avoids Ghostty's macOS security confirmation for launch-time command execution.
open -na "Ghostty"

osascript <<'APPLESCRIPT'
delay 0.7
tell application "Ghostty" to activate
delay 0.2
tell application "System Events"
  keystroke "pi"
  key code 36
end tell
APPLESCRIPT
