---
title: Get a review, and an approval
kind: how-to
sources:
  - src/work/review.ts
  - src/work/policy.ts
  - src/work/signature.ts
  - src/commands.ts
reviewed: 2026-10-29
source_hashes:
  src/work/review.ts: 283fd8bf61d5
  src/work/policy.ts: 08dda9672054
  src/work/signature.ts: 6ee11de63cd0
  src/commands.ts: ed6b4c0f3337
---

# Get a review, and an approval

After `ways done` passes, a work may still wait for an independent review, for a human approval, or both. `ways done` and `ways status` say which, and the command to run.

## The independent review

```sh ways-check
npx ways review
npx ways review --agent=pi
npx ways review --print
```

`ways review` builds the prompt itself: the criteria, the evidence ways recorded, and the diff of the evaluated commit, with nothing of the implementer's reasoning. It starts the reviewer as a new process that has read-only tools, reads the verdict from that process's own output and records it. The agent that did the work never holds the review, so it cannot edit it. When nothing else is missing, the work closes.

Which reviewer runs:

1. `--agent=claude` or `--agent=pi`, if you pass it.
2. Otherwise what the **base** commit's `.ways/config.json` says: `"reviewer": {"command": ["my-reviewer", "--flag"]}` (the prompt goes on stdin and a review JSON comes back on stdout) or `"reviewer": {"agent": "claude"}`. A work cannot pick its own reviewer by editing that file, because the base's setting is the one used.
3. Otherwise the agent ways is running under, if it can tell.

If none of those apply, `ways review` says so and what to set. `--print` shows the prompt and the commands without running anything, for launching the reviewer somewhere else.

In Claude Code the `ways-reviewer` subagent works too: ways hands it the same prompt when it starts and records its final answer when it stops, but only if its tool calls show no writes.

What a review can say: a verdict, and findings with a severity. Only `critical` and `high` findings block; `medium` and `low` are recorded and shown. A finding can also accept a changed existing test (see below). A review applies to one commit: a new `ways done` on a later commit drops it.

## When a person must approve

A human approval is needed when:

- the work was opened with `--approval=required` (or the config says `"approvals": {"criteria": "required"}`), or
- the work removes or changes lines of an existing test, skips or focuses tests, touches the check configuration, or runs fewer tests than its base did, and no independent review accepted it. A review accepts by naming the file in a finding's `accepts` list, and only a review that ways launched can. Adding tests never needs anything, also to an existing test file. The exact rule is in [docs/VERIFICATION.md](../../VERIFICATION.md#what-needs-approval-on-the-verifier-surface), or
- the required review was typed in at a terminal (see below).

The human runs this in their own terminal, never the agent:

```sh ways-check
npx ways approve
npx ways approve --key=~/.ssh/id_ed25519_sk
```

It refuses without an interactive terminal, shows the criteria, the evidence and the review, asks you to type the work id, and closes the work if nothing else is missing. Approval comes last: if a review is also needed, `ways approve` asks for it first.

To sign approvals, put the human's SSH public key in `.ways/allowed_signers` in its own reviewed commit, with the namespace `ways-approval`:

```text
alex@example.com namespaces="ways-approval" sk-ssh-ed25519@openssh.com AAAA...
```

The signature is checked against that file as committed in the work's base, so the change being approved cannot add its own key. With `"approvals": {"signature": "required"}` an unsigned approval does not count, and no review can stand in for one on a test change. Use a hardware key (`ed25519-sk`): a key an agent can use can sign for the agent too. To sign somewhere else, `ways approve --payload` prints what to sign and `ways approve --signature=<file>` records the result.

A review typed in by a person at a terminal (`ways review submit <file>`) never accepts a test change, and it satisfies a required review only together with the person's approval: a pseudo-terminal would give an agent the same terminal. Run `ways approve` right after it.
