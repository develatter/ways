# implement

Goal: Resolve attempt-4 review finding R7.
Evidence: Replace refs and grafts substitute history under every git command, including the shared history audit, so `gradeFullSddCompliance` now rejects any `refs/replace/*` ref or `info/grafts` file in the eval repository as `eval-history-rewritten` and skips auditing substituted history; the result assembly moved into `complianceResult`. Tests reproduce the reviewer's replace attack and the grafts variant. Docs updated. `npm test` passes; `ways check --history` reports only the pre-existing untraced merge commits 7ae1a35, 5ec67d6 and 68715ac on master.
Decision: R7 addressed with tests; ready for fresh review.
Gate: Ready for independent review.
