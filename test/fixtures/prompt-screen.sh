#!/bin/bash
# Fixture: draws a pane fixture ($2, a file under panes/), then records every key that reaches it: ESC for Escape (an
# arrow key arrives as ESC[B / ESC[A), ENTER for Enter, any other byte as itself. Writes them to $1 once no key has come
# for 2 s (a reply's Enter follows its paste in a second script, which a loaded machine can delay past 1 s). With $3, the screen is replaced by that fixture as soon as the first key arrives (a prompt that appears
# while a reply is being typed). Bracketed paste is on, as Claude Code turns it on, so a pasted reply arrives as
# ESC[200~<text>ESC[201~.
# Down (ESC[B) moves the cursor of an unnumbered startup dialog, as Claude redraws it (cursor-down.awk).
RESULT="$1"
screen="$(cat "$2")"
printf '\033[?2004h%s' "$screen"
keys=''
IFS= read -r -s -n1 -d '' k || exit 0
[ -n "${3:-}" ] && { screen="$(cat "$3")"; printf '\033[H\033[2J%s' "$screen"; }
while :; do
  case "$k" in $'\e') keys+='ESC';; $'\n'|$'\r') keys+='ENTER';; *) keys+="$k";; esac
  if [ "$k" = B ] && [ "${keys%ESC[B}" != "$keys" ]; then
    screen="$(printf '%s\n' "$screen" | LC_ALL=C awk -f "$(dirname "$0")/cursor-down.awk")"
    printf '\033[H\033[2J%s' "$screen"
  fi
  IFS= read -r -s -n1 -d '' -t 2 k || break
done
printf '%s' "$keys" > "$RESULT"
sleep 20
