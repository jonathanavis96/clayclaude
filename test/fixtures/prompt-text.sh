#!/bin/bash
# Fixture: a question over Claude's input box (closed by its bottom rule, a status row under it); records the line typed
# into the box.
RESULT="$1"
RULE='────────────────────────────────────────────────────────────────────────────────'
printf '%s\n' ' ● Should I also update the changelog, or leave it for the release PR?' '' "$RULE" '❯ ' "$RULE"
printf '  ? for shortcuts\033[2A\033[3G'
IFS= read -r line
printf '%s' "$line" > "$RESULT"
sleep 20
