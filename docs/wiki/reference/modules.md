---
title: Modules
kind: reference
sources:
  - src/adapters/
  - src/bootstrap/
  - src/check/
  - src/config/
  - src/context/
  - src/domain/
  - src/evals/
  - src/events/
  - src/fs/
  - src/git/
  - src/hooks/
  - src/inbox/
  - src/integrity/
  - src/knowledge/
  - src/memory/
  - src/query/
  - src/runtime/
  - src/serve/
  - src/upgrade/
  - src/wiki/
  - src/work/
reviewed: 2026-10-29
source_hashes:
  src/adapters/: 29cf3a766fcf
  src/bootstrap/: 3331e2cd77ca
  src/check/: b449868b5011
  src/config/: 67497055fe55
  src/context/: b0f1bbaa4f4e
  src/domain/: c6dba5267a7b
  src/evals/: b5feed62bb9b
  src/events/: fca1e05a6c84
  src/fs/: 191dbfb51d0a
  src/git/: 20f494255805
  src/hooks/: 077a1f620f34
  src/inbox/: e892db4e2873
  src/integrity/: a8143af052ac
  src/knowledge/: 450e8f9d8696
  src/memory/: a49d2c83b764
  src/query/: c1dcc3a3f8ed
  src/runtime/: 21e6d4b134a8
  src/serve/: bedcbfa304d2
  src/upgrade/: 2f2c9cc2d229
  src/wiki/: 0cc479c6fd9e
  src/work/: eee18ab51091
---

# Modules

What each folder under `src/` is for. `src/cli.ts` dispatches a command to the module that implements it, loading modules on demand so that `ways hook`, which runs on every commit and every agent event, pays for none of the others. `src/commands.ts` is the registry that `ways --help`, the [command reference](commands.md) and the README table are generated from.

| Folder | What it does |
| --- | --- |
| `adapters/` | Renders and installs what connects ways to a coding agent: skills and roles for Claude Code, pi, Codex and Cursor, and the settings or extension that route each agent's events to `ways hook`. Claude Code and pi are the first-class agents. |
| `bootstrap/` | `ways bootstrap`: writes the config, the managed Git hooks and check script, and the files written once (`AGENTS.md`, the memory index, the CI job), then installs the adapters. |
| `check/` | Runs the configured checks: the check contract, the clean checkout they run in, setup and services around them, processes with timeouts and retries, and the count of tests that ran. |
| `config/` | Reads and validates `.ways/config.json`: enforcement, the review default, the verifier paths. |
| `context/` | What an agent is told: the brief, the memory facts that fit the files in play, and the path rules written to `.claude/rules/`. |
| `domain/` | Types and constants shared everywhere, and the JSON Schema validation of the config, the manifest, work records and reviews. |
| `evals/` | `ways evals`: runs a fixed corpus of tasks against the harness and compares configurations. |
| `events/` | The local event bus: one JSON line per agent hook event, under the Git directory, never in history. |
| `fs/` | Atomic file writes and digests. |
| `git/` | A thin wrapper over the `git` command, and the commit trailers (`Harness-Work`, `Harness-State`, `Harness-Role`). |
| `hooks/` | `ways hook`: the Git commit hooks, the coding-agent hooks, the guard that refuses what would break a guarantee, the per-session state and each agent's payload format. |
| `inbox/` | `ways ask` and `ways inbox`: what agents ask the human and what the human tells them. |
| `integrity/` | Checks that the files ways installed are untouched, and audits the history of work records and trailers (`ways check --history`). |
| `knowledge/` | The OKF memory under `.ways/knowledge`: parsing and validating concepts, and the search indexes built from them. |
| `memory/` | `ways remember` and `ways memory`: writing a concept, tying it to code with `paths:` globs, and flagging it possibly stale when that code changed. |
| `query/` | `ways query`: searching the memory. |
| `runtime/` | State kept inside the Git directory, outside history: the active work, run logs, the flaky quarantine and per-commit baselines. |
| `serve/` | `ways serve`: the board, derived from records, hooks and worktrees, and the local web server. |
| `upgrade/` | `ways upgrade`: moving a repository installed with 0.2 to this version. |
| `wiki/` | `ways wiki`: the wiki for humans, its checks, and the launcher of the documentalist agent. |
| `work/` | Work records and the life of a work: opening an outcome, `ways done` and its evaluation, the independent review, approvals and their signatures, and `ways verify` for CI. |

The tests in `tests/` drive the compiled CLI in `dist/` for the Git hooks, so build before running a test file directly.
