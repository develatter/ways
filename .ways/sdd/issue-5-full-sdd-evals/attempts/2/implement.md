# implement

Goal: Resolve the attempt-1 review findings R1, R2 and R3.
Evidence: R1/R2: `gradeFullSddCompliance` no longer trusts committed state files. It replays the task work's own certifications and remediations: product paths may change only in task commits made while implement is the next phase (`eval-change-outside-implement`), and any task commit after close is `eval-commit-after-close`; the state file joins the protected harness paths. Tests reproduce both bypasses (hooks-disabled change after review with an empty implement; forged state plus change after close) and a post-close config weakening. R3: `fullSddCompleted` is again `compliant` with the task work closed, matching certified spec decision 3; docs updated, including the documented local limit that a fully forged certification chain cannot be proven locally. `npm test`: 201 passed; `ways check --history` reports only the pre-existing untraced merge commits 7ae1a35, 5ec67d6 and 68715ac on master.
Decision: Findings addressed with tests; ready for fresh review.
Gate: Ready for independent review.
