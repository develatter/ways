# Repository map

- Product overview and commands: `README.md`
- Planned milestones: `docs/ROADMAP.md`
- Next-agent context and current caveats: `docs/HANDOFF.md` when present
- Runtime implementation: `src/`
- Bootstrap templates and schemas: `assets/`
- Automated verification: `tests/`
- Harness configuration and state: `.ways/config.json`, `.ways/state/`, derived `.ways/status.json`
- Managed Git hooks: `.ways/hooks/`
- Provider adapters rendered from the harness canonical source: `.claude/` and siblings
- Outcome work (default) and its attempts: `.ways/outcomes/`
- Plans and legacy SDD artifacts: `.ways/plans/`, `.ways/sdd/`
- Architecture decisions: `docs/decisions/`
- Current OKF knowledge, coverage and watermark: `.ways/knowledge/`
- Discovery, semantic reviews and release reconciliation evidence: `.ways/memory/`, `.ways/reconciliations/`
- Disposable derived search cache: `.ways/indexes/`
- Canonical local and CI check: `scripts/check.sh`
