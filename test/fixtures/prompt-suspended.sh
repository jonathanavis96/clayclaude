#!/bin/bash
# Fixture: draws Claude's input box, records its pid, then suspends itself as Ctrl-Z would. The interactive shell
# that started it takes the terminal back and shows its own prompt under the box.
echo $$ > "$1"
RULE='────────────────────────────────────────────────────────────────────────────────'
printf '%s\n' ' ● Should I also update the changelog, or leave it for the release PR?' '' "$RULE" '❯ ' "$RULE" '  ? for shortcuts'
kill -TSTP $$
