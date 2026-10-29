# ways

A lean harness for coding agents (Claude Code and pi first; Codex and Cursor best effort).
The agent decides how to work. ways gives it the right context at the right moment, checks the result once, records the evidence itself, and only blocks what would break a guarantee.
"Done" is a short list of one-line criteria, each with a command that proves it: you review those lines, not the diff.

## Install and first use (60 seconds)

Requires Git and Node.js 22+ on Linux or macOS.

```bash
npm install --save-dev @develatter/ways --registry=https://npm.pkg.github.com
npx ways bootstrap --test-command='["npm","test"]'
git add -A && git commit -m "chore: install ways"
```

Then open `AGENTS.md` and describe your project (what it is, where things live, the commands): that is the only part you write. Start Claude Code or pi as usual; you do not have to tell the agent about ways.

Bootstrap writes 23 files: `.ways/config.json`, two Git hooks and the agent-hook wrapper, `scripts/check.sh`, a CI job (`.github/workflows/ways.yml`), `AGENTS.md`, a `CLAUDE.md` that imports it, the memory index, and the Claude Code and pi adapters (hooks, three skills, a reviewer and a documentalist agent). Add Codex or Cursor with `--agents=claude,pi,codex,cursor`.

## The two ways to work

**A small change.** Work and commit as you like, any number of commits, then:

```bash
npx ways done        # your checks, once, in a clean checkout of your commit; closes the change
```

The first commit starts the change on its own (named after the branch, or after the commit on `main`); `npx ways start <id>` names it yourself. If a check fails, fix, commit and run `ways done` again.

**A delivery with criteria.** Say what done means, one line per criterion, each with the strongest check you have:

```bash
npx ways outcome open auth-refresh --goal="Refresh tokens before they expire" \
  --criterion="AC1:refreshes 60 s before expiry" --verify='AC1:npm test -- -t "refresh before expiry"' \
  --criterion="AC2:never refreshes a revoked token" --verify='AC2:npm test -- -t "revoked"'
# ... implement and commit ...
npx ways done        # runs your checks and every verifier, records the evidence
npx ways review      # an independent read-only reviewer (required by default); closes the work
```

`outcome open` prints the criteria with their verifiers in one block: that is what you approve. Each verifier must fail before the work and pass after it; one that already passes, or a criterion without `--verify`, counts as `review-only` and makes the review mandatory. `--strength=AC1:property` (or `proof`, `e2e`) records how strong a verifier is, and `ways done` says what backs the delivery (`Backed by: 1 property, 2 test`). `--review=none` drops the review when every criterion has a verifier; `--approval=required` adds your approval at the end.

**When it cannot be done as asked**, the agent stops and says why instead of working around a check:

```bash
npx ways block "AC2 needs the payments sandbox key; set PAYMENTS_KEY in .env.test or drop AC2"
```

**Your approval** is needed when you ask for it, and when a work removes or changes lines of an existing test, skips or focuses tests, changes the check configuration or runs fewer tests (unless the independent review accepted that change). Adding tests never needs one, also to an existing test file. You run, in your own terminal, `npx ways approve` (or `--key=~/.ssh/id_ed25519_sk` to sign it). The exact rule is in [docs/VERIFICATION.md](docs/VERIFICATION.md#what-needs-approval-on-the-verifier-surface).

**Memory.** When the agent (or you) learns something durable, a convention, a decision, a pitfall, how to check something:

```bash
npx ways remember "Tokens refresh 60 s before expiry; never on revoked tokens" --path='src/auth/**'
```

One short file under `.ways/knowledge/`, committed with the change. When that code changes later, the memory is shown again and marked *possibly stale*.

**Where am I?** `npx ways status` shows the active work, its criteria, what is missing and the exact next command; `npx ways cancel` drops it. Every command works from any directory of the repository.

## What the agent sees

Hooks hand the agent, at session start, a short brief (at most 6,000 characters): the active work and its criteria, what fails, what waits on whom, the next command, and the memory of the code in play. Later prompts get only what changed, or nothing. Before a tool call, the hooks refuse hand edits of `.ways/work/` (the records only ways writes). At the end of a turn they remind the agent once of a failing run or a missing review, and tell you, not the agent, when your approval is pending or the agent blocked. Claude Code also gets each memory as a path rule, loaded when it opens that code; pi gets it the first time it touches that code.

`npx ways context --brief` prints the brief. The skills `ways-outcome`, `ways-remember` and `ways-orchestrator` and the `ways-reviewer` agent are there when you want them. See [docs/CONTEXT.md](docs/CONTEXT.md).

## The board and the inbox

```bash
npx ways serve --open      # or --demo, to see it with made-up data
```

A local page (127.0.0.1 only, with a token in the URL it prints) with a live kanban of every worktree's work across your repositories (Preparing, Working, Verifying, Blocked, Waiting for you, Done), derived from the hooks, the records and `git worktree list`: nothing to drag. Next to it, the inbox: agents ask with `npx ways ask "<question>"` (`--wait` to wait for the answer) and `ways block`; you answer on the page or with `npx ways inbox answer <id> "<answer>"`, and tell an agent something with *Tell the agent* or `npx ways inbox tell "<instruction>" --work=<id>`. The agent gets each answer once, at its next prompt, stop or session start. Every inbox command takes `--json`, so an orchestrating agent can run the loop. See [docs/CONTROL_PLANE.md](docs/CONTROL_PLANE.md).

## What ways guarantees, and what it does not

| Guarantee | How |
| --- | --- |
| The definition of done does not move | The goal and criteria are committed when the outcome opens; the commit hook refuses any hand edit of `.ways/work/`, and the history audit flags one that bypassed the hook |
| The evidence is the harness's | `ways done` writes it (commands, exit codes, durations, output digests, attempts) for the exact commit and tree it ran on, in a clean checkout, with the checks as the base commit configured them |
| A criterion shows the work did something | Its verifier must fail on the base and pass on the commit; otherwise it is review-only |
| Tests are not weakened silently | Removing or changing lines of an existing test, skipping or focusing tests, touching check configuration, or running fewer tests needs your approval or an independent review that accepts it; in CI the approval covers only the content it was given for |
| Reviews are independent | A reviewer ways launched (or the `ways-reviewer` subagent it handed the prompt to) counts on its own; it has read tools only and ways records its answer itself. A review typed in at a terminal (`ways review submit`) counts only together with your approval |
| Approvals come from a person | `ways approve` needs a real terminal; with `.ways/allowed_signers` it is SSH-signed, and the policy can require that |

**What it does not guarantee.** Locally, an agent with a shell can bypass any hook (`WAYS_DISABLE=1`, or pointing `core.hooksPath` elsewhere), and a pseudo-terminal (`script -qc`) passes the terminal check of `ways approve` and `ways review submit`: only `"approvals": {"signature": "required"}` with your key in `.ways/allowed_signers` makes an approval yours for certain. With signatures optional, a closed record the agent wrote by hand with the harness's commit trailers is not caught by CI either. The `ways-reviewer` subagent shares the implementer's session; ways tells it apart by its agent id, not by a separate session. A criterion is only as good as its verifier: ways proves the verifier went from red to green, not that it tests the right thing; that is what you review. **The CI is the final judge**: the `ways verify` job bootstrap writes re-runs everything from scratch on every pull request; make it a required check ([docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md)). The threat model is in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## A wiki for people

The memory above is for agents. For humans, `docs/wiki/` is a plain-Markdown wiki (tutorials, how-to guides, reference, explanation; GitHub renders it, nothing to build):

```bash
npx ways wiki init       # the entry page, the folders, .ways/wiki.json
npx ways wiki check      # links, frontmatter, examples, coverage, and pages stale against their sources
npx ways wiki update     # a documentalist agent (claude -p, pi -p or your own command) writes or catches up pages
```

Each page lists the files it documents with a hash of each, so `check` fails (in CI too) the day one of them changes. The documentalist can write only under `docs/wiki/`, and the wiki and the memory never feed each other. See [docs/WIKI.md](docs/WIKI.md); the wiki of ways itself starts at [docs/wiki](docs/wiki/index.md).

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
| `ways ask` | Ask the human something (a question, a decision, an approval); the answer comes back through the hooks, or at once with --wait | `ways ask "Mock Stripe in CI, or will you add STRIPE_TEST_KEY?" --options=mock,key --wait=5m` |
| `ways inbox` | What agents wait on from the human, and what the human tells them: list, show, answer, close, or tell an agent something | `ways inbox` |
| `ways serve` | The local board: a kanban of every agent's work derived from hooks, records and worktrees, and the inbox, live on 127.0.0.1 | `ways serve --open` |
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
| `ways wiki` | A wiki for humans in docs/wiki, apart from the agents' memory: create it, check it (links, frontmatter, freshness by source hash, coverage), list stale pages, or launch the documentalist agent to update it | `ways wiki check` |
| `ways evals` | Run or compare the harness evaluation corpus | `ways evals run --harness=outcome --output=result.json` |
<!-- commands:end -->

## Configuration

| Setting | Where | What it does |
| --- | --- | --- |
| `enforcement` | `.ways/config.json` | `observe` (default): the commit hook only refuses commits that hand-edit a work record, and adds the `Harness-Work` trailer. `enforce`: it also refuses commits outside an active work |
| `commands` | `.ways/config.json` (`bootstrap --commands=<json>`) | Your checks: `test`, `lint`, `typecheck`, `build`, `e2e`; only names in `required` run, in that order. Plus `setup` (e.g. `["npm","ci"]`, how the clean checkout gets its dependencies) and `services` (started around the checks) |
| `evaluation` | `.ways/config.json` | `clean` (default) or `fast`: run `ways done` in your working tree and leave the clean run to CI (`ways done --fast` for once) |
| `review`, `approvals`, `reviewer` | `.ways/config.json` | Default review policy of new outcomes; `approvals.signature: required` for SSH-signed approvals only; which agent or command reviews |
| `verifierPaths`, `testMarkers` | `.ways/config.json` | The globs of tests and check configuration whose weakening needs approval, and extra regular expressions for lines that disable tests (both read from the base) |
| agents | `ways bootstrap --agents=claude,pi[,codex,cursor]`, `ways adapter install <agent>` | Which coding agents get hooks, skills and roles. Claude Code and pi by default |
| `lang` | `~/.config/ways/config.json` (`{"lang": "es"}`) or `ways serve --lang=es` | Language of the board: `en` or `es` |
| `WAYS_DISABLE=1` | environment | Skips the Git and agent hooks for one command. CI still judges the result |

A full check contract looks like this:

```bash
npx ways bootstrap --test-command='["npm","test"]' \
  --commands='{"test":["npm","test"],"lint":["npm","run","lint"],"required":["test","lint"],"timeoutMs":120000}'
```

Services are `{"name", "command", "ready", "timeoutMs"}`, where `ready` is `{"command": [...]}`, `{"tcp": {"port": 5432}}` or `{"http": "http://127.0.0.1:3000/health"}`; ways starts them, logs them under `.git/ways/services/` and stops only what it started.

## Where things live

| Path | What | Committed |
| --- | --- | --- |
| `.ways/config.json` | Checks, enforcement, review default, verifier globs, approval policy, reviewer | yes |
| `.ways/allowed_signers` | Optional: the SSH keys whose signatures count as your approval | yes |
| `.ways/work/<id>.json` | One record per outcome (and per change that needed an approval or was blocked): criteria, evidence, review, approval; written only by ways | yes |
| `.ways/knowledge/` | Memory: one short fact per file | yes |
| `.github/workflows/ways.yml` | The CI job running `ways verify` and `ways wiki check` (written once; yours to adapt) | yes |
| `docs/wiki/`, `.ways/wiki.json` | The wiki for people, and its settings | yes |
| `.ways/hooks/`, `scripts/check.sh` | Managed Git hooks, agent-hook wrapper and check script (hashed in `.ways/manifest.json`) | yes |
| `.claude/rules/ways-*.md` | Memory as Claude Code path rules (generated) | yes |
| `.git/ways/` | Active work, run log, caches, agent sessions, the [event log](docs/EVENTS.md), the [inbox](docs/CONTROL_PLANE.md) and the board's token | no |
| `~/.config/ways/` | `registry.json` (the repositories `ways serve` shows) and `config.json` | no |

## Upgrading from 0.2

```bash
npx ways upgrade            # shows what will change
npx ways upgrade --apply    # applies it; commit the result
```

Your checks and memory carry over, and an active quick work becomes the active change. SDD, plan, tasks, attempts, discovery and reconciliation are gone: old `.ways/outcomes/`, `.ways/sdd/` and `.ways/plans/` directories are ignored and can be deleted. See [CHANGELOG.md](CHANGELOG.md) and [decision 0003](docs/decisions/0003-what-stays-and-what-goes.md).

## Limitations and status

This is `0.3.0-dev.0`, a pre-release. What to expect:

- **Mature** (carried from 0.2 and reworked, with the longest test history): the check contract, work records and their history audit, clean-checkout evaluation, memory files and their staleness, upgrades from 0.2.
- **New in 0.3, tested but not yet used in anger**: the agent hooks and brief, `ways verify` in CI, red-to-green verifiers, independent review by configuration, signed approvals, `ways block`, the board and inbox, the wiki and the documentalist.
- **Not measured yet.** The hooks are tested against recorded Claude Code and pi payloads, and the reviewer and documentalist launches against stand-in agents, not against the real binaries in a live session. The evals that would show whether ways makes agents better or cheaper (`ways evals`, [docs/EVALS.md](docs/EVALS.md)) have only run with a fake agent: runs with real models are pending a budget.
- **Known gaps.** The agent hook's p95 latency is above the 100 ms target on slow hosts; a long shell command can make an agent look stalled on the board after 10 minutes; the test-count ratchet only reads common runners' summaries. The full list is in [docs/ROADMAP.md](docs/ROADMAP.md).
- Linux and macOS only; Windows is untested.

## Development

```bash
npm ci
npm run check        # typecheck, build and the whole test suite (what CI runs on Node 22 and 24)
npm run test:e2e     # only the packed-tarball smoke test and the memory end-to-end test
node dist/cli.js wiki check   # the wiki in docs/wiki, which CI also runs
```

`npm test` builds first because tests drive the compiled CLI; if you run `npx vitest` directly, run `npm run build` before. This repository does not run ways on itself ([docs/DOGFOODING.md](docs/DOGFOODING.md) proposes how it could). Design decisions are in [docs/decisions/](docs/decisions/README.md); changes per version in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
