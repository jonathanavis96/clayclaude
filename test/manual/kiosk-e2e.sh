#!/usr/bin/env bash
# Kiosk end to end against the live daemon (port 8420) on the real tablet (P3 Task 27).
#
#   tools/tablet.sh run-locked test/manual/kiosk-e2e.sh <tag> [replug|screen-off] [log]
#
# replug (default): three `adb reconnect`s, then Home and one more reconnect. screen-off: KEYCODE_SLEEP, then a
# reconnect (on a tablet with a PIN this leaves the lock screen up: run it last). After each reconnect it waits up
# to 25 s for the daemon's "kiosk on" log line, prints how long that took, and screenshots the tablet to
# $CLAYCLAUDE_QA_DIR/plan3/kiosk-e2e-<tag>-*.png (default: qa/ in the repo, git-ignored). Only the reverse tcp:8420 may exist when it starts (a reconnect drops
# every reverse, including other agents'; one with no local listener is treated as a leftover).
set -u
here="$(cd "$(dirname "$0")/../.." && pwd)"
T="$here/tools/tablet.sh"; qa="${CLAYCLAUDE_QA_DIR:-$here/qa}/plan3"
tag="${1:?usage: kiosk-e2e.sh <tag> [replug|screen-off] [log]}"; mode="${2:-replug}"
log="${3:-${TMPDIR:-/tmp}/clayclaude-serve.log}"
mkdir -p "$qa"

# Another reverse whose port has a local listener means another agent is testing: refuse. One with no listener is a
# leftover (printed, then dropped by the first reconnect).
for p in $("$T" reverse-list | tr -d '\r' | grep -oE 'tcp:[0-9]+' | cut -d: -f2 | sort -u); do
  [ "$p" = 8420 ] && continue
  if ss -ltnH "sport = :$p" | grep -q .; then echo "kiosk-e2e: reverse tcp:$p is in use (another agent is testing); not starting"; exit 3; fi
  echo "kiosk-e2e: leftover reverse tcp:$p (nothing listens on it)"
done

state() {   # focus, lock screen and whether the system bars are showing
  "$T" shell dumpsys window | tr -d '\r' | grep -E 'mCurrentFocus|isKeyguardShowing' | sed 's/^ */  /'
  "$T" shell dumpsys window | tr -d '\r' | grep -m2 -oE 'type=(statusBars|navigationBars) frame=\S+ visible=(true|false)' | sed 's/^/  bars: /' || true
}

# Wait for the next "kiosk on" line after line $1 of the log; print it and the seconds it took.
await_launch() {
  local from="$1" t0="$SECONDS" line=""
  while [ $(( SECONDS - t0 )) -lt 25 ]; do
    line="$(tail -n "+$from" "$log" | grep -m1 'kiosk on' || true)"
    [ -n "$line" ] && break
    sleep 1
  done
  if [ -n "$line" ]; then echo "  after ~$(( SECONDS - t0 )) s: $line"; else echo "  NO kiosk launch within 25 s"; fi
}

shot() { sleep 2; "$T" screenshot "$qa/kiosk-e2e-$tag-$1.png" >/dev/null; echo "  screenshot kiosk-e2e-$tag-$1.png"; state; }

replug() {  # $1: screenshot name
  local from=$(( $(wc -l < "$log") + 1 ))
  echo "$(date +%T) reconnect ($1)"
  "$T" reconnect >/dev/null
  await_launch "$from"
  shot "$1"
}

start=$(( $(wc -l < "$log") + 1 ))
echo "$(date +%T) kiosk-e2e $tag $mode; before:"; state
case "$mode" in
  replug)
    for i in 1 2 3; do replug "replug$i"; done
    echo "$(date +%T) Home"; "$T" key KEYCODE_HOME >/dev/null; shot home
    replug after-home
    ;;
  screen-off)
    echo "$(date +%T) sleep"; "$T" key KEYCODE_SLEEP >/dev/null; sleep 3
    "$T" shell dumpsys power | tr -d '\r' | grep -m1 -E 'mWakefulness=' | sed 's/^ */  /'
    replug screen-off
    "$T" lock-state
    ;;
  *) echo "kiosk-e2e: unknown mode $mode" >&2; exit 2 ;;
esac
echo "--- daemon log since start"
tail -n "+$start" "$log"
echo "--- reverses"; "$T" reverse-list
