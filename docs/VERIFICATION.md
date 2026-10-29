# Verification

How ways decides that a piece of work is done, what that guarantees, and what it does not. The short version: **the harness produces the evidence, not the agent; locally ways makes shortcuts visible and expensive; the CI (`ways verify`) is where they are refused for good.**

## What "done" means

A delivery (`ways outcome open`) is a goal plus one-line criteria. Each criterion names its verifier, an executable command, and how strong that verifier is:

| Strength | Meaning | How ways sets it |
| --- | --- | --- |
| `proof` | A formal proof checker | `--strength=AC1:proof` |
| `property` | A property-based test | `--strength=AC1:property` |
| `test` | An example-based test | default for `--verify` |
| `e2e` | An end-to-end run | inferred when the command mentions `e2e`, `playwright` or `cypress` |
| `review-only` | Nothing executable | a criterion without `--verify` |

`outcome open` prints the criteria and verifiers as one short block: that is what the human reviews, not the diff. A small change (`ways start`, or just commits) has no criteria; its judge is the check suite.

## What `ways done` does

1. **A clean checkout.** It checks the committed HEAD out in a reusable worktree outside the working tree (`$TMPDIR/ways-eval/<repo>/checkout`), removing every untracked and ignored file except dependency directories. Nothing the agent left in its own checkout (a stale build, a scratch file) reaches the checks. With `commands.setup` configured it runs there, and again only when the setup command or a lockfile changes; without it, `node_modules`, `.venv` or `venv` of the working tree are linked in and the evidence says so. `--fast` (or `"evaluation": "fast"`) runs in the working tree instead and leaves the clean run to CI.
2. **The base's checks.** It runs the check contract (`testCommand`, `commands`) as committed in the work's base, not as the increment left it: changing `testCommand` to `["true"]` does not make the work pass.
3. **Every verifier, red to green.** Each criterion's verifier must pass on the input and fail on the base (run once per base and cached). One that already passes on the base does not show the work did anything: the criterion counts as `review-only`, which makes the independent review mandatory.
4. **Retries, not luck.** A failing check or verifier runs again up to twice before the failure is recorded. A pass after a failure is recorded as flaky in the evidence and goes to the quarantine `ways status` shows.
5. **The verifier surface.** Existing files under `verifierPaths` (tests, test-runner and CI configuration, `.ways/config.json`, `.ways/allowed_signers`, `package.json` scripts) that the increment modifies or deletes, the script a criterion's verifier runs, and a drop in the number of tests the test check ran against the base (the ratchet), form the *verifier checkpoint*. Adding tests is free. The checkpoint needs the human's approval, or an attested independent review that accepts each entry (`"accepts": [...]` in a finding) when `approvals.verifierChanges` is `human-or-review` (the default).
6. **The evidence.** For every check and verifier: command, exit code, duration, sha256 of the output, the last lines, attempts, an execution id the criterion cites (`AC1`, `AC1@base`), and the runner (clean or not, platform, Node, ways version, how dependencies got there, whose contract ran). The only thing the agent adds is a note per criterion (`ways done --note=AC1:...`). A summary says what backs the delivery: `Backed by: 1 property, 2 test, 1 review-only.`

The work closes when the evidence passed for the closed tree, any required review is attested and does not block, and any required approval is valid. Otherwise it is *verifying* and `ways done` prints the exact next command.

## The independent review

A review counts only with a provenance ways recorded itself; nothing the agent writes can claim one.

- **`ways review`** builds the prompt (the criteria, the evidence ways recorded and the diff of the evaluated commit; nothing of the implementer's reasoning), launches the reviewer as a new process limited to read-only tools, reads the verdict from that process's own output and records it. Presets: `claude -p --tools Read,Grep,Glob --permission-mode dontAsk --no-session-persistence --session-id <uuid>` and `pi -p --no-session --no-extensions --tools read,grep,find,ls`; `"reviewer": {"command": [...]}` configures another (prompt on stdin, review JSON on stdout). `ways review --print` shows the prompt and the commands without running them.
- **Claude Code's `ways-reviewer` subagent.** Its definition has only `Read, Grep, Glob`. The `SubagentStart` hook hands it the same prompt; `SubagentStop` records its final answer, but only if ways started it with that prompt and the hook events of that subagent (`agent_id`) show no write tool. The implementer never holds the review, so it cannot edit it.
- **A human** can record a review file with `ways review submit <file>` at an interactive terminal.

Only `critical` and `high` findings block; `medium` and `low` are recorded and shown. Any new `ways done` drops a review of an older commit.

## Human approvals

Needed when the work was opened with `--approval=required` (or `approvals.criteria: required`) and for the verifier checkpoint when no attested review accepted it. `ways approve` shows the criteria, the evidence and the review, asks for the work id at an interactive terminal and, when a key is configured, signs:

```text
ways-approval v1
work: <id>
input: <evaluated commit>
digest: <sha256 of criteria, policy, evidence and review>
```

with `ssh-keygen -Y sign -n ways-approval`. The signature is verified against `.ways/allowed_signers` **as committed in the work's base**, so the change being approved cannot add its own key. Keys come from `--key=<file>` or Git's SSH signing key (`gpg.format=ssh`, `user.signingkey`). `ways approve --payload` prints the payload to sign elsewhere and `ways approve --signature=<file>` records such a signature without a terminal. With `"approvals": {"signature": "required"}` an unsigned approval does not count, and `ways check --history` and `ways verify` re-verify every signature.

```text
# .ways/allowed_signers (committed, in its own reviewed commit)
alex@example.com namespaces="ways-approval" sk-ssh-ed25519@openssh.com AAAA...
```

## The legitimate exit

When the task cannot be done as asked (the test contradicts the requirement, a secret is missing, the criteria are ambiguous), the right end is `ways block "<what is missing; what would unblock it>"`: it records the reason in the work, the human is told at the end of the agent's turn, and a later passing `ways done` clears it. In ImpossibleBench, offering such an exit cut cheating sharply; ways points at it whenever `ways done` fails.

## In CI: `ways verify`

```bash
ways verify --base=<sha> [--head=<sha>] [--in-place] [--json=report.json] [--markdown=report.md]
```

It re-runs, from scratch, the base's checks on the head, every criterion verifier of the works the range touched (green on the head, red on each work's base), requires every changed existing test or check file in the range to be covered by a closed work that got it approved or accepted (this catches an agent that edited a test and never ran `ways done`), and audits the records the range changed (criteria unchanged since open, evidence bound to its commit and to the base's contract, closes on the evaluated tree, reviews attested, approvals bound and their signatures valid). It exits 1 on any failure and reports per work what backs each criterion. `bootstrap` writes `.github/workflows/ways.yml` running it; make that job a required check (see [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md)).

## Threat model, honestly

ways assumes an agent that is capable and usually honest, but under pressure to report success. Locally it runs with the same user and shell as the human.

**Guaranteed, if CI runs `ways verify` as a required check on protected branches:**

- The definition of done does not move after open, and no record is written by hand (the commit hook refuses it; the audit flags one that bypassed the hook).
- The checks that judge a change are the base's, re-run from a clean checkout; the evidence is re-derived, not trusted.
- A criterion is backed by a verifier that fails without the work, or it is marked review-only and needs an attested review.
- Existing tests and check configuration are not weakened, deleted or run less without an approval or an explicit acceptance recorded in the work.
- With `approvals.signature: required` and the human's key in `allowed_signers`, an approval comes from someone holding that key.

**Not guaranteed, and why:**

- **A local agent can bypass anything local.** It can set `WAYS_DISABLE=1`, change `core.hooksPath`, edit the clean checkout or `node_modules` it is linked from, or rewrite history. These show up only in CI; hence CI is the trust boundary.
- **A key the agent can use can sign.** An ordinary SSH key loaded in the same user's `ssh-agent` signs for the agent as well as for the human. Only a FIDO key (`ed25519-sk`, `ecdsa-sk`), which needs a physical touch per signature, separates them; use one for `allowed_signers`. The terminal check alone is a speed bump: `script -qc "ways approve"` gives an agent a terminal.
- **A verifier is only as good as its test.** A new test the agent wrote for its own criterion can be weak (it is red on the base and green after, but may not test the criterion). The criteria block for the human, the strength label and the independent review are the mitigation; mutation testing is not built in.
- **The reviewer is a model too.** A subagent started by the implementer receives the implementer's task prompt; ways injects its own prompt and tells it to ignore suggested verdicts, but cannot see what else it was told. The `ways review` process path does not have that weakness. A review that "always finds something" is tempered by only `critical`/`high` blocking.
- **The ratchet needs a count.** It reads the summary line of common runners (vitest, jest, node --test, mocha, pytest, cargo); other runners are not ratcheted. In CI its baseline comes from committed evidence, so a range of small changes without records may have none.
- **Linked dependencies are not clean.** Without `commands.setup`, the clean checkout uses the working tree's `node_modules`; CI installs from the lockfile.

Adversarial regression tests for these guarantees (`tests/adversarial.test.ts`) run with the suite; the same traps are tasks for real models in `assets/evals/adversarial.json` (see [EVALS.md](EVALS.md)). Design decisions: [0007](decisions/0007-verification-v2.md).
