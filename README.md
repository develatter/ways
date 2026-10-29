# ways

A lean harness for coding agents. The agent decides how to work; ways gives it context, checks the result once, records the evidence itself, and only blocks what would break a guarantee.

- **Done means something.** A delivery is a goal plus one-line criteria, each with an executable verifier. `ways done` runs them with your checks and writes the evidence; the agent never does.
- **Ceremony stays out of the way.** Commit as usual: a hook adds the trailer. A small change is one command.
- **Memory is short and travels with the change.** One fact per file, tied to the code it is about, flagged when that code moves on.

## Install (60 seconds)

Requires Git and Node.js 22+ on Linux or macOS.

```bash
npm install --save-dev @develatter/ways --registry=https://npm.pkg.github.com
npx ways bootstrap --test-command='["npm","test"]'
git add -A && git commit -m "chore: install ways"
```

Bootstrap writes 18 files: `.ways/config.json`, two commit hooks and the agent-hook wrapper, `scripts/check.sh`, an `AGENTS.md` for you to fill in as a map of your project, a `CLAUDE.md` that imports it, the memory index, and the Claude Code and pi adapters (hooks, two skills, a reviewer agent). Codex and Cursor are available with `--agents=claude,pi,codex,cursor`.

Fill in `AGENTS.md` (what the project is, where things live, the commands): that is the part only you can write.

## Use it

**A small change.** Work and commit as you like (any number of commits), then:

```bash
npx ways done        # integrity + your checks, once; closes the change
```

In the default `observe` mode the first commit starts the change, named after the branch; `npx ways start <id>` names it yourself. If the checks fail, fix, commit and run `ways done` again.

**A delivery with criteria.** Say what done means, in one line per criterion, with the strongest verifier you have:

```bash
npx ways outcome open auth-refresh --goal="Refresh tokens before they expire" \
  --criterion="AC1:refreshes 60 s before expiry" --verify='AC1:npm test -- -t "refresh before expiry"' \
  --criterion="AC2:never refreshes a revoked token" --verify='AC2:npm test -- -t "revoked"'
# ... implement and commit ...
npx ways done                      # runs checks and verifiers, records the evidence
npx ways review submit review.json # only when a review is required (the default); closes the work
```

You review the criteria, not the diff. A criterion without `--verify` is `review-only` and makes the independent review mandatory; `--strength=AC1:property` (or `proof`, `e2e`) records how strong a verifier is. `--review=none` drops the review for criteria that all have verifiers, and `--approval=required` adds a human approval at the end.

**Human approvals** are needed when you ask for them, and always when the work modifies or deletes an existing test or changes the check commands (adding tests never needs one). The human runs, in their own terminal:

```bash
npx ways approve
```

It refuses without a terminal, shows the criteria, the evidence and the review, asks for the work id and, if nothing else is missing, closes the work.

**Memory.** When you learn something durable (a convention, a decision, a pitfall, how to verify something):

```bash
npx ways remember "Tokens refresh 60 s before expiry; never on revoked tokens" --path='src/auth/**'
```

It writes one short file under `.ways/knowledge/`; commit it with the change. `ways done` and `ways status` point at the memory of the code you are changing and mark it *possibly stale* when that code changed after the memory did.

**Where am I?** `npx ways status` shows the active work, its criteria, what is missing and the exact next command. `npx ways cancel` drops the active work.

**What the agent sees.** In Claude Code and pi you do not have to tell the agent about ways. Hooks hand it, at session start, a short brief (the active work and its criteria, what fails, what waits on whom, the next command, and the memory of the code in play), then only what changed, and say nothing when nothing did. Before a tool call they refuse hand edits of `.ways/work/`; at the end of a turn they remind the agent once of a failing run or a missing review, and tell you, not the agent, when your approval is pending. Claude Code also gets each memory as a path rule, loaded when it opens that code. `npx ways context --brief` prints the brief; [docs/CONTEXT.md](docs/CONTEXT.md) explains it.

The skills `ways-outcome` and `ways-remember` and the `ways-reviewer` agent are there when you want them (`/ways-outcome` in Claude Code).

## What ways guarantees, and what it does not

| Guarantee | How |
| --- | --- |
| The definition of done does not move | The goal and criteria are committed when the outcome opens; the commit hook refuses any hand edit of `.ways/work/`, and `ways check --history` flags one that bypassed the hook |
| Evidence is the harness's, bound to its input | `ways done` writes it (commands, exit codes, durations, output digests and tails) for the exact commit and tree it ran on; closing requires the closed tree to be that tree |
| Tests are not weakened silently | Modifying or deleting an existing test or check command needs a human approval |
| Reviews are of what is closed | A review names the evaluated commit; any later change needs a new `ways done` and a new review. Only `critical` and `high` findings block |
| Approvals come from a human | `ways approve` needs a real terminal; the approval covers the criteria, evidence and review |

Locally, an agent with a shell can bypass any hook (`WAYS_DISABLE=1`, or pointing `core.hooksPath` elsewhere; `--no-verify` alone does not skip the record check, which runs in `prepare-commit-msg`). The CI is the final judge: run `scripts/check.sh --history` on pull requests (see [docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md)).

`enforcement` in `.ways/config.json` is `observe` by default: the hook only refuses commits that hand-edit a work record. With `enforce` it also refuses commits outside an active work.

## Configure checks

`--test-command` is the fallback; for several checks pass a contract. Only names in `required` run, in the order `test`, `lint`, `typecheck`, `build`, `e2e`:

```bash
npx ways bootstrap --test-command='["npm","test"]' \
  --commands='{"test":["npm","test"],"lint":["npm","run","lint"],"required":["test","lint"],"timeoutMs":120000}'
```

The contract can add a `setup` command and `services` (`{"name", "command", "ready", "timeoutMs"}`, where `ready` is one of `{"command": [...]}`, `{"tcp": {"port": 5432}}` or `{"http": "http://127.0.0.1:3000/health"}`). `ways done` and `ways check --with-services` start them around the checks, log them under `.git/ways/services/` and stop only the processes they started.

## Commands

`ways --help` lists them and `ways <command> --help` shows usage and examples.

<!-- commands:start (generated from src/commands.ts; run `UPDATE_README=1 npx vitest run tests/commands.test.ts`) -->
| Command | What it does | Example |
| --- | --- | --- |
| `ways bootstrap` | Install ways in a Git repository: config, commit hooks, memory and the Claude Code and pi adapters | `ways bootstrap --test-command='["npm","test"]'` |
| `ways status` | What is active, what done means for it, what is missing and the next command | `ways status` |
| `ways context` | The facts an agent needs now: active work, its criteria, what fails, what waits on whom, the next command, memory of the code in play | `ways context --brief` |
| `ways start` | Start a small change (optional in observe mode: the first commit starts one from the branch) | `ways start fix-button-padding` |
| `ways outcome` | Open a delivery whose definition of done is one-line criteria, each with an executable verifier | `ways outcome open greeting --goal="Greet users" --criterion="AC1:greeting.txt says hi" --verify="AC1:grep -q hi greeting.txt"` |
| `ways done` | Finish the active work: run integrity, checks and verifiers once, record the evidence, close when nothing is missing | `ways done` |
| `ways block` | Stop on purpose when the task cannot be done as asked: record what is missing and what would unblock it, for the human | `ways block "AC2 needs the payments sandbox key; set PAYMENTS_KEY in .env.test or drop AC2"` |
| `ways review` | Launch an independent read-only reviewer of the evaluated commit and record its verdict; closes the work when nothing else is missing | `ways review` |
| `ways approve` | Human approval (a real terminal, signed with the human's SSH key when configured); closes the work when nothing else is missing | `ways approve` |
| `ways cancel` | Drop the active work; commits stay, an open record is marked cancelled | `ways cancel` |
| `ways check` | Run integrity and the configured checks (what CI runs); --history audits work records and trailers | `ways check` |
| `ways verify` | The CI's judgement of a range: re-run the base's checks and every criterion's verifier clean, require changed tests to be approved, audit the records | `ways verify --base=origin/main` |
| `ways remember` | Write one short memory (a convention, decision, pitfall or how-to), tied to the code it is about | `ways remember "Tokens refresh 60 s before expiry" --path=src/auth/**` |
| `ways memory` | Validate the OKF memory under .ways/knowledge (and flag possibly stale concepts), or rebuild its search index | `ways memory check` |
| `ways query` | Search the memory; read-only | `ways query token refresh` |
| `ways adapter` | List or (re)install agent adapters: claude and pi by default, codex and cursor best effort | `ways adapter list` |
| `ways upgrade` | Move a repository to this version of ways (including 0.2.x); never overwrites edits silently | `ways upgrade` |
| `ways hook` | Entry point of the managed Git hooks and the coding-agent hooks (not called by hand) | `ways hook prepare-commit-msg .git/COMMIT_EDITMSG` |
| `ways evals` | Run or compare the harness evaluation corpus | `ways evals run --harness=outcome --output=result.json` |
<!-- commands:end -->

## Where things live

| Path | What | Committed |
| --- | --- | --- |
| `.ways/config.json` | Checks, enforcement, review default, verifier globs | yes |
| `.ways/work/<id>.json` | One record per outcome: criteria, evidence, review, approval (written only by ways) | yes |
| `.ways/knowledge/` | Memory: short OKF concepts | yes |
| `.ways/hooks/`, `scripts/check.sh` | Managed Git hooks, agent-hook wrapper and check script (hashed in `.ways/manifest.json`) | yes |
| `.claude/rules/ways-*.md` | Memory as Claude Code path rules (generated; `ways memory index`) | yes |
| `.git/ways/` | Active work, run log, search index, service logs, context caches, agent sessions and the [event log](docs/EVENTS.md) | no |

## Upgrading from 0.2

```bash
npx ways upgrade            # shows what will change
npx ways upgrade --apply    # applies it; commit the result
```

The check contract and the memory carry over (coverage globs become `paths:` on their concepts), an active quick work becomes the active change, and an active outcome is reported with the command that reopens it. SDD, plan, tasks, attempts, discovery and reconciliation are gone; old `.ways/outcomes/`, `.ways/sdd/` and `.ways/plans/` directories are left in place and can be deleted. An `AGENTS.md` you edited is kept: replace its ways bullets with the short "Working with ways" section of the new template. See [decision 0003](docs/decisions/0003-what-stays-and-what-goes.md).

## Harness evals

`ways evals run` grades a fixed corpus in disposable repositories without ways (A), with checks only (B), as a change with `ways done` (C) or as an outcome (E); `ways evals compare` builds a matched report with 95% intervals and no single score. See [docs/EVALS.md](docs/EVALS.md).

## Development

```bash
npm ci
npm run check        # typecheck, build and the whole test suite (what CI runs on Node 22 and 24)
npm run test:e2e     # only the packed-tarball consumer test
```

Tests drive the compiled CLI (`dist/`) for the Git hooks, so `npm test` builds first; if you run `npx vitest` directly, run `npm run build` before. This repository does not run ways on itself. Design decisions are in [docs/decisions/](docs/decisions/).

## License

MIT
