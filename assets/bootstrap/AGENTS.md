# Ways

- Read `README.md` and `MAP.md`; run `npx ways status` (or `npx ways context` to resume) before mutation.
- Obey the active mode and state. Never skip, forge, or edit a gate, evidence, review or approval.
- Open new work with `npx ways outcome open <id> --goal=<text> --criterion=<ID>:<text>`; a small change opens `npx ways quick start <id>`. Commits outside an active work are rejected.
- Outcome work: implement through task worktrees, map every criterion in the attempt evidence, run `npx ways outcome evaluate`, get an independent review bound to `npx ways review digest`, then `npx ways outcome close`; after a failure use `npx ways outcome remediate`. Exploring, planning and splitting are optional, never states.
- SDD is deprecated: finish active SDD work under its own workflow; start new SDD work only when the human asks.
- Advance, finish and cancel work through the CLI on the human's request; stop on divergence or failed checks.
- In this package, change `src/`, `assets/`, and `tests/`; never edit `dist/`.
- Keep commits atomic and run `scripts/check.sh` before completion.
- Treat `.ways/knowledge/` as durable current truth: keep sourced updates with the change that motivates them, never store progress there, and never require no-op memory artifacts.
- Complete reviewed discovery after bootstrap; run full rediscovery only on explicit request, and validate reconciliation before release.
- Derived `.ways/indexes/` are disposable caches; change managed files through source templates, then regenerate them.
