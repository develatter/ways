---
title: What ways guarantees
kind: explanation
sources:
  - src/hooks/hook.ts
  - src/hooks/guard.ts
  - src/integrity/history.ts
  - src/work/policy.ts
  - src/config/config.ts
reviewed: 2026-10-29
source_hashes:
  src/hooks/hook.ts: bf698ab3883e
  src/hooks/guard.ts: 4d3ff1f5e49b
  src/integrity/history.ts: 7dc05c41c7b6
  src/work/policy.ts: 5cdc82f1e53d
  src/config/config.ts: 073d361893c0
---

# What ways guarantees

ways does not tell an agent how to work. The agent chooses; ways gives it context, checks the result and writes the evidence itself, and refuses only what would break a guarantee. Everything else is allowed, because every extra command, file or approval a harness asks for is a cost paid on every task, and a harness that costs too much gets switched off.

So the question for each rule is: what real guarantee does it buy that a hook, the CI or the agent could not already give? The guarantees that survived that question:

| Guarantee | How it is kept |
| --- | --- |
| The definition of done does not move | The goal and criteria are committed when an outcome opens. The commit hook refuses a commit that adds, changes or deletes a work record by hand, in every mode; the agent guard refuses the edit before it is made; the history audit flags a record whose criteria changed after they were opened. |
| Evidence is the harness's | `ways done` runs the checks and writes the evidence for the exact commit and tree it ran on. The agent can add a note per criterion and nothing else. The audit refuses evidence that names another commit, another tree or other commands than the base's check configuration. |
| A criterion shows the work did something | Its verifier must fail on the base and pass on the commit; otherwise the criterion counts as review-only and needs an independent review. |
| Tests are not weakened silently | Modifying or deleting an existing test or check file, or running fewer tests than the base did, needs a human approval or an independent review that accepts it by name. Adding tests needs nothing. |
| Reviews are independent | Only a reviewer that ways started, with read-only tools, or the subagent it handed the prompt to, counts. ways records the answer itself. |
| Approvals come from a person | `ways approve` needs a real terminal. With the person's SSH key in `.ways/allowed_signers`, the approval is signed and CI re-verifies the signature; the policy can require one. |

## What is not blocked

An ordinary commit is never refused for lacking ceremony. In the default `observe` mode the hook adds a `Harness-Work` trailer (starting a change named after the branch if none is active) and refuses only the hand-made record. Setting `"enforcement": "enforce"` in `.ways/config.json` additionally makes the commit hook refuse a commit outside an active work, and the agent guard refuse a shell command that switches the commit hooks off. How an agent gets to done, how many commits it makes, and which tools it uses are its own choice.

## Locally you can bypass; CI cannot be

Everything above runs on the machine of the agent, as the same user with the same shell. An agent with a shell can set `WAYS_DISABLE=1`, point `core.hooksPath` elsewhere, or rewrite history. So the hooks are early feedback, and **the CI is the final judge**: the job that `ways bootstrap` writes runs `ways verify` on every pull request, re-running the base's checks and every criterion's verifier from scratch and auditing the records. Make it a required check on protected branches.

## What it does not guarantee

- A verifier is only as good as its test. An agent can write a new test for its own criterion that is red before and green after without testing the criterion. Writing the criteria so that a person can read them in thirty seconds, labelling the verifier's strength, and the independent review are the mitigation; mutation testing is not built in.
- A key an agent can use can sign. Only a hardware key that needs a touch per signature separates the person's approval from the agent's.
- A review's provenance is local: it is as strong as the hooks that recorded it, and an agent with a shell could fake one. With signed approvals required, a review is not accepted for a test change at all.

The mechanics are in [How verification works](verification.md).
