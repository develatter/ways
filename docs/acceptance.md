# Acceptance criteria

What a repository gets from `ways bootstrap`, written from the consumer's side. Each line is checked by the test suite of this package.

1. Quick work creates no committed planning or progress artifacts.
2. State survives interruption; Git divergence fails closed until explicit repair (`ways repair diagnose`).
3. Outcome work cannot close without evidence for every criterion, a passing evaluation of the configured checks (run again at close) and, unless opened with `--evaluation=self`, a review bound to the current diff digest.
4. Parallel tasks use isolated worktrees and traced atomic commits (isolation is required unless opened with `--isolation=optional`).
5. Only `critical` and `high` review findings block close; `medium` and `low` are recorded and shown.
6. A review is accepted only with the current content digest and goes stale if the content changes afterwards.
7. A gated checkpoint only advances with a human approval bound to work, checkpoint, attempt and content digest; `ways approve` refuses without a TTY and any later edit invalidates it.
8. A failed evaluation or blocking review reopens only through `ways outcome remediate`; each remediation is additive and keeps earlier attempts.
9. Stable OKF concepts require verification; stale indexes fail integrity.
10. Bootstrap is reproducible on Linux/macOS, writes nothing that points at the ways repository itself, and makes `CLAUDE.md` import `AGENTS.md`.
11. Upgrades never overwrite modified managed files without checklist approval.
12. `scripts/check.sh` is the canonical local and CI entrypoint.
13. A commit outside an active work is rejected by the managed hook and, if the hook is bypassed, by `ways check --history`.
14. `.ways/status.json` always mirrors `current.json`; a stale artifact fails integrity.
15. Bootstrap renders every registered provider adapter from the package's canonical source; tampering with a rendered file fails integrity.
16. No role prompt exceeds six non-empty lines; loading the canonical source enforces it.
17. The provider guard blocks tool writes to approvals and review verdicts, and to main-worktree production files during isolated execution; `2>&1` and `>/dev/null` are not treated as writes.
18. `ways --help` lists every command and `ways <command> --help` shows its usage and examples.
