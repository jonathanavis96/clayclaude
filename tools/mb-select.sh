#!/usr/bin/env bash
# Choose the checks tools/merge-branch.sh runs under the merge lock for a branch.
#
#   git diff --name-only build...HEAD | tools/mb-select.sh <worktree-root>
#
# Reads the branch's changed paths (one per line, docs/ already removed or not) on stdin and
# prints one directive per line:
#   test <file>       a test file to run with `vitest run`
#   related <file>    a source file to pass to `vitest related`
#   exclude <glob>    a glob `vitest related` must skip (browser/snapshot tests)
#   heavy             browser tests are included in full (the branch changes web/src/clay/ or them)
#
# Rules:
#   - The branch's own added or modified test/*.test.ts files ALWAYS run, browser tests included.
#   - Changed .ts/.mts files go to `vitest related`; probe/hook .py changes add their own tests.
#   - A branch that changes web/src/**/*.css or a web/src/*.ts (UI outside the clay) also runs every
#     test/web-*-layout*.test.ts (three files, about 10 s together on a loaded machine, 2026-10-13).
#   - Browser/snapshot tests (test/clay-browser, clay-snapshots, *-clay, web-*-layout) are excluded
#     from `vitest related` unless the branch changes web/src/clay/ or clay-browser/clay-snapshots.
#   - docs/ paths and paths that no longer exist select nothing.
set -euo pipefail

wt="${1:?usage: tools/mb-select.sh <worktree-root> < changed-paths}"
changed="$(grep -v '^docs/' || true)"
[ -n "$changed" ] || exit 0

out=()
heavy=0 layout=0
if grep -qE '^web/src/clay/|^test/(clay-browser|clay-snapshots)' <<< "$changed"; then heavy=1; fi
if grep -qE '^web/src/.*\.css$|^web/src/[^/]+\.m?ts$' <<< "$changed"; then layout=1; fi

while IFS= read -r f; do
  if [ -z "$f" ] || [ ! -f "$wt/$f" ]; then continue; fi
  case "$f" in
    test/*.test.ts) out+=("test $f") ;;
    *.ts|*.mts) out+=("related $f") ;;
    src/probe/*.py) for t in "$wt"/test/probe*.test.ts "$wt"/test/run*.test.ts; do [ -f "$t" ] && out+=("test ${t#"$wt"/}"); done ;;
    src/hooks/*.py) for t in "$wt"/test/hook*.test.ts; do [ -f "$t" ] && out+=("test ${t#"$wt"/}"); done ;;
  esac
done <<< "$changed"

if [ "$layout" = 1 ]; then
  for t in "$wt"/test/web-*-layout*.test.ts; do [ -f "$t" ] && out+=("test ${t#"$wt"/}"); done
fi
if [ "$heavy" = 1 ]; then
  out+=("heavy")
else
  for g in 'test/clay-browser*' 'test/clay-snapshots*' 'test/*-clay.test.ts' 'test/web-*-layout*.test.ts'; do
    out+=("exclude $g")
  done
fi

# De-duplicate, keeping first-seen order (a test can be both changed and a layout test).
[ "${#out[@]}" -gt 0 ] && printf '%s\n' "${out[@]}" | awk '!seen[$0]++'
exit 0
