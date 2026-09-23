# implement

Goal: Resolve attempt-3 review finding R6.
Evidence: `gradeFullSddCompliance` no longer anchors on the manifest introduction, which an agent can rewrite. It requires the runner-recorded bootstrap revision to still be an ancestor of HEAD (`eval-history-rewritten` otherwise) and audits exactly startRevision..HEAD. A test reproduces the hooks-off amend of the bootstrap commit followed by an empty-implement SDD through close, and grades it non-compliant. Docs state the ancestry rule. `npm test` passes; `ways check --history` reports only the pre-existing untraced merge commits 7ae1a35, 5ec67d6 and 68715ac on master.
Decision: R6 addressed with a test; ready for fresh review.
Gate: Ready for independent review.
