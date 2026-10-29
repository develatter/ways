---
title: Commands
kind: reference
sources:
  - src/commands.ts
reviewed: 2026-10-29
source_hashes:
  src/commands.ts: 1e705fb54baf
---

# Commands

Every command with its usage and examples, as `ways --help` prints them; `ways <command> --help` shows the same for one command. The sections below are generated from the command registry in `src/commands.ts` and kept in sync by a test, so they cannot disagree with the program. The examples are checked by [`ways wiki check`](../how-to/wiki.md) against that registry.

Most work is two commands: `ways done` to finish a [small change](../how-to/small-change.md), and `ways outcome open` to start a [delivery with criteria](../how-to/delivery-with-criteria.md). `ways hook` is called by Git and by the agents, not by hand.

<!-- commands:start (generated from src/commands.ts; run `UPDATE_README=1 npx vitest run tests/commands.test.ts`, then `ways wiki update --stamp reference/commands.md`) -->

## `ways bootstrap`

Install ways in a Git repository: checks detected and validated by running them, AGENTS.md, MAP.md, commit hooks, memory and the Claude Code and pi adapters

```text
ways bootstrap [--test-command=<json-array>] [--commands=<json>] [--agents=claude,pi[,codex,cursor]] [--no-adapters] [--force]
  without --test-command or --commands, ways detects the checks (manifests, CI, Makefile) and runs each candidate once
```

```sh ways-check
ways bootstrap
ways bootstrap --test-command='["npm","test"]'
```

## `ways status`

What is active, what done means for it, what is missing and the next command

```text
ways status [--json]
```

```sh ways-check
ways status
```

## `ways context`

The facts an agent needs now: active work, its criteria, what fails, what waits on whom, the next command, memory of the code in play

```text
ways context [--brief] [--json] [--session=<agent-session-id>]
```

```sh ways-check
ways context --brief
```

## `ways start`

Start a small change (optional in observe mode: the first commit starts one from the branch)

```text
ways start [<id>]
```

```sh ways-check
ways start fix-button-padding
```

## `ways outcome`

Open a delivery whose definition of done is one-line criteria, each with an executable verifier

```text
ways outcome open <id> --goal=<text> --criterion=<ID>:<text>... [--verify=<ID>:<command>]... [--strength=<ID>:proof|property|test|e2e]...
                       [--review=required|none] [--approval=required|none]
```

```sh ways-check
ways outcome open greeting --goal="Greet users" --criterion="AC1:greeting.txt says hi" --verify="AC1:grep -q hi greeting.txt"
```

## `ways done`

Finish the active work: run integrity, checks and verifiers once, record the evidence, close when nothing is missing

```text
ways done [--message=<subject>] [--fast] [--note=<ID>:<text>]...
  runs in a clean checkout of HEAD with the base's checks; --fast runs in place and leaves the clean run to CI
```

```sh ways-check
ways done
ways done --message="fix: button padding"
ways done --fast
```

## `ways block`

Stop on purpose when the task cannot be done as asked: record what is missing and what would unblock it, for the human

```text
ways block "<what is missing; what would unblock it>"
```

```sh ways-check
ways block "AC2 needs the payments sandbox key; set PAYMENTS_KEY in .env.test or drop AC2"
```

## `ways ask`

Ask the human something (a question, a decision, an approval); the answer comes back through the hooks, or at once with --wait

```text
ways ask "<question>" [--options=a,b] [--type=ask|decision|approval] [--default=<option>] [--body=<text>]
        [--work=<id>] [--priority=low|normal|high] [--expires=30m] [--wait[=5m]] [--session=<id>] [--json]
  --wait exits 0 with the answer, 2 if still open (it arrives later through the hooks), 3 if it expired or was closed unanswered
```

```sh ways-check
ways ask "Mock Stripe in CI, or will you add STRIPE_TEST_KEY?" --options=mock,key --wait=5m
```

## `ways inbox`

What agents wait on from the human, and what the human tells them: list, show, answer, close, or tell an agent something

```text
ways inbox [list] [--all] [--json]
ways inbox show <id> [--json]
ways inbox answer <id> "<answer>" [--choice=<option>] [--json]
ways inbox close <id> [--reason=<text>] [--json]
ways inbox tell "<instruction>" [--session=<id> | --work=<id> | --worktree=<path>] [--priority=high] [--json]
  answers and instructions reach the agent once, at its next prompt, stop or session start
```

```sh ways-check
ways inbox
ways inbox answer i-mabc12-1a2b3c4d mock
ways inbox tell "Stream the export; it must stay under 2 s" --work=billing-export
```

## `ways serve`

The local board: a kanban of every agent's work derived from hooks, records and worktrees, and the inbox, live on 127.0.0.1

```text
ways serve [--port=<n>] [--open] [--repo=<path>]... [--lang=en|es] [--demo]
  prints a URL with a one-time token; --repo adds a repository to ~/.config/ways/registry.json; --demo shows made-up data
```

```sh ways-check
ways serve --open
ways serve --demo
```

## `ways review`

Launch an independent read-only reviewer of the evaluated commit and record its verdict; closes the work when nothing else is missing

```text
ways review [--agent=claude|pi] [--print]
  starts a new read-only process with a prompt ways builds (criteria, evidence, diff); --print shows it instead
  in Claude Code the ways-reviewer subagent works too: ways records its final answer itself
ways review submit <review.json>   (a human at an interactive terminal)
```

```sh ways-check
ways review
ways review --agent=pi
ways review --print
```

## `ways approve`

Human approval (a real terminal, signed with the human's SSH key when configured); closes the work when nothing else is missing

```text
ways approve [--key=<ssh key>]          at an interactive terminal; signs when a key is given or Git signs with SSH
ways approve --payload                  print what to sign elsewhere: ssh-keygen -Y sign -n ways-approval -f <key>
ways approve --signature=<file>         record a signature made elsewhere (verified against .ways/allowed_signers of the base)
```

```sh ways-check
ways approve
ways approve --key=~/.ssh/id_ed25519_sk
```

## `ways cancel`

Drop the active work; commits stay, an open record is marked cancelled

```text
ways cancel
```

```sh ways-check
ways cancel
```

## `ways run`

Run a configured check (test, lint, typecheck, build, e2e) and get a short summary instead of its output: counts, each failure on a line, new vs already failing at the base, and the full log kept

```text
ways run [<check>...] [--all] [--json]
ways run <check> -- <extra args>   (e.g. one test file: ways run test -- tests/test_cart.py)
ways run --show <id> [--grep=<regex>] [--tail=<n>|all]
  without a name: every configured check in order, except the slow ones (--all includes them); the exit code is the check's
```

```sh ways-check
ways run test
ways run
ways run --show test-m3k2p0a1 --grep=FAIL
```

## `ways check`

Integrity and every configured check (what CI runs), one line per area; add a check, validated by running it; --history audits work records and trailers

```text
ways check [--integrity-only] [--with-services]
ways check add <test|lint|typecheck|build|e2e> -- <command> [args...]
ways check --history [--since=<ref>] [--to=<ref>]
```

```sh ways-check
ways check
ways check add lint -- npx eslint .
ways check --history --to=$GITHUB_SHA
```

## `ways onboard`

The first session: MAP.md and the checks ways can detect (each run once), then an onboarder agent for folder purposes, a few verified-by-source facts, proposed checks and AGENTS.md additions; ways validates all of it

```text
ways onboard [--agent=claude|pi|none|<command>] [--yes] [--refresh] [--dry-run] [--json]
  an agent spends the human's quota: with "onboarding": "ask" (default) it starts only after --yes or a yes at the terminal
  --refresh updates stale facts and missing folder purposes; --agent=none runs only the deterministic part
```

```sh ways-check
ways onboard --dry-run
ways onboard --yes
ways onboard --refresh --yes
```

## `ways map`

Write MAP.md from the repository (stack, commands, folders, entry points, tests, CI) with the folder purposes in .ways/map-notes.json; --check fails when it drifted

```text
ways map [--check]
```

```sh ways-check
ways map
ways map --check
```

## `ways verify`

The CI's judgement of a range: re-run the base's checks and every criterion's verifier clean, require changed tests to be approved, audit the records

```text
ways verify --base=<sha> [--head=<sha>] [--in-place] [--json=<report.json>] [--markdown=<report.md>]
  --in-place runs in the current checkout when it is clean and at the head (a fresh CI checkout); the Markdown also goes to $GITHUB_STEP_SUMMARY
```

```sh ways-check
ways verify --base=origin/main
ways verify --base=$BASE_SHA --in-place --json=ways-report.json
```

## `ways remember`

Write one short memory (a convention, decision, pitfall or how-to), tied to the code it is about

```text
ways remember "<fact>" [--path=<glob>]... [--type=convention|decision|pitfall|howto] [--id=<slug>]
```

```sh ways-check
ways remember "Tokens refresh 60 s before expiry" --path=src/auth/**
```

## `ways memory`

Validate the OKF memory under .ways/knowledge (flag stale and unverified facts), rebuild its index, or confirm seeded facts (a person at a terminal)

```text
ways memory check
ways memory index
ways memory confirm <id>...   (a person who checked the facts against their sources)
```

```sh ways-check
ways memory check
ways memory confirm conventions/money-in-cents
```

## `ways query`

Search the memory; read-only

```text
ways query <terms>
```

```sh ways-check
ways query token refresh
```

## `ways adapter`

List or (re)install agent adapters: claude and pi by default, codex and cursor best effort

```text
ways adapter list
ways adapter install <provider> [--force]
```

```sh ways-check
ways adapter list
ways adapter install codex
```

## `ways upgrade`

Move a repository to this version of ways (including 0.2.x); never overwrites edits silently

```text
ways upgrade [--apply] [--overwrite-all | --overwrite=<path>...]
```

```sh ways-check
ways upgrade
ways upgrade --apply
```

## `ways hook`

Entry point of the managed Git hooks and the coding-agent hooks (not called by hand)

```text
ways hook prepare-commit-msg <message-file> [source] [sha]
ways hook commit-msg <message-file>
ways hook SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd [--agent=claude|pi|codex|cursor]   (agent's JSON payload on stdin)
```

```sh ways-check
ways hook prepare-commit-msg .git/COMMIT_EDITMSG
echo '{"session_id":"s1"}' | ways hook SessionStart --agent=claude
```

## `ways wiki`

A wiki for humans in docs/wiki, apart from the agents' memory: create it, check it (links, frontmatter, freshness by source hash, coverage), list stale pages, or launch the documentalist agent to update it

```text
ways wiki init
ways wiki update [--agent=claude|pi|<command>] [--dry-run]
ways wiki update --stamp <page>...
ways wiki check [--json]
ways wiki stale [--json]
  update launches the documentalist with a brief ways builds (stale pages, gaps, broken links), allowed to write only under docs/wiki/; --stamp records that pages you checked match their sources
```

```sh ways-check
ways wiki check
ways wiki update --dry-run
ways wiki update --stamp reference/commands.md
```

## `ways evals`

Run or compare the harness evaluation corpus

```text
ways evals run [--adapter=fake|command --command=<executable> [--arg=<arg>]...] [--harness=<label>] [--model=<name>] [--corpus=<file>]
               [--review=required|none] [--approval=required|none] [--revision=<label>] [--seed=<n>] [--timeout-ms=<n>] [--max-output-bytes=<n>] [--output=<file>]
ways evals compare --input=<result.json>... [--output=<report.json>] [--markdown=<report.md>]
```

```sh ways-check
ways evals run --harness=outcome --output=result.json
ways evals compare --input=result.json
```

<!-- commands:end -->
