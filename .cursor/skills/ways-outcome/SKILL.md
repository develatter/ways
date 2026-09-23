---
name: ways-outcome
description: Default delivery; constrains the verified result, not the reasoning steps
disable-model-invocation: true
---

Arguments: `<id> [goal]`

Run `npx ways status --json`; if work is already active, stop and report it. Otherwise run `npx ways outcome open <id> --goal=<text> --criterion=<ID>:<text>...` with the first word of the arguments the human gave with this skill as the slug and stable, checkable criteria from the rest of the request; ask the human only for policies they want to change (`--isolation`, `--parallel`, `--evaluation`, `--memory`, `--approvals`). Exploring, planning and splitting are optional: do them only when useful.
Execute through tasks: `npx ways task add <id> --title=... [--depends=a,b]`, `npx ways task prepare <id>`, implement in its worktree yourself or with ways-implementer (independent tasks may run in parallel), then `npx ways task integrate <id> --commits=...`. Keep sourced durable knowledge in the task commits when it changes.
Map every criterion in `.ways/outcomes/<id>/attempts/<n>/evidence.json`, run `npx ways outcome evaluate`, and, unless the evaluation policy is `self`, give ways-reviewer the digest from `npx ways review digest` for a review it records with `npx ways review submit`; with `--memory=high` do the same with `npx ways outcome memory-review digest|submit`. Then run `npx ways outcome close`. `npx ways context` resumes a fresh session.
After a failed evaluation or blocking review run `npx ways outcome remediate --reason=<text>` and fix it through new tasks; never edit earlier attempts. At a gated checkpoint ask the human to run `npx ways approve <checkpoint>` in their own terminal; never touch `approvals/` or `reviews/`. If the human asks to drop the work, run `npx ways outcome cancel`.
