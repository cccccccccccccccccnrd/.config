#!/usr/bin/env bash
# Toggle terminal/UI theme between "min" and "max".
# Updates live config files and, when present, the dotfiles repo copy.

set -euo pipefail

repo="${DOTFILES_REPO:-$HOME/dev/proj/.config}"

current=""
if [[ -f "$HOME/.config/ghostty/config" ]]; then
  current="$(awk -F= '/^[[:space:]]*theme[[:space:]]*=/{gsub(/[[:space:]]/, "", $2); print $2; exit}' "$HOME/.config/ghostty/config")"
fi
if [[ -z "$current" && -f "$HOME/.pi/agent/settings.json" ]]; then
  current="$(python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.pi/agent/settings.json')
try:
    print(json.load(open(p)).get('theme', ''))
except Exception:
    print('')
PY
)"
fi

case "$current" in
  max) next="min" ;;
  min|cnrd|"") next="max" ;;
  *) next="max" ;;
esac

python3 - "$next" "$repo" <<'PY'
import json
import sys
from pathlib import Path

next_theme = sys.argv[1]
repo = Path(sys.argv[2]).expanduser()
home = Path.home()

def replace_in_file(path: Path, replacements):
    if not path.exists():
        return
    text = path.read_text()
    for old, new in replacements:
        text = text.replace(old, new)
    path.write_text(text)

# Ghostty active theme.
for p in [home / '.config/ghostty/config', repo / 'ghostty/config']:
    replace_in_file(p, [
        ('theme = min', f'theme = {next_theme}'),
        ('theme = max', f'theme = {next_theme}'),
        ('theme = cnrd', f'theme = {next_theme}'),
    ])

# Pi active theme.
for p in [home / '.pi/agent/settings.json', repo / '.pi/agent/settings.json']:
    if p.exists():
        data = json.loads(p.read_text())
        data['theme'] = next_theme
        p.write_text(json.dumps(data, indent=2) + '\n')

# zsh prompt theme.
for p in [home / '.zshrc', home / '.config/.zshrc', repo / '.zshrc']:
    replace_in_file(p, [
        ('ZSH_THEME="min"', f'ZSH_THEME="{next_theme}"'),
        ('ZSH_THEME="max"', f'ZSH_THEME="{next_theme}"'),
        ('ZSH_THEME="cnrd"', f'ZSH_THEME="{next_theme}"'),
    ])

# tmux active theme.
for p in [home / '.tmux.conf', home / '.config/tmux/tmux.conf', repo / 'tmux/tmux.conf']:
    replace_in_file(p, [
        ('themes/min.conf', f'themes/{next_theme}.conf'),
        ('themes/max.conf', f'themes/{next_theme}.conf'),
        ('themes/cnrd.conf', f'themes/{next_theme}.conf'),
    ])
PY

if command -v tmux >/dev/null 2>&1 && tmux info >/dev/null 2>&1; then
  tmux source-file "$HOME/.tmux.conf"
fi

printf 'theme -> %s\n' "$next"
printf 'Reload Ghostty/Pi or open a new shell for all changes to show.\n'
