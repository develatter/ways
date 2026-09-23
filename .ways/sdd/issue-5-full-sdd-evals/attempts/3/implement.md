# implement

Goal: Resolve attempt-2 review finding R4 and lock in the legitimate-remediation behaviour noted in R5.
Evidence: The implement-window check now diffs every task commit against its first parent instead of `git diff-tree -r`, which printed nothing for merges, and any merge commit in the eval repository is `eval-merge-commit`. A test reproduces the evil merge after validate (bookkeeping side branch, product change staged into a hooks-off `--no-ff` merge) and grades it non-compliant with both codes. A new test drives a failed review, remediation back to implement and a fresh attempt-1 review through close, graded compliant with `remediationAttempts: 1` and no issues. Docs list the merge rule. `npm test`: 202 passed; `ways check --history` reports only the pre-existing untraced merge commits 7ae1a35, 5ec67d6 and 68715ac on master.
Decision: R4 addressed and R5 covered by tests; ready for fresh review.
Gate: Ready for independent review.
