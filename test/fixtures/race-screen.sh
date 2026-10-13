#!/bin/bash
# Fixture for the answer race: draws pane fixture $2 and turns on bracketed paste, as Claude Code does. When the file $3
# appears (a test touches it at a chosen moment: the model's next tool call reaching Claude), the screen is replaced by
# fixture $4. Every byte that reaches the pane is logged to $1 as <screen>:<key>, one per line: B for the first screen,
# P for the second, ESC for Escape, ENTER for Enter. Keys are read without a timeout (a timed-out read can drop a byte).
# With $5 (a row number), that row is redrawn every 50 ms as Claude's spinner while it works ("✶ Effecting… (3s · ↓ 210
# tokens · thinking)", a new glyph and count each frame) until the second screen is drawn.
# On the first screen, Down (ESC[B) moves the cursor of an unnumbered startup dialog, as Claude redraws it (cursor-down.awk).
LOG="$1"; FLAG="$3"; ANIM="${5:-}"
screen="$(cat "$2")"; seq=''
printf '\033[?2004h%s' "$screen"
: > "$LOG"
if [ -n "$ANIM" ]; then
  ( g=('✻' '✶' '✳' '✢' '✽' '·'); n=0
    while [ ! -e "$FLAG" ]; do
      n=$((n+1)); printf '\0337\033[%d;1H\033[2K%s Effecting… (%ds · ↓ %d tokens · thinking)\0338' "$ANIM" "${g[n%6]}" $((n/20)) $((n*7))
      sleep 0.05
    done
    : > "$FLAG.still" ) &
fi
( while [ ! -e "$FLAG" ]; do sleep 0.01; done
  if [ -n "$ANIM" ]; then while [ ! -e "$FLAG.still" ]; do sleep 0.01; done; fi
  printf '\033[H\033[2J%s' "$(cat "$4")"; : > "$FLAG.drawn" ) &
while IFS= read -r -s -n1 -d '' k; do
  mode=B; [ -e "$FLAG.drawn" ] && mode=P
  case "$k" in $'\e') k=ESC;; $'\n'|$'\r') k=ENTER;; esac
  printf '%s:%s\n' "$mode" "$k" >> "$LOG"
  seq="$seq$k"
  if [ "$mode" = B ] && [ "$k" = B ] && [ "${seq%ESC[B}" != "$seq" ]; then
    screen="$(printf '%s\n' "$screen" | LC_ALL=C awk -f "$(dirname "$0")/cursor-down.awk")"
    printf '\033[H\033[2J%s' "$screen"
  fi
done
