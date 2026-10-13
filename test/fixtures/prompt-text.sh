#!/bin/bash
# Fixture: a question followed by the input box; records the line typed into it.
RESULT="$1"
RULE='────────────────────────────────────────────────────────────────────────────────'
printf '%s\n' ' ● Should I also update the changelog, or leave it for the release PR?' '' "$RULE"
printf '❯ '
IFS= read -r line
printf '\n%s\n' "$RULE"
printf '%s' "$line" > "$RESULT"
sleep 20
