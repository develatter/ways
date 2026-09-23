# implement

Goal: Resolve the scoped attempt-6 review by simplifying the compliance grader to the honest-agent threat model.
Evidence: F1/F2: removed the implement-window replay, content-hash worktree walk, merge, replace/graft and ancestry checks that misgraded honest runs (memory/discovery commits, ignored local tool files). Compliance now combines the history audit and integrity from the bootstrap revision, the task SDD work closed, foreign works, downgrades, harness-file changes, `git status` and an active work; `fullSddCompleted` equals `compliant`. F3: harness prompts no longer contradict stop-and-resume tasks. F4: a full-sdd task failing before grading reports `eval-compliance-error`. Adversarial tests for out-of-scope Git subversion were removed; a harness-weakening test replaces them. Docs state the threat model. `npm test`: 202 passed; `ways check --history` reports only the pre-existing untraced merge commits on master.
Decision: Findings F1-F4 addressed by simplification; F5 and L1 accepted.
Gate: Ready for independent review.
