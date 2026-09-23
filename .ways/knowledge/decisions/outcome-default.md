---
type: decision
status: draft
generated: { by: orchestrator/issue-17-outcome-default, at: 2026-09-23T21:10:00Z }
sources:
  - resource: /docs/decisions/0001-outcome-default.md
  - resource: /src/work/sdd.ts
  - resource: /src/upgrade/upgrade.ts
  - resource: /assets/bootstrap/AGENTS.md
  - resource: /assets/adapters/commands/outcome.md
---

# Outcome work is the default

The human maintainer made outcome work (`ways outcome open`, with `ways quick` for small changes) the default for new work and deprecated SDD. The decision rests on structural trade-offs and fixture-only eval evidence; real-model comparative runs are still expected to confirm it.

`ways sdd start` and `ways plan promote` keep working and print a deprecation notice. Active SDD work finishes under its original workflow and assurance policies, and SDD readers and verifiers stay for historical audit. Upgrade never rewrites certifications, approvals, reviews or remediation history, reports active SDD work as allowed to continue, and refuses to apply over unreadable or Git-divergent state.

Exploration, planning and decomposition are optional capabilities, not outcome states.
