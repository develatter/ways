---
name: ways-plan
description: Versioned plan proposal that can be executed, escalated, or abandoned
disable-model-invocation: true
---

Arguments: `<id> [goal]`

Run `npx ways plan start <id>` with the first word of the arguments the human gave with this skill as the slug. Fill `.ways/plans/<id>.md` with goal, numbered steps and acceptance, then run `npx ways plan propose` and ask the human how to proceed. To execute: implement the steps, assess durable semantic impact progressively, use /ways-memory for any separately reviewed memory commit, run `scripts/check.sh`, then `npx ways plan finish --message="<subject>"`. To escalate: abandon the plan and open /ways-outcome; only when the human asks for deprecated SDD, run `npx ways plan promote [--supervised]` and continue as /ways-sdd. To drop: `npx ways plan abandon`.
