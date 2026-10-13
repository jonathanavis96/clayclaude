#!/bin/bash
# Fixture: draws Claude Code's folder-trust question (panes/trust-folder.txt, captured from 2.1.296), then records
# the keys it gets until Enter: an arrow key as ESC[B / ESC[A, Enter as ENTER. Down moves the cursor, as Claude redraws
# it (cursor-down.awk).
RESULT="$1"
screen="$(cat "$(dirname "$0")/panes/trust-folder.txt")"
printf '%s' "$screen"
keys=''
while IFS= read -r -s -n1 -d '' k; do
  case "$k" in $'\e') keys+='ESC';; $'\n'|$'\r') keys+='ENTER'; break;; *) keys+="$k";; esac
  if [ "$k" = B ] && [ "${keys%ESC[B}" != "$keys" ]; then
    screen="$(printf '%s\n' "$screen" | LC_ALL=C awk -f "$(dirname "$0")/cursor-down.awk")"
    printf '\033[H\033[2J%s' "$screen"
  fi
done
printf '%s' "$keys" > "$RESULT"
sleep 20
