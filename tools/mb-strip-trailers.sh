#!/usr/bin/env bash
# Remove AI attribution trailers from a task branch's own commits before tools/merge-branch.sh lands it.
#
#   tools/mb-strip-trailers.sh <worktree-root> <base>
#
# `build` becomes a public repository, so no commit landed on it may carry AI attribution. For every
# commit in <base>..HEAD of the worktree (never <base>'s own history) this drops the AI co-author trailer
# lines (any Claude model) and the session-link trailer lines (both case-insensitive, see `pattern`), then any blank lines left dangling at
# the end of the message. Commits without such lines keep their message byte for byte. Trees,
# parents outside the range, authors, committers and both dates are kept, so a branch with nothing
# to strip keeps every SHA. The branch is moved with update-ref; the worktree must be clean (the
# trees do not change, so nothing is checked out). Prints one line with the count.
set -euo pipefail

wt="${1:?usage: tools/mb-strip-trailers.sh <worktree-root> <base>}"
base="${2:?usage: tools/mb-strip-trailers.sh <worktree-root> <base>}"
pattern='^(co-authored-by:[[:space:]]*claude([^[:alnum:]_-]|$)|claude[-]session:)'

old_head="$(git -C "$wt" rev-parse HEAD)"
declare -A map=()
total=0 cleaned=0
msgfile="$(mktemp)"
trap 'rm -f "$msgfile"' EXIT

while read -r c; do
  [ -n "$c" ] || continue
  total=$((total + 1))
  # The message is everything after the first blank line of the raw commit object, byte for byte.
  git -C "$wt" cat-file commit "$c" | sed '1,/^$/d' > "$msgfile"
  if grep -qiE "$pattern" "$msgfile"; then
    # $(...) drops the trailing newlines, i.e. the blank lines the removed trailers leave dangling.
    kept="$(grep -viE "$pattern" "$msgfile" || true)"
    printf '%s\n' "$kept" > "$msgfile"
    cleaned=$((cleaned + 1))
    changed=1
  else
    changed=0
  fi
  parents=() moved=0
  for p in $(git -C "$wt" rev-parse "$c^@"); do
    if [ -n "${map[$p]:-}" ]; then parents+=(-p "${map[$p]}"); [ "${map[$p]}" != "$p" ] && moved=1
    else parents+=(-p "$p"); fi
  done
  if [ "$changed" = 0 ] && [ "$moved" = 0 ]; then map[$c]="$c"; continue; fi
  IFS=$'\x01' read -r an ae ad cn ce cd < <(git -C "$wt" log -1 --format='%an%x01%ae%x01%ad%x01%cn%x01%ce%x01%cd' --date=raw "$c")
  map[$c]="$(GIT_AUTHOR_NAME="$an" GIT_AUTHOR_EMAIL="$ae" GIT_AUTHOR_DATE="$ad" \
    GIT_COMMITTER_NAME="$cn" GIT_COMMITTER_EMAIL="$ce" GIT_COMMITTER_DATE="$cd" \
    git -C "$wt" commit-tree "$c^{tree}" "${parents[@]}" -F "$msgfile")"
done < <(git -C "$wt" rev-list --reverse --topo-order "$base..$old_head")

new_head="${map[$old_head]:-$old_head}"
if [ "$new_head" != "$old_head" ]; then
  git -C "$wt" update-ref -m "merge-branch: strip AI attribution trailers" HEAD "$new_head" "$old_head"
fi
echo "merge-branch: removed AI attribution trailers from $cleaned of $total commits"
