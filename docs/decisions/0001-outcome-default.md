# 0001 — Outcome work is the default; SDD is deprecated

- Status: accepted
- Date: 2026-09-23
- Decided by: the human maintainer (explicit decision, not derived from a benchmark)
- Issue: #17 (parent #2)

## Decision

New work opens with `ways outcome open` (or `ways quick start` for a small change). The phased SDD workflow is deprecated: `ways sdd start` and `ways plan promote` still work but print a deprecation notice, and existing SDD work finishes under its original workflow and assurance policies. Legacy SDD readers and verifiers (the commit hook, `ways check --history`, repair, validation replay, approvals and remediation records) stay in place for historical audit.

## Measured evidence available so far

Only deterministic fixture evidence exists. The comparative eval framework (#16) is landing in parallel; its runner and grader are exercised in CI with synthetic adapters, whose reports state `architecturalClaim: false` (see [EVALS](../EVALS.md)). No real-model comparison of full SDD (D) against the lightweight-state (C) and simplified execute/evaluate (E) configurations has been recorded yet, so this decision does not cite success, cost, time or compliance numbers. Real-model comparative runs following the #16 instructions should confirm it; if they show that the outcome default loses task success or assurance against full SDD, revisit this record.

## Trade-offs (structural, verifiable in the code)

| Aspect | SDD (legacy) | Outcome (default) |
| --- | --- | --- |
| Mandatory machine states | 11 certified phases: intake, explore, assess, specify, plan, decompose, implement, review, validate, reconcile-memory, close | `open → execute → evaluate → close`, plus `remediate` after a recorded failure |
| What is constrained | How the agent reasons (a phase file per step) | What must be externally true: immutable goal and criteria, per-criterion evidence, the environment check contract |
| Isolation | Delegated mode: orchestrator never edits production code | `--isolation=required` (default) or `optional`, with `--parallel=allowed|disabled`; no prescribed agent roles |
| Independent review | Mandatory review phase | `--evaluation=independent` (default) binds a review to the evaluated increment; `self` is an explicit weaker choice |
| Human approvals | Supervised profile gates intake, plan and close | `--approvals=none|close|close,remediate`; no planning gates |
| Memory | Mandatory reconcile-memory phase | Tiers `none|normal|high`; `high` requires a bound memory review |
| Remediation | `sdd remediate` to a chosen earlier phase | `outcome remediate` opens a new attempt; earlier attempts are immutable |
| Resume | `ways status` | `ways context` packet with criteria, evidence, evaluation and blockers |

What outcome work gives up by default: explicit specify/plan artifacts and the intake/plan human gates. Exploration, planning and decomposition remain available as optional capabilities (`ways plan`, tasks with dependencies, the explorer role), not mandatory states.

## Compatibility

- `ways upgrade` re-renders managed files and adapters only; it never rewrites `.ways/sdd/`, `.ways/outcomes/`, state, approvals, reviews, validation failures or remediation records. Re-applying it is a no-op.
- `ways upgrade` reports an active SDD work as allowed to continue under its original workflow, and refuses to apply over unreadable or Git-divergent active state (diagnose with `ways repair diagnose`).
- The eval `full-sdd` (D) harness keeps driving SDD explicitly so historical comparisons stay reproducible.
