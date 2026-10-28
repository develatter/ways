# Repository map

Describe your project here: what it is, where its code, tests and docs live, and how to run it. The harness paths below are managed by ways.

- Harness configuration and state: `.ways/config.json`, `.ways/state/`, derived `.ways/status.json`
- Managed Git hooks: `.ways/hooks/`
- Agent adapters rendered by ways: `.claude/`, `.agents/`, `.cursor/`, `.pi/`
- Outcome work (default) and its attempts: `.ways/outcomes/`
- Plans and legacy SDD artifacts: `.ways/plans/`, `.ways/sdd/`
- Current OKF knowledge, coverage and watermark: `.ways/knowledge/`
- Discovery, semantic reviews and release reconciliation evidence: `.ways/memory/`, `.ways/reconciliations/`
- Disposable derived search cache: `.ways/indexes/`
- Canonical local and CI check: `scripts/check.sh`
