#!/bin/bash
# Fixture: draws a permission prompt in Claude Code's layout, waits for one key, records it.
RESULT="$1"
printf '%s\n' ' Bash command' '' '   npm test' '   Run the unit tests' '' ' Do you want to proceed?' \
  ' ❯ 1. Yes' "   2. Yes, and don't ask again for npm test commands in /home/demo/orchard-api" '   3. No, and tell Claude what to do differently (esc)'
IFS= read -r -n1 k
printf '%s' "$k" > "$RESULT"
sleep 20
