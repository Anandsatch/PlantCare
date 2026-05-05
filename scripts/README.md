# Merge automation scripts

These scripts automate merging a queue of autonomous-build PRs (e.g. from a /v1-autonomous-push session) where every PR touches the same three files in mechanically deterministic ways — `VERSION`, `CHANGELOG.md`, and one or more barrel `index.ts` files. Without automation, merging 19+ PRs in a row produces tedious one-at-a-time conflict resolution. With these, the queue drains in ~10 minutes.

## Files

- **`resolve_pr_conflicts.sh`** — auto-resolves the three known conflict surfaces:
  - `VERSION`: take the branch's value (always monotonically higher than main's)
  - `CHANGELOG.md`: stack the branch's NEW top block above main's existing top block
  - `*/index.ts` (barrel): union of unique export lines (main's first, branch's appended, dedup'd)
- **`merge_via_cherrypick.sh`** — cherry-picks the branch's unique commit onto main, runs the resolver if there are conflicts, force-pushes, waits for GitHub mergeability, then squash-merges. Works for both base-on-main and stacked-on-other-PR branches (it cherry-picks just the unique commit; the squash-merged base content already on main is implicitly skipped).

## Invariants the scripts assume

These are the guardrails that make automation safe. Break any of them and the merge can corrupt main:

1. **Each PR contains exactly ONE unique commit relative to its base** — the agent's single `git commit -am` after their work. The scripts cherry-pick the newest commit (`git rev-list ... | head -1`); if a PR has multiple unique commits they'll be silently dropped.
2. **VERSION is monotonically increasing** — the branch's value > main's value. If a branch was created before another that already merged with a higher VERSION, the branch's PR title and CHANGELOG entry need to be edited up to match the next available slot before running the script.
3. **CHANGELOG entries are formatted as `## [X.Y.Z] - YYYY-MM-DD`** — the resolver's regex relies on this. The version is in brackets; the date follows after a hyphen.
4. **Barrel files match the glob `*/index.ts`** — only `index.ts` files in subdirectories are auto-merged as barrels. Top-level `index.ts` (e.g., apps/mobile/index.ts) won't trigger the barrel logic.
5. **No semantic conflicts** — two PRs adding the same import path to a barrel, or the same key to a config file, get the union (no error). If two PRs add the *same name* with *different content*, the union approach silently picks one. The scripts assume agents in the autonomous-build session were each writing unique files.

## Usage

```bash
# Single PR
scripts/merge_via_cherrypick.sh 123

# Loop a wave (in version order to keep main monotonic)
for pr in 9 11 14 12 13 15 17 16 20 18 19 21 22 23 25 24 26 27; do
  scripts/merge_via_cherrypick.sh "$pr"
done
```

After running, **always sync your working tree to origin/main and re-run typecheck + tests** before continuing — the resolver caught one barrel-merge edge case in PR #22 of the v0.1.7→v0.1.26 merge wave (the markers reached main and broke typecheck). A 6-line hotfix PR cleaned it up; a future iteration of the resolver could harden against this.

## Known limitations

- **Single-commit PRs only** (see invariant 1). Multi-commit feature branches need manual rebase.
- **Synchronous loop** — sleeps 4-24 seconds between push and merge to let GitHub recompute mergeability. With strong network, can be tightened.
- **No rollback** if a merge succeeds but the next PR's rebase fails — main is now ahead of where the loop expected. Script bails with an error; user picks up manually from there.
- **`--delete-branch` not used** — leaves remote branches behind for traceability. Clean up manually with `gh api -X DELETE repos/:owner/:repo/git/refs/heads/<branch>` or via the GitHub UI.
