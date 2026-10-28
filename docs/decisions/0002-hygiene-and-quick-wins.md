# 0002 — Hygiene before the lean redesign

- Status: accepted
- Date: 2026-10-29
- Decided by: the implementing agent, within the maintainer's brief (minimal ceremony; verifiable results)

## Context

After the self-hosted harness was removed, several parts of the package still assumed that ways was developed with itself: bootstrap templates pointed at `src/` and `assets/`, `check.sh` and the hook preferred a `dist/cli.js` in the consumer, `HARNESS_VERSION` was a stale constant (0.2.0 against a 0.2.2 package), the e2e depended on the JSON shape of `npm pack`, and `--help` printed one line.

## Decisions

- **Version.** `package.json` is the only source (`src/version.ts` reads it). The package is `0.3.0-dev.0`; only `master` publishes. An upgrade between versions with no registered migration only moves the recorded version when the target is newer, and refuses when the repository was written by a newer ways.
- **CLI help.** One registry (`src/commands.ts`) feeds `ways --help`, `ways <command> --help`, `ways help <command>`, the README command table and a test that fails when `cli.ts` dispatches a command the registry lacks. Usage errors append a pointer to the command help. The README table is regenerated with `UPDATE_README=1 npx vitest run tests/commands.test.ts`, not with a build step.
- **Templates.** No template written by bootstrap mentions `src/`, `assets/`, `ROADMAP`, `HANDOFF` or `docs/decisions` (checked on a real bootstrap, adapters included). `MAP.md` now tells the consumer to describe their own project. `scripts/check.sh` and the `commit-msg` hook no longer run a `dist/cli.js` found in the consumer repository (a CLI project would execute its own build); they use `$WAYS_CLI` (tests) or the installed package.
- **`CLAUDE.md` imports `AGENTS.md`** (`@AGENTS.md`) instead of being a symlink: it works on checkouts without symlink support (where a symlink degrades to a one-line text file that hides the instructions) and leaves room for Claude-specific notes. An existing `CLAUDE.md` is kept and gets the import line appended; a symlink from an earlier bootstrap still passes integrity.
- **Guard.** It blocks tool writes to outcome `reviews/` like `approvals/`; `2>&1`, `>&2` and redirections to `/dev/null` are not writes; messages name outcome and give the next command; they print real newlines (they printed a literal `\n`).
- **Review.** Only `critical` and `high` findings block, until `fixed`. `medium` and `low` never block whatever their disposition and are shown by `review submit` and `context`. The reviewer's `verdict` is still honoured, so a reviewer can stop the work with a `high` finding or a `fail`. We did not make `fail` require a `high` finding: it would break the "reviewer is the judge" contract for little gain.

## Consequences

- Repositories bootstrapped before this change keep working; `ways upgrade` re-renders the templates (checklist approval for edited files).
- `ways --version` equals the published package, so the "which version is installed" question has one answer.
- The package requires Node 22; CI covers Node 22 and 24 with one build.
- Still open: the templates still describe the SDD and plan modes until the lean phase removes them.
