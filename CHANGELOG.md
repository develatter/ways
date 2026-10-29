# Changelog

## 0.3.0-dev.1 (unreleased pre-release)

The three layers of a repository, generated in its first session instead of filled in by hand ([0012](docs/decisions/0012-three-layers-of-the-first-session.md)).

### Added

- **`ways run [<check>]`**: runs a configured check and prints a summary instead of its output (counts, each failure on one line with its first error lines, new vs already failing at the base, at most 40 lines and 2,000 characters; one line when it passes), keeping the full log under `.git/ways/runs/` (`ways run --show <id> --grep=… --tail=…`). Parsers for vitest, jest, pytest, cargo test, go test, tsc, eslint, ruff and mypy, and a generic reading for anything else. `ways check`, `ways done` and `ways verify` use the same wrapper: the evidence of each check and verifier keeps its summary, run id and log path. `ways check` prints one line per area.
- **Checks detected and validated by running them**: `ways bootstrap` without `--test-command` reads manifests, CI, Makefile, tox/nox and pre-commit (Node/TypeScript, Python, Rust, Go, Java), runs each candidate once and keeps only what works, with its line base, in `commands` and in the new `.ways/checks.json`. `ways check add <name> -- <command>` does it by hand.
- **`MAP.md`**, apart from `AGENTS.md` again: generated from the repository by `ways map`, with folder purposes from `.ways/map-notes.json`; `ways map --check` fails on drift, and the brief and `ways status` mention it.
- **`ways onboard`**: in the first session (announced by the SessionStart hook while `.ways/onboarding.json` is pending), the deterministic part plus an onboarder agent (Claude Code or pi, a new role confined to its paths) that writes folder purposes, 8 to 15 facts with sources, proposed checks and `AGENTS.md` additions; ways validates all of it and marks onboarding done. Never without the human's yes under the default `"onboarding": "ask"`.
- **Seeded facts are unverified** until `ways memory confirm <id>` (a person at a terminal); `ways memory check` refuses one without sources or whose sources or paths name nothing; a changed source marks it stale.
- A one-time hint to use `ways run` when an agent runs a configured check by hand (Claude Code PreToolUse, pi tool result); it never blocks.

### Changed

- `AGENTS.md` is written once from what was detected and validated (commands as `npx ways run <check>`, a link to `MAP.md`, five lines on ways): no placeholders and no table of paths.
- Adding a check to the configuration no longer needs an approval (like adding a test); changing or dropping one still does.
- Bootstrap writes 28 files by default (was 23); the CLI has 44 actions (was 37).

### Upgrading from 0.3.0-dev.0

`ways upgrade --apply` moves the `## Map` table of `AGENTS.md` into `MAP.md` (the purposes you wrote become `.ways/map-notes.json`), removes the template's placeholders and leaves every other line as you wrote it, lists your checks in `.ways/checks.json`, installs the onboarder and leaves onboarding pending (`"onboarding": "off"` to skip it).

## 0.3.0-dev.0 (unreleased pre-release)

ways lean: less ceremony, context through the agents' own hooks, evidence the harness produces, and a local board. Design notes are in [docs/decisions](docs/decisions/README.md) (0003–0010).

### Removed

- **SDD and `plan`**, with everything around them: phases, gates and certifications, tasks and task worktrees, attempts and remediation, memory discovery and reconciliation, `ways quick`, `ways repair`, `ways memory-review`, `.ways/status.json`, the delegated-implementation guard, and the explorer, implementer, qa and sweeper roles (the reviewer stays, joined by a documentalist). There is no legacy mode: old artifacts are ignored ([0003](docs/decisions/0003-what-stays-and-what-goes.md)).
- Codex and Cursor are no longer installed by default (best effort, `--agents=claude,pi,codex,cursor`).

### Changed

- **Two ways to work.** A small change is commit as usual, then `ways done` (the first commit starts it in observe mode; `ways start <id>` names it). A delivery is `ways outcome open` with one-line criteria, each with a `--verify` command, then `ways done` and, when required, `ways review`.
- **The commit hook observes by default** (`enforcement: observe`): it adds the `Harness-Work` trailer itself and refuses only a hand edit of a work record. `enforce` restores the 0.2 behaviour of refusing commits outside a work ([0004](docs/decisions/0004-observe-by-default-and-what-breaks-a-guarantee.md)).
- **One record per work**, `.ways/work/<id>.json`, written only by ways: criteria, evidence, review, approval.
- **Memory is one short fact per file**, written with `ways remember "<fact>" --path=<glob>` and committed with the change; it is flagged possibly stale by the content of the code it covers ([0005](docs/decisions/0005-memory-that-travels-with-the-change.md)).
- **Only `critical` and `high` review findings block.**
- `AGENTS.md` is a map of your project (at most 100 lines; ways takes five), and `CLAUDE.md` imports it.
- Every command works from any directory of the repository, and refuses with a useful message outside one.

### Added

- **Context at the right moment** ([0006](docs/decisions/0006-context-at-the-right-moment.md)): `ways hook <event>` for Claude Code and pi gives the agent a brief (at most 6,000 characters) at session start and only changes afterwards, guards record writes, and reminds once at stop; memory becomes Claude Code path rules; `ways context --brief`; a local JSONL event log.
- **Verification v2** ([0007](docs/decisions/0007-verification-v2.md)): `ways done` evaluates in a clean checkout with the base's checks; verifiers must go red to green, and declare a strength (`proof`, `property`, `test`, `e2e`, or `review-only`); changes to existing tests or check configuration need an approval or an accepting independent review; `ways review` launches a read-only reviewer; SSH-signed approvals; `ways block`; `ways verify --base` for CI, with a workflow bootstrap writes.
- **Control plane** ([0008](docs/decisions/0008-control-plane.md)): `ways serve`, a live board on 127.0.0.1; `ways ask` and `ways inbox`, answered on the board or the CLI and delivered once through the hooks.
- **Wiki for people** ([0009](docs/decisions/0009-wiki-and-documentalist.md)): `ways wiki init|check|stale|update`, with pages stale by source hash and a documentalist agent confined to `docs/wiki/`.
- `ways --help` and `ways <command> --help` from one command registry (37 actions in all).
- An end-to-end smoke test of the packed tarball ([0010](docs/decisions/0010-first-day-release.md)).

### Fixed

- The package ships only what `src/` compiles to: earlier tarballs carried stale compiled modules from previous builds. No source maps are shipped.
- `ways --version` matches the package version.
- Adding a test to an existing test file no longer needs an approval: the verifier checkpoint is judged by what changed inside each file, with `testMarkers` for extra disabling markers, and dependency and build directories are off it ([0011](docs/decisions/0011-verifier-surface-by-content.md)).
- `ways verify` binds an approved test change to the content approved, so a later commit cannot weaken the same file again under the old approval; it reads `enforcement` from the base.
- A review typed in at a terminal (`ways review submit`) no longer satisfies a required review on its own: it also needs the human's `ways approve`.
- The board's columns share the width instead of growing to the longest card text, and stack on phones.
- `ways bootstrap` warns, with the install command, when `package.json` lacks `@develatter/ways` (the CI job needs it); the agent hook uses V8's compile cache.

### Migrating from 0.2.x

1. Update the package: `npm install --save-dev @develatter/ways@next --registry=https://npm.pkg.github.com`.
2. `npx ways upgrade` shows the plan; `npx ways upgrade --apply` applies it. Commit the result.
   - Your check contract and memory carry over; coverage globs become `paths:` on their concepts, and the discovery, reconciliation and index data are removed.
   - `enforcement` becomes `observe`. Set `"enforcement": "enforce"` in `.ways/config.json` to keep refusing commits outside a work.
   - An active quick work becomes the active change: finish it with `ways done`.
   - An active outcome is not carried over (attempts and tasks no longer exist): the upgrade prints the exact `ways outcome open ...` command that reopens it; add a `--verify` per criterion.
   - Active SDD or plan work is dropped. Its artifacts stay in `.ways/` and in history; `.ways/outcomes/`, `.ways/sdd/` and `.ways/plans/` are no longer read and can be deleted.
   - Managed files you edited are never overwritten without `--overwrite=<path>` or `--overwrite-all`. An `AGENTS.md` you edited is kept: replace its ways bullets with the short "Working with ways" section of the new template.
3. Codex or Cursor users: `npx ways adapter install codex` (or `cursor`); they are no longer installed by default.
4. In CI, the upgrade adds `.github/workflows/ways.yml` (when you have none by that name), which runs `ways verify` and `ways wiki check` on pull requests. Make it a required check in place of a `scripts/check.sh --history` gate ([docs/BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md)).
5. Tell your agents nothing: the hooks do. Commands like `/ways-quick` or `/ways-sdd` no longer exist.

## 0.2.x

The phased harness: SDD, plan, quick and outcome modes, tasks and remediation attempts, OKF memory with discovery and reconciliation, provider adapters for Claude Code, Codex, Cursor and pi. See the git tag `pre-self-harness-removal` and the `master` branch.
