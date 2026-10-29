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

1. **A clean checkout.** It checks the committed HEAD out in a reusable worktree outside the working tree (`$TMPDIR/ways-eval/<id>/checkout`, one per worktree, so parallel works never wait for each other), removing every untracked and ignored file except dependency directories. Nothing the agent left in its own checkout (a stale build, a scratch file) reaches the checks. With `commands.setup` configured it runs there, and again only when the setup command or a lockfile changes; without it, `node_modules`, `.venv` or `venv` of the working tree are linked in and the evidence says so. `--fast` (or `"evaluation": "fast"`) runs in the working tree instead and leaves the clean run to CI.
2. **The base's checks.** It runs the check contract (`testCommand`, `commands`) as committed in the work's base, not as the increment left it: changing `testCommand` to `["true"]` does not make the work pass.
3. **Every verifier, red to green.** Each criterion's verifier must pass on the input and fail on the base (run once per base and cached). One that already passes on the base does not show the work did anything: the criterion counts as `review-only`, which makes the independent review mandatory.
4. **Retries, not luck.** A failing check or verifier runs again up to twice before the failure is recorded. A pass after a failure is recorded as flaky in the evidence and goes to the quarantine `ways status` shows.
5. **The verifier surface.** What the increment does to tests, test-runner and CI configuration, `.ways/config.json` and `.ways/allowed_signers` (the `verifierPaths` globs), to the script a criterion's verifier runs, and a drop in the number of tests the test check ran against the base (the ratchet), form the *verifier checkpoint*, judged by what changed inside each file ([the exact rule](#what-needs-approval-on-the-verifier-surface)). Adding tests is free, also to an existing test file. The checkpoint needs the human's approval, or, when `approvals.verifierChanges` is `human-or-review` (the default) and `approvals.signature` is not `required`, an independent review that ways launched (`ways review`) or handed its prompt to (the `ways-reviewer` subagent) and that accepts each entry (`"accepts": [...]` in a finding). A review file typed in at a terminal never accepts; with signatures required, only a signed approval covers the checkpoint.
6. **The evidence.** For every check and verifier: command, exit code, duration, sha256 of the output, the last lines, attempts, the compact summary `ways run` gives (status, counts, each failure on one line), the run id and the path of the full log (`ways run --show <id>`; under the Git directory of the machine that ran it, never committed), an execution id the criterion cites (`AC1`, `AC1@base`), and the runner (clean or not, platform, Node, ways version, how dependencies got there, whose contract ran). The only thing the agent adds is a note per criterion (`ways done --note=AC1:...`). A summary says what backs the delivery: `Backed by: 1 property, 2 test, 1 review-only.`

The work closes when the evidence passed for the closed tree, any required review is attested and does not block, and any required approval is valid. Otherwise it is *verifying* and `ways done` prints the exact next command.

## Running checks: `ways run`

The checks the agent runs every day go through the same wrapper `ways done` uses. `ways run <check>` runs the configured command (no shell), keeps its whole output in `<git-common-dir>/ways/runs/<id>.log` (the newest 100 runs) and prints a summary: one line when it passes; otherwise status, duration, counts, each failure on one line with its location and first error lines, and the log path, within 40 lines and 2,000 characters (`output` in `.ways/checks.json`). The exit code is the command's. Output is read by a parser per tool (vitest, jest, pytest, cargo test, go test, tsc, eslint, ruff, mypy, chosen by what the output looks like, so `npm test` works); anything else, or a failed run whose report a parser cannot find, gets a generic reading (exit code, lines that look like errors, the last lines).

**New or already failing.** A failure is *new* unless it also failed at the base: the active work's base, or HEAD when the tree has uncommitted changes. ways compares with the newest run of the same command on that commit made from a clean tree (`ways run`, `ways check` or `ways done` leave those), and otherwise with the line base in `.ways/checks.json`, recorded when the check was validated. Neither is a verdict: `ways done` still requires every check to pass.

**Checks are validated before they exist.** `.ways/checks.json` is what ways observed (where a command came from, how long it takes, whether it is `slow`, its line base); the contract stays `commands` in `.ways/config.json`. A command is added only after ways ran it: one that cannot start, exits 126 or 127, reports a missing script or module, runs no tests, or fails without a report any parser recognises, is rejected with the reason.

## What needs approval on the verifier surface

ways diffs each file on the surface between the work's base and the evaluated commit (`git diff -U0`) and decides by content, not by whether the file existed:

| Change | Needs approval |
| --- | --- |
| A new test file, a new fixture or helper | no |
| Lines added to an existing test file (a new test, a new assertion), anywhere in it | no |
| An `import`/`require`/`from … import` line widened with more names from the same module (`import { add }` → `import { add, mul }`) | no |
| Removing or changing any other existing line (an assertion, an expected value, a test commented out) | yes |
| Deleting a test file, or turning it into a symlink | yes |
| An added line with a marker that disables, narrows or ends tests: `.skip`, `.skipIf`, `.runIf`, `.only`, `.todo`, `xit`, `xdescribe`, `xtest`, `fit`, `fdescribe`, `@Disabled`, `@Ignore`, `@pytest.mark.skip`/`skipif`/`xfail`, `pytest.skip(`, `@unittest.skip`, `t.Skip(`, `#[ignore]`, `process.exit(`, `sys.exit(`, `os.Exit(` | yes; in a **new** file only the focusing ones (`.only`, `fit`, `fdescribe`, `ftest`), which keep other tests from running |
| Adding or changing check configuration: `.ways/config.json` (the fields that decide verification), `.ways/allowed_signers`, `package.json` (`scripts` and the `jest`, `vitest`, `mocha`, `ava`, `c8`, `nyc` keys), `vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `cypress.config.*`, `karma.conf.*`, `.mocharc*`, `conftest.py`, `pytest.ini` | yes (adding too); a dependency bump in `package.json` does not count |
| Adding a check to `commands` in `.ways/config.json` (`ways check add`, `ways onboard`): every check the base ran is still there with the same command and still required, and nothing else that decides verification changed | no, like adding a test |
| Changing or deleting a CI pipeline (`.github/workflows/**`, `.gitlab-ci.yml`) | yes; adding one does not: it adds jobs and cannot stop the others, and which checks are required is the branch protection's to say |
| Any change to a script a criterion's verifier runs (`node checks/ac1.mjs`) | yes |
| Fewer tests ran than on the base (the ratchet) | yes |
| Anything under `node_modules/`, `vendor/`, `dist/`, `build/`, `coverage/`, `target/`, `.venv/`, `venv/`, `__pycache__/`, `.tox/`, `.next/` or `.git/` | never on the surface |

An increment that installs ways (its base has no `.ways/config.json`) adds configuration freely: there is nothing of the base's to protect yet. Repositories add their own markers as regular expressions in `"testMarkers": ["\\bquarantine\\("]`, read from the base like the globs.

The rule is a heuristic over lines, and it errs towards asking. It does not see an added line that changes what an existing test does without a marker (an early `return`, a mock of the module under test); the ratchet, the criteria's red-to-green verifiers and the independent review are what stand behind that.

## The independent review

A review counts only with a provenance ways recorded itself; nothing the agent writes can claim one.

- **`ways review`** builds the prompt (the criteria, the evidence ways recorded and the diff of the evaluated commit; nothing of the implementer's reasoning), launches the reviewer as a new process limited to read-only tools, reads the verdict from that process's own output and records it. Presets: `claude -p --tools Read,Grep,Glob --permission-mode dontAsk --no-session-persistence --session-id <uuid>` and `pi -p --no-session --no-extensions --tools read,grep,find,ls`; `"reviewer": {"command": [...]}` configures another (prompt on stdin, review JSON on stdout). That setting is read from the work's **base**, like the checks: a work that changes its own reviewer still gets the base's. The history audit (and so `ways verify`) refuses a process review whose command is neither a preset nor the base's reviewer. `ways review --print` shows the prompt and the commands without running them.
- **Claude Code's `ways-reviewer` subagent.** Its definition has only `Read, Grep, Glob`. The `SubagentStart` hook hands it the same prompt; `SubagentStop` records its final answer, but only if ways started it with that prompt and the hook events of that subagent (`agent_id`) show no write tool. The implementer never holds the review, so it cannot edit it.
- **A human** can record a review file with `ways review submit <file>` at an interactive terminal. The terminal check is only a speed bump (`script -qc` gives an agent a terminal), so such a review never satisfies a required review or a review-only criterion on its own, locally or in `ways verify`: the work then also needs the human's approval (`ways approve`, which covers the review through its digest and is SSH-signed when a key is configured or required). Its blocking findings still block, and it never accepts a verifier change.

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

It re-runs, from scratch, the base's checks on the head, every criterion verifier of the works the range touched (green on the head, red on each work's base), requires every entry of the range's verifier checkpoint to be covered by a closed work that got it approved or accepted (this catches an agent that edited a test and never ran `ways done`), and audits the records the range changed (criteria unchanged since open, evidence bound to its commit and to the base's contract, closes on the evaluated tree, reviews attested, approvals bound and their signatures valid). Coverage is bound to content, not to the path, and runs all the way from the range's base: the head must hold the version of the file a covering work had approved, or one that only adds to it by the rule above, and that work's own base must hold a version the range's base reaches with nothing the checkpoint counts, or one an earlier covering work approved (and so on back to the range's base). So an approved edit of `tests/x.test.js` covers neither a later commit that weakens it again nor a weakening committed before the work started, which the human approving never saw; a test-count drop is covered only down to the count that was approved. Whether untraced commits fail (`enforcement`) is read from the base. It exits 1 on any failure and reports per work what backs each criterion. `bootstrap` writes `.github/workflows/ways.yml` running it; make that job a required check (see [BRANCH_PROTECTION.md](BRANCH_PROTECTION.md)).

## Threat model, honestly

ways assumes an agent that is capable and usually honest, but under pressure to report success. Locally it runs with the same user and shell as the human.

**Guaranteed, if CI runs `ways verify` as a required check on protected branches:**

- The definition of done does not move after open, and a record the commit hook did not see is flagged unless its commit carries the harness's trailers (see below).
- The checks that judge a change are the base's, re-run from a clean checkout; the evidence is re-derived, not trusted.
- A criterion is backed by a verifier that fails without the work, or it is marked review-only and needs a review from a reviewer ways launched (or its subagent), or a terminal review plus the human's approval.
- Existing tests and check configuration are not weakened, deleted or run less (by the rule above) without an approval or an explicit acceptance by a reviewer ways launched, recorded in a closed work for that very content.
- With `approvals.signature: required` and the human's key in `allowed_signers`, an approval comes from someone holding that key, and no test or check change, and no review typed at a terminal, closes without one.

**Not guaranteed, and why:**

- **A local agent can bypass anything local.** It can set `WAYS_DISABLE=1`, change `core.hooksPath`, edit the clean checkout or `node_modules` it is linked from, or rewrite history. These show up only in CI; hence CI is the trust boundary.
- **A key the agent can use can sign.** An ordinary SSH key loaded in the same user's `ssh-agent` signs for the agent as well as for the human. Only a FIDO key (`ed25519-sk`, `ecdsa-sk`), which needs a physical touch per signature, separates them; use one for `allowed_signers`. The terminal check alone is a speed bump: `script -qc "ways approve"` gives an agent a terminal, so with signatures optional an agent determined to cheat can still pair a terminal review with a terminal approval; it takes two deliberate commands, the record says `via: terminal` for both, and only `approvals.signature: required` closes the gap.
- **A verifier is only as good as its test.** A new test the agent wrote for its own criterion can be weak (it is red on the base and green after, but may not test the criterion). The criteria block for the human, the strength label and the independent review are the mitigation; mutation testing is not built in.
- **A review's provenance is local.** ways records it from its own hooks and processes, and CI checks it is coherent with the base (a preset, the base's reviewer, the `ways-reviewer` subagent). But an agent with a shell can call the hook script itself with a made-up `SubagentStop`, or put a fake `claude` on its `PATH`. So in the default policy a review's acceptance of a test change is as strong as the local hooks, the same as an unsigned approval; with `approvals.signature: required` it is not accepted at all, and only the human's signature, which CI re-verifies, covers a test change.
- **With signatures optional, CI cannot tell a hand-written closed record from one ways wrote.** The history audit checks a record commit's `Harness-Work`/`Harness-State` trailers, and an agent with a shell can type those into its own commit (with `WAYS_DISABLE=1` to skip the hook). The record's content is still audited (criteria unchanged, evidence bound to its commit and re-run, closes on the evaluated tree, nothing pending under the policy), so the forgery has to name an unsigned approval (`via: terminal`) or a process/subagent review coherent with the base; with `approvals.signature: required`, a forged approval fails the signature check and a forged review cannot accept a test change.
- **The subagent reviewer runs in the implementer's session.** Claude Code gives the `ways-reviewer` subagent the implementer's `session_id`; ways tells it apart by its `agent_id` (its own hook events, its read-only tools, the prompt ways handed it), not by a separate session. The `ways review` process is a separate session.
- **The reviewer is a model too.** A subagent started by the implementer receives the implementer's task prompt; ways injects its own prompt and tells it to ignore suggested verdicts, but cannot see what else it was told. The `ways review` process path does not have that weakness. A review that "always finds something" is tempered by only `critical`/`high` blocking.
- **The ratchet needs a count.** It reads the summary line of common runners (vitest, jest, node --test, mocha, pytest, cargo); other runners are not ratcheted. In CI its baseline comes from committed evidence, so a range of small changes without records may have none.
- **Linked dependencies are not clean.** Without `commands.setup`, the clean checkout uses the working tree's `node_modules`; CI installs from the lockfile.

Adversarial regression tests for these guarantees (`tests/adversarial.test.ts`) run with the suite; the same traps are tasks for real models in `assets/evals/adversarial.json` (see [EVALS.md](EVALS.md)). Design decisions: [0007](decisions/0007-verification-v2.md).
