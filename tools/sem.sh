#!/usr/bin/env bash
# Run a heavy command (vitest, vite build, tsc, headless browsers) while holding
# one of the shared slots, so parallel agents never run more than N at once
# (N = CLAYCLAUDE_HEAVY_SLOTS, default 6).
#
#   tools/sem.sh npx vitest run test/foo.test.ts
#
# Slots are flock(1)-style locks on /tmp/clayclaude-heavy.<n>.lock. A slot is
# released when this process exits, however it exits. A new command does not start
# while the machine has less than 1.5 GB of memory available. Exits with the
# command's status.
set -u

if [ "$#" -eq 0 ]; then
  echo "usage: tools/sem.sh <command> [args...]" >&2
  exit 2
fi

slots="${CLAYCLAUDE_HEAVY_SLOTS:-6}"
floor_mb="${CLAYCLAUDE_MEM_FLOOR_MB:-1536}"
avail_mb() { awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo; }

waited=0
while :; do
  if [ "$(avail_mb)" -ge "$floor_mb" ]; then
    for i in $(seq 1 "$slots"); do
      lock="/tmp/clayclaude-heavy.$i.lock"
      exec {fd}>"$lock"
      if flock -n "$fd"; then
        nice -n 10 "$@"
        exit $?
      fi
      exec {fd}>&-
    done
  fi
  if [ "$waited" -eq 0 ]; then
    echo "sem.sh: all $slots heavy slots busy or memory below ${floor_mb} MB, waiting..." >&2
    waited=1
  fi
  sleep 2
done
