#!/bin/bash
# Fixture (Task 42): a stub of Claude Code's idle input box. Draws a pane fixture ($2, a file under panes/) with
# bracketed paste on, as Claude Code turns it on, then records every key that reaches it exactly as prompt-screen.sh
# does (ESC for Escape, ENTER for Enter, any other byte as itself) and writes them to $1 once no key has come for 2 s.
# Like Claude, it draws a bracketed paste as the draft in its input box: the box's empty "❯" line (real 2.1.296 draws it
# "❯", a no-break space, a space) becomes "❯ <text>".
# With $3, the screen after a paste is that fixture instead (a menu Claude draws as text arrives, such as its
# slash-command suggestions).
RESULT="$1"
screen="$(cat "$2")"
printf '\033[?2004h%s' "$screen"
keys=''
IFS= read -r -s -n1 -d '' k || exit 0
while :; do
  case "$k" in $'\e') keys+='ESC';; $'\n'|$'\r') keys+='ENTER';; *) keys+="$k";; esac
  if [ "${keys%ESC\[201~}" != "$keys" ]; then
    body="${keys%ESC\[201~}"; text="${body##*ESC\[200~}"
    if [ -n "${3:-}" ]; then screen="$(cat "$3")"
    else
      out=''; nbsp=$'\xc2\xa0'
      while IFS= read -r l; do
        rest="${l#❯}"; rest="${rest//$nbsp/}"; rest="${rest// /}"
        if [ "${l#❯}" != "$l" ] && [ -z "$rest" ]; then l="❯ $text"; fi
        out+="$l"$'\n'
      done <<< "$screen"
      screen="${out%$'\n'}"
    fi
    printf '\033[H\033[2J%s' "$screen"
  fi
  IFS= read -r -s -n1 -d '' -t 2 k || break
done
printf '%s' "$keys" > "$RESULT"
sleep 20
