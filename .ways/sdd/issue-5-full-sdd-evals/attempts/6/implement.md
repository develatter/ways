# implement

Goal: Resolve attempt-5 review findings R8 and R9.
Evidence: R8: the uncommitted-change check no longer uses `git status`. It walks the repository on disk (excluding `.git`, harness runtime output and the runner's node_modules links) and compares each file's Git blob id with `HEAD`'s tree from `ls-tree`, so skip-worktree, assume-unchanged, info/exclude and core.worktree cannot hide changes; missing tracked files also count. Tests cover all three reviewer reproductions. R9: window diffs use `--no-renames`; a test moves a product file into `.ways/sdd/` after review and gets eval-change-outside-implement. The two heaviest tests get a 60s timeout. Docs updated. `npm test`: 204 passed; `ways check --history` reports only the pre-existing untraced merge commits 7ae1a35, 5ec67d6 and 68715ac on master.
Decision: R8 and R9 addressed with tests; ready for fresh review.
Gate: Ready for independent review.
