#!/bin/bash
# Fixture: a permission prompt whose pending tool's bullet blinks, as Claude Code 2.1.296 draws it while it waits:
# column 0 of row $3 alternates between "●" and a space every $4 seconds (fixtures/panes/real-2.1.296/perm-bash.txt and
# perm-bash-manual.txt are the two states). Draws pane fixture $2 with bracketed paste on, then logs every byte that
# reaches the pane to $1, one per line (ESC for Escape, ENTER for Enter). Nothing a key does changes the screen.
LOG="$1"; ROW="$3"; PERIOD="${4:-0.05}"
printf '\033[?2004h%s' "$(cat "$2")"
: > "$LOG"
( on=1
  while :; do
    if [ "$on" = 1 ]; then g='●'; on=0; else g=' '; on=1; fi
    printf '\0337\033[%d;1H%s\0338' "$ROW" "$g"
    sleep "$PERIOD"
  done ) &
while IFS= read -r -s -n1 -d '' k; do
  case "$k" in $'\e') k=ESC;; $'\n'|$'\r') k=ENTER;; esac
  printf '%s\n' "$k" >> "$LOG"
done
