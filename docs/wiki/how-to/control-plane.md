---
title: See your agents and answer them
kind: how-to
sources:
  - src/serve/command.ts
  - src/serve/board.ts
  - src/inbox/commands.ts
  - src/commands.ts
reviewed: 2026-10-29
source_hashes:
  src/serve/command.ts: 8a12b06e80d6
  src/serve/board.ts: 9628da1d60cd
  src/inbox/commands.ts: e22dd8e17729
  src/commands.ts: 86ff1624a949
---

# See your agents and answer them

When several coding agents work at once, two questions come up: what is each one doing, and what is each one waiting on from me? `ways serve` answers the first on a local page; the inbox answers the second, from the page or from the command line.

## Look at the board

```sh ways-check
npx ways serve --open
npx ways serve --demo
```

It prints a URL with a one-time token and listens on `127.0.0.1` only (port 7420 by default; `--port=<n>` changes it). `--demo` shows made-up data, to see what the page looks like before any agent has run. Each `ways serve` adds the repository it runs in to `~/.config/ways/registry.json`, and the board shows every repository listed there; `--repo=<path>` adds another.

There is one card per worktree that has a ways work or an agent in it, placed in a column by what the work records, the last `ways done`, the agent hooks and the inbox say. Nothing is dragged by hand. The first rule that matches wins:

| Column | When |
| --- | --- |
| Done | the work is closed (cards stay for seven days) |
| Waiting for you | an inbox item is open about it, the agent ran `ways block`, a human approval is pending, or the agent's turn or session ended while the work is open |
| Blocked | the repository has a problem, no hook event for ten minutes while the agent had not stopped, or the last `ways done` failed and no agent is on it |
| Verifying | the evidence certifies HEAD and a review is pending |
| Working | an agent is active on it |
| Preparing | no commits since the work started, or an agent is active and there is no work yet |

A card shows the work and its goal, the agent, the session, the branch, the last thing the agent did, one bar per criterion, and why the card is in its column. An agent that ways launched for a job, such as the documentalist that [updates the wiki](wiki.md), carries that job as a badge.

## Answer what agents ask

An agent that needs a decision asks instead of guessing:

```sh ways-check
npx ways ask "Mock Stripe in CI, or will you add STRIPE_TEST_KEY?" --options=mock,key --wait=5m
```

Without `--wait` the question is posted and the agent carries on; with it, `ways ask` waits for the answer and exits `0` with it, `2` if still open (the answer then arrives through the hooks), or `3` if it expired or was closed. `--default=<option>` is what applies when a question expires unanswered, `--expires=30m` sets when, and `--json` gives machine-readable output.

You answer on the page, or:

```sh ways-check
npx ways inbox
npx ways inbox answer i-mabc12-1a2b3c4d mock
npx ways inbox close i-mabc12-1a2b3c4d --reason="no longer needed"
```

The agent gets each answer once, at its next prompt, stop or session start; the hooks add it to what the agent is told.

## Tell an agent something

```sh ways-check
npx ways inbox tell "Stream the export; it must stay under 2 s" --work=billing-export
```

An instruction goes to a session, a work or a worktree (`--session`, `--work`, `--worktree`) and is delivered once, the same way. Every inbox command takes `--json`, so an orchestrating agent can run this whole loop with nothing else. An answer to a question is advice to the agent, never a ways approval; an approval of a work is recorded only by `ways approve` (or by *Approve* on the board, where the repository does not require signatures).
