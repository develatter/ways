# implement

Goal: Implement the specified D harness, metrics, validity rules and comparison report.
Evidence: New `src/evals/ways.ts` (Ways install, revision capture, compliance grading from history/integrity/worktree), `src/evals/compare.ts` (validity, comparability, per-harness scores, artifact links, Markdown); runner, adapter protocol, types (result schema 2) and `ways evals compare` CLI updated; `docs/EVALS.md` and README document them. `tests/evals-full-sdd.test.ts` covers a real SDD lifecycle graded compliant, bypass via uncommitted work and `--no-verify` graded non-compliant while functionally successful, untouched baselines, comparison validity and CLI; `tests/evals.test.ts` covers metric parsing. `npm test`: 35 files, 195 tests passed. `ways check --history` fails only on the pre-existing untraced GitHub merge commits 7ae1a35, 5ec67d6 and 68715ac already on master, independent of this change.
Decision: Implementation complete as specified; the merge-commit history finding is reported to the human, not fixed in this work.
Gate: Ready for independent review.
