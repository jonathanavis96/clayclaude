#!/usr/bin/env bash
# Create (or reuse) a task worktree under .worktrees/<name> on branch <branch>,
# branched from the current tip of `build`, with node_modules installed.
#
#   tools/wt-new.sh <name> <branch>
#
# Prints the worktree's absolute path on the last line.
set -euo pipefail

name="${1:?usage: tools/wt-new.sh <name> <branch>}"
branch="${2:?usage: tools/wt-new.sh <name> <branch>}"
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
wt="$main/.worktrees/$name"

if [ -d "$wt" ]; then
  echo "wt-new: reusing $wt" >&2
elif git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$main" worktree add -q "$wt" "$branch"
else
  git -C "$main" worktree add -q "$wt" -b "$branch" build
fi
if [ ! -d "$wt/node_modules" ]; then
  npm --prefix "$wt" ci --no-audit --no-fund --silent
fi
if [ -f "$main/tools/tablet.env" ] && [ ! -f "$wt/tools/tablet.env" ]; then cp "$main/tools/tablet.env" "$wt/tools/tablet.env"; fi
echo "$wt"
