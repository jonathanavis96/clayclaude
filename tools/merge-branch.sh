#!/usr/bin/env bash
# Land a task branch on `build`, one landing at a time. Run it from the task's worktree:
#
#   tools/merge-branch.sh <branch> ["merge message"]
#
# Holding /tmp/clayclaude-merge.lock it:
#   1. rebases <branch> onto the current `build` in this worktree (once, no merge commits), then
#      removes AI attribution trailers (the Claude co-author and session-link lines) from the
#      branch's own commits (build..HEAD only) with tools/mb-strip-trailers.sh, since `build` goes
#      public;
#   2. runs `npm run typecheck` and the tests the branch touches, as chosen by tools/mb-select.sh:
#      its own added/modified test files (always, browser tests included), `vitest related` for
#      changed TypeScript (probe/hook .py changes add their own tests), and every web-*-layout test
#      when it changes web/src/**/*.css or web/src/*.ts. `vitest related` skips browser/snapshot
#      tests (test/clay-browser, clay-snapshots, *-clay, web-*-layout) unless the branch changes
#      web/src/clay/ or clay-browser/clay-snapshots. The whole suite runs OUTSIDE the lock (the
#      director runs it hourly). Skipped when the branch only touches docs/;
#   3. merges <branch> into `build` in the main checkout with --no-ff.
#
# Exit codes: 0 landed; 3 rebase conflict (resolve it yourself: `git rebase build`, fix,
# `git rebase --continue`, re-run your tests, then call this again); 5 checks failed after the
# rebase (fix, commit, call again); 2 setup problem (dirty worktree or main checkout,
# the test selector failed, or the trailer strip failed); 75 timed out waiting for the lock.
set -euo pipefail

branch="${1:?usage: tools/merge-branch.sh <branch> [message]}"
msg="${2:-Merge $branch}"
wt="$(git rev-parse --show-toplevel)"
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
sem="$wt/tools/sem.sh"

if [ "$(git -C "$wt" branch --show-current)" != "$branch" ]; then
  echo "merge-branch: run this from the worktree that has $branch checked out (here: $wt)" >&2; exit 2
fi
if ! git -C "$wt" diff --quiet || ! git -C "$wt" diff --cached --quiet; then
  echo "merge-branch: $wt has uncommitted changes; commit or discard them first" >&2; exit 2
fi

exec {lockfd}>/tmp/clayclaude-merge.lock
flock -w 3600 "$lockfd" || { echo "merge-branch: timed out waiting for the merge lock" >&2; exit 75; }

if [ "$(git -C "$main" branch --show-current)" != build ]; then
  echo "merge-branch: main checkout $main is not on build" >&2; exit 2
fi
if ! git -C "$main" diff --quiet || ! git -C "$main" diff --cached --quiet; then
  echo "merge-branch: main checkout has uncommitted changes; refusing" >&2
  git -C "$main" status --short >&2
  exit 2
fi

lock_before="$(git -C "$wt" rev-parse HEAD:package-lock.json 2>/dev/null || true)"
if ! git -C "$main" merge-base --is-ancestor build "$branch"; then
  if ! git -C "$wt" rebase -q build; then
    git -C "$wt" rebase --abort || true
    echo "merge-branch: rebasing $branch onto build conflicts. In $wt run: git rebase build," >&2
    echo "  resolve each conflict, git rebase --continue, re-run your tests, then call this again." >&2
    exit 3
  fi
fi
if ! "$wt/tools/mb-strip-trailers.sh" "$wt" build; then
  echo "merge-branch: tools/mb-strip-trailers.sh failed to remove the AI attribution trailers" >&2; exit 2
fi
if [ "$(git -C "$wt" rev-parse HEAD:package-lock.json 2>/dev/null || true)" != "$lock_before" ] || [ ! -d "$wt/node_modules" ]; then
  npm --prefix "$wt" ci --no-audit --no-fund --silent
fi

changed="$(git -C "$wt" diff --name-only build...HEAD | grep -v '^docs/' || true)"
if [ -n "$changed" ]; then
  if ! sel="$(printf '%s\n' "$changed" | "$wt/tools/mb-select.sh" "$wt")"; then
    echo "merge-branch: tools/mb-select.sh failed to choose the checks" >&2; exit 2
  fi
  tests=() related=() excl=()
  heavy_ok=0
  while read -r kind arg; do
    case "$kind" in
      test) tests+=("$arg") ;;
      related) related+=("$arg") ;;
      exclude) excl+=(--exclude "$arg") ;;
      heavy) heavy_ok=1 ;;
    esac
  done <<< "$sel"
  echo "merge-branch: checks on $branch rebased onto build (${#tests[@]} test files + related to ${#related[@]} sources$([ "$heavy_ok" = 1 ] && echo ', browser tests included'))..." >&2
  ok=1
  if ! (cd "$wt" && "$sem" npm run -s typecheck); then ok=0; fi
  if [ "$ok" = 1 ] && [ "${#tests[@]}" -gt 0 ] && ! (cd "$wt" && "$sem" npx vitest run --reporter=dot "${tests[@]}"); then ok=0; fi
  if [ "$ok" = 1 ] && [ "${#related[@]}" -gt 0 ] && ! (cd "$wt" && "$sem" npx vitest related --run --reporter=dot --passWithNoTests "${excl[@]}" "${related[@]}"); then ok=0; fi
  if [ "$ok" != 1 ]; then
    echo "merge-branch: checks failed after rebasing onto build. Fix in $wt, commit, call again." >&2
    exit 5
  fi
fi

before="$(git -C "$main" rev-parse HEAD)"
git -C "$main" merge --no-ff -q -m "$msg" "$branch"
if ! git -C "$main" diff --quiet "$before" HEAD -- package-lock.json; then
  npm --prefix "$main" ci --no-audit --no-fund --silent
fi
echo "merge-branch: merged $branch into build at $(git -C "$main" rev-parse --short HEAD)"
