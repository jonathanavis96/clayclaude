#!/usr/bin/env bash
# Release smoke test: pack the package, install the tarball into a fresh prefix, run the installed
# `clayclaude demo`, and check what it serves and what the tarball holds. Nothing is published.
#
#   tools/sem.sh tools/pack-smoke.sh            # heavy (tsc, vite build, npm install): take a slot
#
# PACK_SMOKE_PORT picks the demo port (default 7453). KEEP=1 keeps the temp directory for a look.
# Exits 0 only if every check passed.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${PACK_SMOKE_PORT:-7453}"
if [ "$port" = 8420 ]; then echo "pack-smoke: refusing port 8420 (the real daemon's port)" >&2; exit 2; fi
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  echo "pack-smoke: something already listens on 127.0.0.1:$port; set PACK_SMOKE_PORT to a free port" >&2; exit 2
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/clayclaude-pack-smoke.XXXXXX")"
demo_pid=""
cleanup() {
  if [ -n "$demo_pid" ] && kill -0 "$demo_pid" 2>/dev/null; then
    kill -TERM "$demo_pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$demo_pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$demo_pid" 2>/dev/null || true
  fi
  if [ "${KEEP:-0}" = 1 ]; then echo "pack-smoke: kept $tmp"; else rm -rf "$tmp"; fi
}
trap cleanup EXIT

fails=0
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fails=$((fails + 1)); }

echo "pack-smoke: packing (prepack cleans and builds)"
mkdir -p "$tmp/pack"
npm pack --prefix "$repo" --pack-destination "$tmp/pack" --silent >"$tmp/pack.log" 2>&1 || { cat "$tmp/pack.log"; exit 1; }
tarball="$(ls "$tmp"/pack/clayclaude-*.tgz)"
echo "pack-smoke: $(basename "$tarball"), $(du -k "$tarball" | cut -f1) KB"

echo "pack-smoke: tarball contents"
tar -tzf "$tarball" | sed 's#^package/##' | sort >"$tmp/files.txt"
for f in package.json README.md LICENSE CHANGELOG.md example.config.yaml \
         dist/cli.js dist/commands/demo.js dist/commands/setup.js \
         dist/probe/probe.py dist/hooks/clayclaude-hook.py dist/hotkey/clayclaude-hotkey.ahk \
         web/dist/index.html web/dist/clay-bake.html web/dist/clay-lab.html web/dist/manifest.webmanifest web/dist/sw.js; do
  if grep -qxF "$f" "$tmp/files.txt"; then ok "has $f"; else bad "missing $f"; fi
done
# Only these top-level entries may ship: no src/, test/, docs/, tools/ (tablet.env), node_modules, configs.
extra="$(grep -vE '^(package\.json|README\.md|LICENSE|CHANGELOG\.md|example\.config\.yaml|dist/.*|web/dist/.*)$' "$tmp/files.txt" || true)"
if [ -z "$extra" ]; then ok "nothing outside the allowed list"; else bad "unexpected files:"; while IFS= read -r f; do echo "         $f"; done <<<"$extra"; fi
if grep -qE '(^|/)(tablet\.env|config\.yaml|\.credentials\.json)$|\.test\.(js|ts)$|\.map$' "$tmp/files.txt"; then
  bad "secret-looking, test or source-map files shipped"; grep -E '(^|/)(tablet\.env|config\.yaml|\.credentials\.json)$|\.test\.(js|ts)$|\.map$' "$tmp/files.txt" | sed 's/^/         /'
else ok "no tablet.env, real config, tests or source maps"; fi

echo "pack-smoke: installing into a fresh prefix"
mkdir -p "$tmp/prefix" "$tmp/home"
(cd "$tmp" && HOME="$tmp/home" npm install -g --prefix "$tmp/prefix" --no-audit --no-fund --loglevel=error "$tarball") >"$tmp/install.log" 2>&1 || { cat "$tmp/install.log"; exit 1; }
bin="$tmp/prefix/bin/clayclaude"
if [ -x "$bin" ]; then ok "bin installed"; else bad "no $bin"; exit 1; fi
usage="$(HOME="$tmp/home" "$bin" 2>&1 || true)"
if grep -q 'clayclaude demo' <<<"$usage"; then ok "prints usage with no command"; else bad "usage text: $usage"; fi

echo "pack-smoke: clayclaude demo --port $port"
# Its own process group, so cleanup can stop it whatever it started.
HOME="$tmp/home" setsid "$bin" demo --port "$port" >"$tmp/demo.log" 2>&1 &
demo_pid=$!
for _ in $(seq 1 100); do
  grep -q "on http://127.0.0.1:$port" "$tmp/demo.log" 2>/dev/null && break
  kill -0 "$demo_pid" 2>/dev/null || break
  sleep 0.1
done
if grep -q "on http://127.0.0.1:$port" "$tmp/demo.log"; then ok "demo started"; else bad "demo did not start:"; sed 's/^/         /' "$tmp/demo.log"; exit 1; fi

base="http://127.0.0.1:$port"
get() { curl -s -o "$tmp/body" -w '%{http_code} %{content_type}' --max-time 10 -L "$base$1"; }
check() { # path, expected content-type prefix, grep pattern for the body
  local r; r="$(get "$1")" || true
  if [[ "$r" == "200 $2"* ]] && grep -q -- "$3" "$tmp/body"; then ok "GET $1 ($r)"; else bad "GET $1 -> $r: $(head -c 200 "$tmp/body")"; fi
}
check /          text/html        '<div id="app"\|<script'
check /api/state application/json '"sessions":\[{'
check /gallery   text/html        'clay'
check /usage     application/json 'five_hour'
# The pages' own scripts and styles, as the installed package serves them.
assets="$( { curl -s --max-time 10 "$base/"; curl -s --max-time 10 -L "$base/gallery"; } | grep -oE '(src|href)="/assets/[^"]+"' | sed -E 's/^(src|href)="//; s/"$//' | sort -u)"
if [ -z "$assets" ]; then bad "no /assets/ references in / or /gallery"; fi
for a in $assets; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$base$a")"
  if [ "$code" = 200 ]; then ok "GET $a"; else bad "GET $a -> $code"; fi
done

echo "pack-smoke: stopping the demo"
kill -TERM "$demo_pid"
for _ in $(seq 1 50); do kill -0 "$demo_pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$demo_pid" 2>/dev/null; then bad "demo still running 5 s after SIGTERM"; else ok "demo stopped"; demo_pid=""; fi

echo "pack-smoke: clayclaude setup in a temp HOME (installed probe and hook script)"
mkdir -p "$tmp/setup-home/.claude/sessions"
echo '{"pid":1}' >"$tmp/setup-home/.claude/sessions/1.json"
echo '{"model":"opus"}' >"$tmp/setup-home/.claude/settings.json"
# ssh aliases, tmux session, repo roots; add ~/.claude, label, colour, usage none, open tmux, hooks yes, apply yes;
# tablet no; [hotkey no, Windows and WSL only]; LAN no; write yes.
answers=$'\n\n\ny\n\n\n3\n3\ny\ny\nn\n'
if grep -qi microsoft /proc/version 2>/dev/null; then answers+=$'n\n'; fi
answers+=$'n\ny\n'
if HOME="$tmp/setup-home" "$bin" setup <<<"$answers" >"$tmp/setup.log" 2>&1; then ok "setup finished"; else bad "setup failed:"; tail -5 "$tmp/setup.log" | sed 's/^/         /'; fi
cfg="$tmp/setup-home/.config/clayclaude/config.yaml"
if [ -f "$cfg" ] && [ "$(stat -c %a "$cfg")" = 600 ]; then ok "config written, mode 600"; else bad "no config, or not mode 600"; fi
if cmp -s "$tmp/setup-home/.claude/clayclaude/hook.py" "$tmp/prefix/lib/node_modules/clayclaude/dist/hooks/clayclaude-hook.py"; then ok "hook script installed from the package"; else bad "hook script missing or different"; fi
if compgen -G "$tmp/setup-home/.claude/settings.json.bak-clayclaude-*" >/dev/null; then ok "settings.json backed up"; else bad "no settings.json backup"; fi

if [ "$fails" -eq 0 ]; then echo "pack-smoke: PASS"; else echo "pack-smoke: $fails check(s) failed"; exit 1; fi
