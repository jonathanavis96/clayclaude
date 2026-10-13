#!/usr/bin/env bash
# The kiosk board goes full screen by itself (P3 Task 35), on the real tablet, against a demo on a spare port.
#
#   tools/tablet.sh run-locked test/manual/kiosk-fullscreen-e2e.sh <port> <out-dir>
#
# Starts `clayclaude demo --kiosk --port <port>` (its own Chrome tab, application id clayclaude-demo, so the real
# board's tab is never touched) with the Windows adb first on PATH. The daemon starting with the tablet plugged in is a
# device connect, like a replug, without dropping other agents' adb reverses as `adb reconnect` would. Then, with no
# tap from this script except the double taps that leave full screen on purpose:
#   plug-in, reload, rotate to portrait, rotate back, leave full screen by Back (not by double tap),
#   in landscape and then in portrait: open the settings sheet, Back (leaves full screen; the sheet stays open and the
#   board does not take full screen back), Back again (closes the sheet; the board goes back to full screen),
#   double-tap exit in portrait (stays out), rotate to landscape (back in), double-tap exit in landscape (stays out
#   for 10 s), rotate to portrait (back in), rotate back.
# After each step: a screenshot <out-dir>/t35-<n>-<step>.png and the page's own state (full screen, orientation,
# viewport, cover) read over DevTools. Leaves the tablet in landscape; kills the demo, closes its tab and removes its
# adb reverse.
set -u
here="$(cd "$(dirname "$0")/../.." && pwd)"
T="$here/tools/tablet.sh"
port="${1:?usage: kiosk-fullscreen-e2e.sh <port> <out-dir>}"; out="${2:?out dir}"
mkdir -p "$out"
: "${ADB:?run under tools/tablet.sh run-locked}" "${TABLET_SERIAL:?run under tools/tablet.sh run-locked}"
log="$out/t35-demo.log"
dport=9336

bindir="$(mktemp -d)"; ln -s "$ADB" "$bindir/adb"
PATH="$bindir:$PATH" nohup node "$here/dist/cli.js" demo --kiosk --port "$port" > "$log" 2>&1 &
demo=$!
cleanup() {
  kill "$demo" 2>/dev/null; wait "$demo" 2>/dev/null
  "$ADB" -s "$TABLET_SERIAL" forward --remove "tcp:$dport" 2>/dev/null
  rm -f "$bindir/adb"; rmdir "$bindir"
}
trap cleanup EXIT

# The demo tab's DevTools id, and one Runtime.evaluate on it.
tab=""
find_tab() { tab="$("$T" tabs | tr -d '\r' | grep -B4 "\"url\": \"http://localhost:$port/#kiosk" | grep -oE '"id": "[0-9]+"' | grep -oE '[0-9]+' | head -1)"; }
ev() {
  "$ADB" -s "$TABLET_SERIAL" forward "tcp:$dport" localabstract:chrome_devtools_remote >/dev/null
  node.exe - "ws://127.0.0.1:$dport/devtools/page/$tab" "$1" <<'JS'
const [, , url, expr] = process.argv;
setTimeout(() => { console.log('"devtools timeout"'); process.exit(0); }, 8000);
const ws = new WebSocket(url);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.onerror = () => { console.log('"devtools error"'); process.exit(0); };
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id !== 1) return; console.log(JSON.stringify(m.result?.result?.value ?? m.error)); process.exit(0); };
JS
}
STATE='JSON.stringify({fullscreen:!!document.fullscreenElement,orientation:screen.orientation.type,viewport:innerWidth+"x"+innerHeight,cover:(document.getElementById("kiosk-start")||{style:{}}).style.display,sheets:document.querySelectorAll("#overlays > :not(.toast)").length})'
n=0
shot() {  # $1: step name
  n=$((n+1)); local f; f="$out/t35-$(printf %02d "$n")-$1.png"
  "$T" screenshot "$f" >/dev/null
  echo "$(date +%T) $1: $(ev "$STATE")"
  "$T" shell dumpsys window | tr -d '\r' | grep -m2 -oE 'type=(statusBars|navigationBars) frame=\S+ visible=(true|false)' | sed 's/^/    bars: /'
  echo "    $(basename "$f")"
}
rotate() { "$T" shell settings put system accelerometer_rotation 0; "$T" shell settings put system user_rotation "$1"; }
# Two taps on the clock within the board's 350 ms double-tap window, in one device shell (one adb round trip).
# A sheet open in full screen, then Back twice with the real Back key ($1: orientation, for the step names).
sheet_back() {
  ev 'document.querySelector(".cog").click(),"opened"' >/dev/null; sleep 4; shot "$1-sheet-open"
  "$T" key 4; sleep 8; shot "$1-sheet-first-back"
  "$T" key 4; sleep 8; shot "$1-sheet-closed"
}
double_tap_clock() { "$ADB" -s "$TABLET_SERIAL" shell "input tap 110 55 & sleep 0.12; input tap 110 55"; }

rotate 1
echo "$(date +%T) plug-in: demo --kiosk on $port"
for _ in $(seq 1 30); do grep -q 'kiosk on' "$log" && break; sleep 1; done
grep 'kiosk on' "$log" | sed 's/^/    /'
sleep 4; find_tab; echo "    tab $tab"
shot plugin

"$T" reload "$tab" >/dev/null; sleep 8; shot reload
rotate 0; sleep 7; shot portrait
rotate 1; sleep 7; shot landscape
ev 'document.exitFullscreen().then(()=>"left")' >/dev/null; sleep 8; shot after-back
sheet_back landscape
rotate 0; sleep 7
sheet_back portrait
double_tap_clock; sleep 8; shot portrait-double-tap-exit
rotate 1; sleep 8; shot landscape-after-rotate
double_tap_clock; sleep 3; shot landscape-double-tap-exit
sleep 10; shot landscape-still-out
rotate 0; sleep 8; shot portrait-after-rotate
rotate 1; sleep 7; shot landscape-final
echo "--- demo log"; grep -E 'kiosk|reverse' "$log" | sed 's/^/    /'
"$T" close-tab "$tab" >/dev/null
"$ADB" -s "$TABLET_SERIAL" reverse --remove "tcp:$port" 2>/dev/null
rotate 1
