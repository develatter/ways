---
title: How verification works
kind: explanation
sources:
  - src/work/evaluate.ts
  - src/check/sandbox.ts
  - src/work/policy.ts
  - src/work/verify.ts
  - src/domain/constants.ts
reviewed: 2026-10-29
source_hashes:
  src/work/evaluate.ts: 07fc688ed0ce
  src/check/sandbox.ts: 52520ed18752
  src/work/policy.ts: 08dda9672054
  src/work/verify.ts: 7b677ecf9c3e
  src/domain/constants.ts: c77b27ca061a
---

# How verification works

The aim is that the agent cannot call something done that is not. So the evidence of "done" is produced by ways, not reported by the agent, and the one statement a person reviews is short: one line per criterion, with the command that verifies it and how strong that command is.

## The ladder of verifiers

A criterion names its verifier and its strength. Prefer the strongest one you have; ways records which it was.

| Strength | Meaning |
| --- | --- |
| `proof` | a formal proof checker |
| `property` | a property-based test |
| `test` | an example-based test (the default) |
| `e2e` | an end-to-end run |
| `review-only` | nothing executable |

A criterion without a verifier, or whose verifier already passes on the base, is `review-only`: it cannot show that the work changed anything, so it forces an independent review. The evidence says what backs a delivery, for example `Backed by: 1 property, 2 test, 1 review-only`. A review-only criterion is where a person should look first.

## What `ways done` does

1. **A clean checkout.** It checks the committed HEAD out into a reusable Git worktree outside the working tree (under the temporary directory, in `ways-eval/`), so that a stale build or a scratch file the agent left never reaches the checks. With `setup` configured it prepares dependencies there and runs it again only when the setup command or a lockfile changes; without it, the dependency folders of the agent's checkout (`node_modules`, `.venv`, `venv`) are linked in and the evidence says so. `--fast` runs in the working tree instead and leaves the clean run to CI.
2. **The base's checks.** The check configuration is read from the commit where the work started, not from the increment. Changing the test command to `["true"]` in the work does not make it pass.
3. **Every verifier, red to green.** Each must pass on the commit and fail on the base. The base run happens once per base and is remembered.
4. **Retries, not luck.** A failing check or verifier runs again up to twice before the failure is recorded; a pass after a failure is recorded as flaky.
5. **The verifier checkpoint.** What the work does to the verifier paths (tests, test-runner and CI configuration, `.ways/config.json`, `package.json`, and the like; the list can be overridden) is judged by what changed inside each file: removing or changing existing lines, deleting a test file, adding a line that skips or focuses tests, and adding or changing check configuration, together with a drop in the number of tests the test check ran compared with the base, need a person's approval or an independent review that accepts them by name. Adding tests is free, also to an existing test file. The exact rule is in [docs/VERIFICATION.md](../../VERIFICATION.md#what-needs-approval-on-the-verifier-surface).
6. **The evidence.** For every check and verifier: the command, the exit code, the duration, a digest of the output and its last lines, the attempts, and where it ran. The agent adds at most a note per criterion.

The work closes when the evidence passed for the exact tree being closed, a required review does not block, and a required approval is valid. Otherwise it waits, and `ways done` prints the next command.

## Reviews and approvals

An independent review counts only if ways recorded where it came from: a process it started with read-only tools, or the Claude Code subagent it handed the prompt to. A review a person typed in at a terminal counts only with that person's approval, because a pseudo-terminal would give an agent the same terminal. A review has a verdict and findings; only `critical` and `high` findings block. A human approval records a digest of the criteria, the policy, the evidence and the review (and is signed over it when the person's key is configured), so it cannot be moved to different work. [Get a review, and an approval](../how-to/review.md) shows how to ask for each.

## In CI

`ways verify --base=<sha>` is the same judgement without trusting anyone's machine: it re-runs the base's checks on the head and every criterion's verifier of the works the range touched, requires every weakened test or check file in the range to be covered by a closed work that got that very content approved or accepted (which catches an agent that edited a test and never ran `ways done`, or edited it again after the approval), and audits the records. Locally an agent can bypass hooks; here it cannot. See [What ways guarantees](guarantees.md).

## Why it is built this way

Specifications of many pages are not read by the person who should review them, and checking an agent's work by reading its diff does not scale. Reviewing a handful of one-line criteria does, if each is backed by something executable and the strongest available verifier is used. Where no executable verifier exists, the criterion says so and a review stands in, instead of a green mark that means nothing.
