#!/usr/bin/env bash
# Drive the test tablet over adb. Every subcommand holds the shared tablet lock
# (/tmp/clayclaude-tablet.lock) so only one agent touches the device at a time.
#
#   tools/tablet.sh devices
#   tools/tablet.sh unlock                    wake the screen and dismiss a swipe keyguard
#   tools/tablet.sh reverse <port>            adb reverse tcp:<port> tcp:<port>
#   tools/tablet.sh open-url <url>            open a URL in Chrome
#   tools/tablet.sh screenshot <out.png>      PNG of the screen (absolute path recommended)
#   tools/tablet.sh gfxinfo [reset]           dumpsys gfxinfo for Chrome (or reset its counters)
#   tools/tablet.sh top                       one batch of `top` (CPU / memory)
#   tools/tablet.sh key <keyevent>            e.g. KEYCODE_BACK, KEYCODE_WAKEUP
#   tools/tablet.sh tap <x> <y>               tap in physical pixels (1280x800 landscape)
#   tools/tablet.sh text <string>             type text (spaces sent as %s)
#   tools/tablet.sh rotation-landscape        lock rotation to landscape
#   tools/tablet.sh timeout <ms>              screen-off timeout
#   tools/tablet.sh shell <args...>           any other adb shell command
#   tools/tablet.sh reverse-list              list the adb reverses
#   tools/tablet.sh unreverse <port>          remove the reverse for <port>
#   tools/tablet.sh packages [pattern]        installed packages (pm list packages), filtered with grep -i
#   tools/tablet.sh am-start <args...>        am start -W <args> (activity launch; prints the result)
#   tools/tablet.sh open-url-as <url> <id>    open a URL in Chrome, reusing the tab opened with the same app id
#   tools/tablet.sh focus                     the focused window (which app is in front)
#   tools/tablet.sh ui-dump <out.xml>         uiautomator dump of the screen (text and bounds of every view)
#   tools/tablet.sh tabs                      Chrome's open tabs (DevTools /json/list over adb forward)
#   tools/tablet.sh close-tab <id>            close one Chrome tab by its DevTools id
#   tools/tablet.sh activate-tab <id>         bring one Chrome tab to the front by its DevTools id
#   tools/tablet.sh navigate <id> <url>       load <url> in an existing Chrome tab (DevTools Page.navigate): reuse tabs
#   tools/tablet.sh reload <id>               reload an existing Chrome tab (DevTools Page.reload)
#   tools/tablet.sh stay-awake [value]        print, or set, global stay_on_while_plugged_in (7 = AC+USB+wireless)
#   tools/tablet.sh lock-state                keyguard showing? (and whether it needs a PIN)
#   tools/tablet.sh reconnect                 adb reconnect: the device drops off adb for a moment, like a replug.
#                                             WARNING: it drops every adb reverse on the device. A running daemon
#                                             (or demo --adb) re-applies its own port within seconds; reverses you
#                                             made yourself (tablet.sh reverse) are gone: list and redo them.
#   tools/tablet.sh run-locked <cmd...>       run a command holding the tablet lock, with `adb` on PATH pointing at
#                                             $ADB; tablet.sh calls made inside it skip the lock (they already hold it)
#
# Environment: ADB (path to adb) and TABLET_SERIAL (the device's adb serial) are
# required; set them in the environment or in tools/tablet.env (git-ignored, sourced
# if present). TABLET_LOCK_WAIT: seconds to wait for the lock (default 600).
# TABLET_DEVTOOLS_PORT (default 9333) and TABLET_DEVTOOLS_TIMEOUT (seconds, default 10) for the DevTools subcommands;
# TABLET_NODE: the node that runs navigate/reload (default node.exe when ADB is a Windows .exe, else node).
# CLAYCLAUDE_TABLET_LOCK_HELD=1 is set by run-locked for its child; never set it yourself.
set -euo pipefail

env_file="$(dirname "$0")/tablet.env"
# shellcheck source=/dev/null
if [ -f "$env_file" ]; then . "$env_file"; fi
LOCK=/tmp/clayclaude-tablet.lock
CHROME=com.android.chrome

adb_() { "$ADB" -s "$SERIAL" "$@" || { local rc=$?; no_device_hint; return "$rc"; }; }
# One adb server only: under WSL, Windows adb.exe and a Linux adb each run their own server and only one can hold
# the tablet. When $ADB does not list $SERIAL as a device, say which adb was used and where the device may be.
no_device_hint() {
  local seen; seen="$("$ADB" devices 2>/dev/null | tr -d '\r' || true)"
  if grep -q "^${SERIAL}[[:space:]]device\$" <<<"$seen"; then return 0; fi
  {
    echo "tablet.sh: $ADB does not see $SERIAL as a device."
    echo "  Another adb server may own the tablet: under WSL, Windows adb.exe and a Linux adb each start their own,"
    echo "  and only one can hold the device. Check which sees it with '<that adb> devices'; use that one as ADB"
    echo "  (tools/tablet.env) and never mix adb and adb.exe. See README, Troubleshooting."
  } >&2
}

if [ "$#" -eq 0 ]; then
  awk 'NR == 1 { next } /^#/ { print; next } { exit }' "$0"   # the comment block above, however long
  exit 2
fi

ADB="${ADB:?set ADB (path to adb) in the environment or tools/tablet.env}"
SERIAL="${TABLET_SERIAL:?set TABLET_SERIAL (adb serial) in the environment or tools/tablet.env}"

if [ "${CLAYCLAUDE_TABLET_LOCK_HELD:-}" != 1 ]; then
  exec {lockfd}>"$LOCK"
  if ! flock -w "${TABLET_LOCK_WAIT:-600}" "$lockfd"; then
    echo "tablet.sh: timed out waiting for $LOCK" >&2
    exit 75
  fi
fi

cmd="$1"; shift
case "$cmd" in
  devices) "$ADB" devices; no_device_hint ;;
  unlock)
    adb_ shell input keyevent KEYCODE_WAKEUP
    adb_ shell wm dismiss-keyguard || true
    sleep 1
    if adb_ shell dumpsys window | grep -q 'isKeyguardShowing=true'; then
      adb_ shell input swipe 640 700 640 150 200
    fi
    ;;
  reverse)
    port="${1:?port}"
    adb_ reverse "tcp:$port" "tcp:$port"
    adb_ reverse --list
    ;;
  open-url)
    url="${1:?url}"
    adb_ shell am start -a android.intent.action.VIEW -d "'$url'" "$CHROME" >/dev/null
    ;;
  screenshot)
    out="${1:?output path}"
    adb_ exec-out screencap -p > "$out"
    echo "$out"
    ;;
  gfxinfo)
    if [ "${1:-}" = reset ]; then adb_ shell dumpsys gfxinfo "$CHROME" reset >/dev/null; else adb_ shell dumpsys gfxinfo "$CHROME"; fi
    ;;
  top) adb_ shell top -b -n 1 -m 15 ;;
  key) adb_ shell input keyevent "${1:?keyevent}" ;;
  tap) adb_ shell input tap "${1:?x}" "${2:?y}" ;;
  text) adb_ shell input text "$(printf '%s' "${1:?text}" | sed 's/ /%s/g')" ;;
  rotation-landscape)
    adb_ shell settings put system accelerometer_rotation 0
    adb_ shell settings put system user_rotation 1
    ;;
  timeout) adb_ shell settings put system screen_off_timeout "${1:?ms}" ;;
  shell) adb_ shell "$@" ;;
  reverse-list) adb_ reverse --list ;;
  unreverse) adb_ reverse --remove "tcp:${1:?port}" ;;
  packages)
    if [ -n "${1:-}" ]; then adb_ shell pm list packages | grep -i -- "$1" || true; else adb_ shell pm list packages; fi
    ;;
  am-start) adb_ shell am start -W "$@" ;;
  open-url-as)
    url="${1:?url}"; app="${2:?app id}"
    adb_ shell am start -a android.intent.action.VIEW -d "'$url'" -e com.android.browser.application_id "$app" "$CHROME" >/dev/null
    ;;
  focus) adb_ shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' ;;
  ui-dump)
    out="${1:?output path}"
    adb_ shell uiautomator dump /sdcard/clayclaude-ui.xml >/dev/null
    adb_ exec-out cat /sdcard/clayclaude-ui.xml > "$out"
    adb_ shell rm -f /sdcard/clayclaude-ui.xml
    echo "$out"
    ;;
  tabs|close-tab|activate-tab|navigate|reload)
    # Chrome's DevTools socket, forwarded to the adb host. adb is Windows adb.exe under WSL, so the
    # forward binds on Windows: query it with curl.exe when present, and talk WebSocket with node.exe.
    dport="${TABLET_DEVTOOLS_PORT:-9333}"; dtime="${TABLET_DEVTOOLS_TIMEOUT:-10}"
    curl_=curl; if [ -x /mnt/c/Windows/System32/curl.exe ]; then curl_=/mnt/c/Windows/System32/curl.exe; fi
    node_=node; case "$ADB" in *.exe) node_=node.exe ;; esac; node_="${TABLET_NODE:-$node_}"
    case "$cmd" in navigate) : "${1:?tab id}" "${2:?url}" ;; close-tab|activate-tab|reload) : "${1:?tab id}" ;; esac
    adb_ forward "tcp:$dport" localabstract:chrome_devtools_remote >/dev/null
    # a stalled DevTools socket (Chrome in the background) must not hold the tablet lock forever or leave the forward behind
    trap 'adb_ forward --remove "tcp:$dport" 2>/dev/null || true' EXIT
    case "$cmd" in
      tabs) "$curl_" -s --max-time "$dtime" "http://127.0.0.1:$dport/json/list" ;;
      close-tab) "$curl_" -s --max-time "$dtime" "http://127.0.0.1:$dport/json/close/$1"; echo ;;
      activate-tab) "$curl_" -s --max-time "$dtime" "http://127.0.0.1:$dport/json/activate/$1"; echo ;;
      navigate|reload)
        # one CDP command on the tab's own page socket; the script comes on stdin so node.exe needs no Windows path
        "$node_" - "ws://127.0.0.1:$dport/devtools/page/$1" "$cmd" "${2:-}" "$dtime" <<'JS'
const [, , url, cmd, target, secs] = process.argv;
const fail = (why) => { console.error(`tablet.sh: ${cmd}: ${why}`); process.exit(1); };
setTimeout(() => fail(`timed out after ${secs}s waiting for DevTools at ${url}`), Number(secs) * 1000);
const ws = new WebSocket(url);
ws.onopen = () => ws.send(JSON.stringify(cmd === 'navigate'
  ? { id: 1, method: 'Page.navigate', params: { url: target } } : { id: 1, method: 'Page.reload', params: {} }));
ws.onerror = () => fail(`cannot reach DevTools at ${url} (is the tab id from tablet.sh tabs?)`);
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id !== 1) return;
  if (m.error) fail(m.error.message ?? JSON.stringify(m.error));
  if (m.result?.errorText) fail(m.result.errorText);
  console.log(JSON.stringify(m.result ?? {}));
  process.exit(0);
};
JS
        ;;
    esac
    ;;
  stay-awake)
    if [ -n "${1:-}" ]; then adb_ shell settings put global stay_on_while_plugged_in "$1"; fi
    adb_ shell settings get global stay_on_while_plugged_in
    ;;
  lock-state)
    adb_ shell dumpsys window | grep -m1 -E 'isKeyguardShowing' || true
    adb_ shell dumpsys lock_settings | grep -m1 -E 'CredentialType' || true
    ;;
  reconnect) adb_ reconnect ;;
  run-locked)
    [ "$#" -gt 0 ] || { echo "tablet.sh: run-locked needs a command" >&2; exit 2; }
    bindir="$(mktemp -d)"
    ln -s "$ADB" "$bindir/adb"
    rc=0
    # The child must not inherit the lock's fd: anything it leaves running (a demo server, a tmux server) would
    # otherwise hold the tablet lock until it exits, long after this run-locked has returned.
    if [ -n "${lockfd:-}" ]; then
      PATH="$bindir:$PATH" CLAYCLAUDE_TABLET_BINDIR="$bindir" ADB="$ADB" TABLET_SERIAL="$SERIAL" CLAYCLAUDE_TABLET_LOCK_HELD=1 "$@" {lockfd}>&- || rc=$?
    else
      PATH="$bindir:$PATH" CLAYCLAUDE_TABLET_BINDIR="$bindir" ADB="$ADB" TABLET_SERIAL="$SERIAL" CLAYCLAUDE_TABLET_LOCK_HELD=1 "$@" || rc=$?
    fi
    rm -f "$bindir/adb"; rmdir "$bindir"
    exit "$rc"
    ;;
  *) echo "tablet.sh: unknown subcommand $cmd" >&2; exit 2 ;;
esac
