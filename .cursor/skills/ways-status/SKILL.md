---
name: ways-status
description: Show the active harness work, mode and phase
disable-model-invocation: true
---

Run `npx ways status --json` and summarise mode, id, stage or phase, profile and whether a human gate or approval is pending. When `attempt` and `remediation` are present, report the reopened attempt and its source/target/reason. For a fuller resumable picture run `npx ways context`. If nothing is active, say so and list the ways to open work: /ways-outcome (default), /ways-quick for a small change, /ways-plan for a proposal. Closing, cancelling and advancing are done by you through the CLI, never by the human.
