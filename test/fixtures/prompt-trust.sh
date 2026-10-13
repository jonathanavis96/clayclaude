#!/bin/bash
# Fixture: draws Claude Code's folder-trust question (panes/trust-folder.txt, captured from 2.1.296), then records
# the keys it gets until Enter: an arrow key as ESC[B / ESC[A, Enter as ENTER.
RESULT="$1"
printf '%s' "$(cat "$(dirname "$0")/panes/trust-folder.txt")"
keys=''
while IFS= read -r -s -n1 -d '' k; do
  case "$k" in $'\e') keys+='ESC';; $'\n'|$'\r') keys+='ENTER'; break;; *) keys+="$k";; esac
done
printf '%s' "$keys" > "$RESULT"
sleep 20
