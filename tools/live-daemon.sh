#!/usr/bin/env bash
# Restart the real daemon (the config's port, default 8420) from a built worktree, supervised so it comes back on its own.
#
#   tools/tablet.sh run-locked tools/live-daemon.sh <worktree> [log]
#
# With a systemd user manager (WSL with systemd on, any desktop Linux) it installs tools/clayclaude.service, points it at
# <worktree> through ~/.config/clayclaude/daemon.env, enables it and restarts it: the daemon then restarts after a crash
# and starts again when WSL does. The log is then ~/.local/state/clayclaude/serve.log and [log] is ignored. Without
# systemd, or with CLAYCLAUDE_NO_SYSTEMD=1, it falls back to a detached setsid + nohup process, which nothing restarts.
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

unit="$HOME/.config/systemd/user/clayclaude.service"
use_systemd=""
# CLAYCLAUDE_NO_SYSTEMD=1 forces the detached path. The tests set it: a substitute HOME does not select another user
# manager, so without it a test would stop the real clayclaude.service.
if [ -z "${CLAYCLAUDE_NO_SYSTEMD:-}" ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  use_systemd=1
fi
if [ -n "$use_systemd" ]; then
  # Checked before anything is stopped, so a worktree without the unit cannot leave the daemon down.
  [ -f "$wt/tools/clayclaude.service" ] || { echo "live-daemon: no $wt/tools/clayclaude.service" >&2; exit 1; }
  [ -z "${2:-}" ] || echo "live-daemon: under systemd the log is ~/.local/state/clayclaude/serve.log; ignoring $2" >&2
  log="$HOME/.local/state/clayclaude/serve.log"
  # Stop the unit first, so Restart=always does not bring the old daemon back while it is being replaced.
  systemctl --user stop clayclaude.service 2>/dev/null || true
fi

# A daemon started by hand (or by this script before the unit existed) still holds the port: stop it too.
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
if [ -n "$use_systemd" ]; then
  # systemd spawns the daemon itself, so it inherits neither the tablet lock's descriptor nor this shell's environment.
  # Nor does `systemctl start` pass this shell's environment on, so daemon.env carries what the daemon and the local
  # probe read: PATH, WSL_DISTRO_NAME (how it knows it is under WSL), PLAYWRIGHT_BROWSERS_PATH, every CLAYCLAUDE_*
  # (CLAYCLAUDE_CHROMIUM, the probe's URL overrides), and each variable a `tokenEnv:` in the config names. It holds a
  # token when one is set that way, so it is written private. Settings that should outlive this shell go in
  # ~/.config/clayclaude/env, which the unit reads after daemon.env.
  q() { local v="${!1}"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; v="${v//\$/\\\$}"; printf '%s="%s"\n' "$1" "$v"; }
  token_vars=" $(grep -o "tokenEnv:[[:space:]]*[\"']\{0,1\}[A-Za-z_][A-Za-z0-9_]*" "$cfg" | sed "s/.*[[:space:]\"':]//" | tr '\n' ' ' || true) "
  (
    # umask inside the subshell, and the redirect inside it too: a redirect on the subshell is opened before it runs.
    umask 077
    exec > "$HOME/.config/clayclaude/daemon.env.tmp"
    # shellcheck disable=SC2034  # read through q's indirect expansion
    CLAYCLAUDE_WT="$wt" CLAYCLAUDE_NODE="$(command -v node)"
    q CLAYCLAUDE_WT; q CLAYCLAUDE_NODE
    for n in $(compgen -e); do
      case "$n" in
        CLAYCLAUDE_WT|CLAYCLAUDE_NODE|CLAYCLAUDE_NO_SYSTEMD|CLAYCLAUDE_TABLET_LOCK_HELD) ;;
        CLAYCLAUDE_*|PATH|WSL_DISTRO_NAME|PLAYWRIGHT_BROWSERS_PATH) q "$n" ;;
        *) case "$token_vars" in *" $n "*) q "$n" ;; esac ;;
      esac
    done
  )
  mv "$HOME/.config/clayclaude/daemon.env.tmp" "$HOME/.config/clayclaude/daemon.env"
  mkdir -p "$(dirname "$unit")"
  if ! cmp -s "$wt/tools/clayclaude.service" "$unit"; then
    cp "$wt/tools/clayclaude.service" "$unit"
    systemctl --user daemon-reload
  fi
  systemctl --user enable --quiet clayclaude.service
  systemctl --user start clayclaude.service
else
# The child must not inherit the tablet lock's descriptor (run-locked holds it), or the lock would never be released.
(
  for fd in /proc/"$BASHPID"/fd/*; do n="${fd##*/}"; if [ "$n" -gt 2 ]; then eval "exec $n>&-"; fi; done
  cd "$wt"
  unset CLAYCLAUDE_TABLET_LOCK_HELD
  exec setsid nohup node "$wt/dist/cli.js" serve >> "$log" 2>&1 < /dev/null
) &
fi
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$port/healthz"; echo " (healthz)"
echo "live-daemon: listening: $(ss -ltnpH "sport = :$port" | sed -n 's/.*users:\(.*\)/\1/p')"
sleep 15
tail -n "+$start_line" "$log"
