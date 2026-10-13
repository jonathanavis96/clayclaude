#!/usr/bin/env bash
# Restart the real daemon (the config's port, default 8420) from a built worktree, detached so it outlives the caller.
#
#   tools/tablet.sh run-locked tools/live-daemon.sh <worktree> [log]
#
# Run it under run-locked: a tablet that is attached gets a kiosk launch (an injected tap) as soon as the new daemon
# starts, so no other agent may be mid-test. Refuses to start unless every account in the default config that polls oauth usage
# (one with no usage key does: the default) has `refresh: false`. Stops whatever node process listens on 127.0.0.1:<port> with SIGTERM, starts
# `node <worktree>/dist/cli.js serve` with setsid + nohup (log appended to [log]), waits for /healthz, then waits
# 15 s for the first kiosk launch and prints the new log lines. The config check is tools/refresh-guard.mjs.
set -euo pipefail
wt="$(cd "${1:?usage: tools/live-daemon.sh <worktree> [log]}" && pwd)"
log="${2:-${TMPDIR:-/tmp}/clayclaude-serve.log}"
cfg="$HOME/.config/clayclaude/config.yaml"
port="$(sed -n 's/^port:[[:space:]]*\([0-9]*\).*/\1/p' "$cfg")"; port="${port:-8420}"
[ -f "$wt/dist/cli.js" ] || { echo "live-daemon: no $wt/dist/cli.js (run tools/sem.sh npm run build there)" >&2; exit 1; }

# Never poll usage with refresh on: every oauth account, including one with no usage key (the default is oauth with
# refresh on), must say refresh: false. Parsed as YAML, so block and flow style are judged alike.
if ! node "$(dirname "${BASH_SOURCE[0]}")/refresh-guard.mjs" "$cfg"; then
  echo "live-daemon: an oauth account in $cfg lacks refresh: false; not starting" >&2; exit 1
fi

pid="$(ss -ltnpH "sport = :$port" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
if [ -n "$pid" ]; then
  echo "live-daemon: stopping pid $pid ($(tr '\0' ' ' < "/proc/$pid/cmdline"), cwd $(readlink "/proc/$pid/cwd"))"
  kill -TERM "$pid"
  for _ in $(seq 1 50); do [ -d "/proc/$pid" ] || break; sleep 0.2; done
  [ ! -d "/proc/$pid" ] || { echo "live-daemon: pid $pid did not exit" >&2; exit 1; }
fi

# Create the log first: on a first start it does not exist yet, and `wc -l < "$log"` would complain.
mkdir -p "$(dirname "$log")"
touch "$log"
start_line=$(( $(wc -l < "$log") + 1 ))
echo "=== $(date -Is) live-daemon: node $wt/dist/cli.js serve ===" >> "$log"
# The child must not inherit the tablet lock's descriptor (run-locked holds it), or the lock would never be released.
(
  for fd in /proc/"$BASHPID"/fd/*; do n="${fd##*/}"; if [ "$n" -gt 2 ]; then eval "exec $n>&-"; fi; done
  cd "$wt"
  unset CLAYCLAUDE_TABLET_LOCK_HELD
  exec setsid nohup node "$wt/dist/cli.js" serve >> "$log" 2>&1 < /dev/null
) &
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$port/healthz"; echo " (healthz)"
echo "live-daemon: listening: $(ss -ltnpH "sport = :$port" | sed -n 's/.*users:\(.*\)/\1/p')"
sleep 15
tail -n "+$start_line" "$log"
