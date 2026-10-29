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
  - src/map/
  - src/memory/
  - src/onboard/
  - src/query/
  - src/run/
  - src/runtime/
  - src/serve/
  - src/upgrade/
  - src/wiki/
  - src/work/
reviewed: 2026-10-29
source_hashes:
  src/adapters/: 29cf3a766fcf
  src/bootstrap/: 7ee75f481939
  src/check/: 3663b9d470dd
  src/config/: 67497055fe55
  src/context/: 0270f89ebae7
  src/domain/: c6dba5267a7b
  src/evals/: b5feed62bb9b
  src/events/: fca1e05a6c84
  src/fs/: 191dbfb51d0a
  src/git/: 20f494255805
  src/hooks/: 4e1f0b01ee74
  src/inbox/: e892db4e2873
  src/integrity/: a8143af052ac
  src/knowledge/: 450e8f9d8696
  src/map/: "8431785e4036"
  src/memory/: ed39e9a3e27a
  src/onboard/: 2b150613a17d
  src/query/: c1dcc3a3f8ed
  src/run/: ef2b84ada112
  src/runtime/: 21e6d4b134a8
  src/serve/: bedcbfa304d2
  src/upgrade/: 70775aec363b
  src/wiki/: 0cc479c6fd9e
  src/work/: eee18ab51091
---

# Modules

What each folder under `src/` is for. `src/cli.ts` dispatches a command to the module that implements it, loading modules on demand so that `ways hook`, which runs on every commit and every agent event, pays for none of the others. `src/commands.ts` is the registry that `ways --help`, the [command reference](commands.md) and the README table are generated from.

| Folder | What it does |
| --- | --- |
| `adapters/` | Renders and installs what connects ways to a coding agent: skills and roles for Claude Code, pi, Codex and Cursor, and the settings or extension that route each agent's events to `ways hook`. Claude Code and pi are the first-class agents. |
| `bootstrap/` | `ways bootstrap`: runs the detected checks once to keep those that work, writes the config, the managed Git hooks and check script, and the files written once (`AGENTS.md` from what was detected, the memory index, the CI job), installs the adapters, then writes `MAP.md` and leaves onboarding pending. |
| `check/` | Runs the configured checks: the check contract, the clean checkout they run in, setup and services around them, processes with timeouts and retries (with the whole output optionally kept in a log), the count of tests that ran, and the one-line-per-area report of `ways check`. |
| `config/` | Reads and validates `.ways/config.json`: enforcement, the review default, the verifier paths. |
| `context/` | What an agent is told: the brief, the memory facts that fit the files in play, the path rules written to `.claude/rules/`, and the two notices about the repository's layers (onboarding pending, `MAP.md` out of date). |
| `domain/` | Types and constants shared everywhere, and the JSON Schema validation of the config, the manifest, work records and reviews. |
| `evals/` | `ways evals`: runs a fixed corpus of tasks against the harness and compares configurations. |
| `events/` | The local event bus: one JSON line per agent hook event, under the Git directory, never in history. |
| `fs/` | Atomic file writes and digests. |
| `git/` | A thin wrapper over the `git` command, and the commit trailers (`Harness-Work`, `Harness-State`, `Harness-Role`). |
| `hooks/` | `ways hook`: the Git commit hooks, the coding-agent hooks, the guard that refuses what would break a guarantee (and confines the sessions ways launches for a role to its paths), the one `ways run` hint for a check run by hand, the per-session state and each agent's payload format. |
| `inbox/` | `ways ask` and `ways inbox`: what agents ask the human and what the human tells them. |
| `integrity/` | Checks that the files ways installed are untouched, and audits the history of work records and trailers (`ways check --history`). |
| `knowledge/` | The OKF memory under `.ways/knowledge`: parsing and validating concepts, and the search indexes built from them. |
| `map/` | `ways map`: what can be read from a repository without an agent (stacks, commands and check candidates from manifests and CI, entry points, test layout, ignored files) and `MAP.md`, rendered from it with the folder notes and a drift marker. |
| `memory/` | `ways remember` and `ways memory`: writing a concept, tying it to code with `paths:` globs, flagging it possibly stale when that code changed, and the facts `ways onboard` seeds: their sources' hashes, unverified until `ways memory confirm`. |
| `onboard/` | `ways onboard` and `.ways/onboarding.json`: the deterministic part of the first session, the launcher of the onboarder agent, and the checks of what it wrote. |
| `query/` | `ways query`: searching the memory. |
| `run/` | `ways run` and `ways check add`: running a check with its whole output in a log, the parsers that turn the output into a summary, new versus already-failing failures, `.ways/checks.json`, and validating a check by running it. |
| `runtime/` | State kept inside the Git directory, outside history: the active work, run logs, the flaky quarantine and per-commit baselines. |
| `serve/` | `ways serve`: the board, derived from records, hooks and worktrees, and the local web server. |
| `upgrade/` | `ways upgrade`: moving a repository installed with 0.2 or 0.3.0-dev.0 to this version (for 0.3.0-dev.0, `MAP.md` out of `AGENTS.md`). |
| `wiki/` | `ways wiki`: the wiki for humans, its checks, and the launcher of the documentalist agent. |
| `work/` | Work records and the life of a work: opening an outcome, `ways done` and its evaluation, the independent review, approvals and their signatures, and `ways verify` for CI. |

The tests in `tests/` drive the compiled CLI in `dist/` for the Git hooks, so build before running a test file directly.
