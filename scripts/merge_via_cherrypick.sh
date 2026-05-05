#!/bin/bash
# Cherry-pick a PR's unique commit(s) onto main, resolving mechanical conflicts.
set -e
pr="$1"
branch=$(gh pr view "$pr" --json headRefName -q .headRefName)
echo ">>> PR #$pr branch=$branch (cherry-pick)"

git fetch origin "$branch" --quiet
git fetch origin main --quiet
git checkout -B "merge/$pr" origin/main --quiet

# Cherry-pick the newest unique commit (the agent's single ticket commit)
unique=$(git rev-list --topo-order "origin/main..origin/$branch" | head -1)
[ -z "$unique" ] && { echo "    no unique commit"; exit 0; }
echo "    cherry-pick $unique"

if ! git cherry-pick "$unique" >/dev/null 2>&1; then
  /tmp/resolve_pr_conflicts.sh
  GIT_EDITOR=true git -c core.editor=true cherry-pick --continue >/dev/null 2>&1 || \
    git commit --no-edit >/dev/null 2>&1
fi

# Confirm clean
if git status --porcelain | grep -q .; then
  echo "    DIRTY after cherry-pick — aborting" >&2
  git cherry-pick --abort 2>/dev/null || true
  exit 2
fi

git push --force-with-lease origin "merge/$pr:$branch" --quiet
echo "    pushed; HEAD=$(git rev-parse --short HEAD)"

# Wait for GitHub to recompute
for attempt in 1 2 3 4 5 6; do
  sleep 4
  state=$(gh pr view "$pr" --json mergeable --jq '.mergeable')
  [ "$state" = "MERGEABLE" ] && break
done
out=$(gh pr merge "$pr" --squash 2>&1 || true)
echo "    merge: $out"
