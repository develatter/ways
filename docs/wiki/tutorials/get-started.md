---
title: Get started in five minutes
kind: tutorial
sources:
  - src/commands.ts
  - src/bootstrap/bootstrap.ts
  - src/hooks/hook.ts
  - src/config/config.ts
reviewed: 2026-10-29
source_hashes:
  src/commands.ts: 1e705fb54baf
  src/bootstrap/bootstrap.ts: 228910f67914
  src/hooks/hook.ts: 86cbc37c6c53
  src/config/config.ts: 4cbe2b4bb94f
---

# Get started in five minutes

You will install ways in a Git repository, make a small change that ways checks, and deliver something whose "done" is written down and verified. You need Git, Node.js 22 or newer, and a project with tests.

## 1. Install

```sh
npm install --save-dev @develatter/ways --registry=https://npm.pkg.github.com
npx ways bootstrap
git add -A && git commit -m "chore: install ways"
```

Bootstrap reads your manifests and CI to find the commands of your checks (test, lint, type check, build, end-to-end), runs each one once and keeps only those that work, with the failures they already have. It prints what it kept and what it rejected, and why. It writes `.ways/config.json` (the checks), `.ways/checks.json` (what it saw running them), an `AGENTS.md` with those commands, a `MAP.md` of the repository, a `CLAUDE.md` that imports `AGENTS.md`, two Git hooks and a wrapper for the agent hooks, a CI job that runs `ways verify` and `ways wiki check`, the memory index, and the adapters for Claude Code and pi. `--test-command='["npm","test"]'` gives the test command yourself instead. Add `--agents=claude,pi,codex,cursor` if you also use Codex or Cursor (best effort: they work, but get less testing). The CI job runs the `ways` of your `package.json`, so keep the dev dependency the first line installs; bootstrap warns, with the command, when it is missing.

There is nothing to fill in. In your first agent session the agent is told the repository is not onboarded and asks you whether to run `npx ways onboard`, which starts an agent to add what the code does not say: what each folder is for, a few facts with their sources, check commands it saw used. ways validates all of it. Say no and nothing starts; it would spend your agent quota.

Run a check the way the agent will:

```sh ways-check
npx ways run test
```

You get one line if it passes; if not, each failure on one line, which ones are new, and the command that shows the full log.

## 2. Make a small change

Work and commit as you like. In the default `observe` mode the first commit starts the change by itself, named after your branch, and the commit hook adds a `Harness-Work` trailer. When you are done:

```sh ways-check
npx ways done
```

`ways done` runs ways' integrity checks and your test command once, in a clean checkout of your last commit, and writes the evidence. If something fails it prints what and the next command; fix it, commit and run `ways done` again.

## 3. Deliver something with criteria

For anything bigger than a tweak, say what "done" means before you start: a goal, and one line per criterion with a command that proves it.

```sh ways-check
npx ways outcome open greeting --goal="Greet users" --criterion="AC1:greeting.txt says hi" --verify="AC1:grep -q hi greeting.txt" --review=none
```

ways prints the criteria and their verifiers in one block. That block is what you review, not the diff. Now do the work and commit it:

```sh
echo "hi" > greeting.txt
git add greeting.txt && git commit -m "feat: greeting"
```

Then run `ways done` again. A verifier has to fail on the commit where the work started and pass on yours; `grep -q hi greeting.txt` fails before `greeting.txt` exists, so AC1 counts as backed by a test.

```sh ways-check
npx ways done
```

`--review=none` skipped the independent review so that this tutorial needs no agent. Without it, the default is that a review is required: after `ways done`, `npx ways review` starts a read-only reviewer and records its verdict, and the work closes when nothing is missing. See [Get a review, and an approval](../how-to/review.md).

## 4. Remember something

When you learn something that the next person, or agent, should know about a part of the code:

```sh ways-check
npx ways remember "Greetings are plain text, one line" --path='greeting.txt'
```

It writes one short file under `.ways/knowledge/`. Commit it with the change that taught it. From then on, an agent that opens `greeting.txt` gets that line.

## Where to go next

- [Make a small change](../how-to/small-change.md) and [Deliver something with criteria](../how-to/delivery-with-criteria.md) in more detail.
- [What ways guarantees](../explanation/guarantees.md), and what it leaves to your CI.
- [Commands](../reference/commands.md).
