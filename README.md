# ways

A minimal, agent-agnostic development harness with Git-backed workflows, deterministic SDD gates, and living OKF v0.2 memory.

> The core workflow, mechanical enforcement, human approvals and digest-bound reviews are implemented and tested. See the [roadmap](docs/ROADMAP.md) for planned milestones.

## Why

Long-running coding agents tend to lose state, skip process, perform unnecessary rituals, and preserve stale documentation as truth. ways separates those concerns:

- **Git** is the immutable work log.
- **OKF memory** describes the repository as it exists now.
- **Explicit modes** let the engineer choose the required ceremony.
- **Deterministic gates** prevent SDD phases from being skipped.
- **Portable agent archetypes** keep the core independent of any provider.

## Requirements

- Linux or macOS
- Node.js 20 or newer
- Git

## Installation

```bash
npm install --save-dev @develatter/ways --registry=https://npm.pkg.github.com
npx ways bootstrap --test-command='["npm","test"]'
scripts/check.sh
```

Bootstrap creates the repository contract, including `AGENTS.md`, `MAP.md`, `.ways/`, `scripts/check.sh`, a `CLAUDE.md` symlink to `AGENTS.md`, the managed `commit-msg` hook, and the adapter files for every supported agent (Claude Code, Codex, Cursor, pi). Commit the result; from then on the agent you talk to follows the harness.

To configure multiple reproducible environment checks, pass a JSON command contract. Each command is an argument array; only names listed in `required` execute, in the stable order `test`, `lint`, `typecheck`, `build`, `e2e`. A missing required command is reported as unavailable, while non-required checks are skipped. The legacy `testCommand` remains the fallback:

```bash
npx ways bootstrap --test-command='["npm","test"]' \
  --commands='{"test":["npm","test"],"lint":["npm","run","lint"],"required":["test","lint"],"timeoutMs":120000}'
```

The same contract can opt in to an environment: a `setup` argument array and `services`, each `{"name", "command", "ready", "timeoutMs"}` where `ready` is exactly one bounded probe (`{"command": [...]}`, `{"tcp": {"port": 5432}}` or `{"http": "http://127.0.0.1:3000/health"}`; readiness defaults to 30000ms):

```json
"setup": ["npm", "ci"],
"services": [{ "name": "api", "command": ["npm", "start"], "ready": { "http": "http://127.0.0.1:3000/health" }, "timeoutMs": 20000 }]
```

Setup and services run only at execution boundaries: `quick finish`, `plan finish`, `sdd advance` out of validate and close, `sdd validate` (and its replay), and `ways check --with-services`. Plain `ways check`, `ways status` and `ways repair diagnose` never run setup or start services. Services start in their own process groups after setup, before the checks; their output goes to `.ways/runtime/services/<name>.log` (ignored by Git). A failed or timed-out setup, a service that never becomes ready, or one that exits before readiness or while checks run skips the remaining checks and fails the evaluation, with the result under `environment` in the check output and validation records. Afterwards, and on timeout, failure, SIGINT or SIGTERM, the harness terminates only the process groups it started.

## Using the harness day to day

You never need the CLI: you talk to your coding agent and it drives `ways` for you. The commands below are the same in every agent, only the invocation prefix changes (see the provider table).

| You want | Say or type | What happens |
| --- | --- | --- |
| Know where things stand | `/ways-status` | The agent reads `.ways/status.json` and reports mode, work, phase, gate |
| Ask about the code or memory | `/ways-query token rotation` | Read-only search, no state, no commit |
| A small change | `/ways-quick button-spacing fix the padding` | Opens quick work, implements, runs `scripts/check.sh`, commits once |
| A change worth a proposal | `/ways-plan auth-refresh` | Writes and commits a plan; you decide execute, promote or abandon |
| A long delivery | `/ways-sdd auth-refresh --supervised --delegated` | Phased delivery with certified gates; delegated means subagents implement |

Plain language works too: "fix the padding on the button" makes the agent open a quick work, because commits outside a work are rejected by the hook. During a work, ask the agent to advance, finish or cancel; those are agent actions, not commands you run.

Supervised SDD stops at intake, plan and close until you approve in your own terminal:

```bash
npx ways approve
```

It shows the work, phase, gate and content digest, asks you to type the phase name, and writes an approval that dies if anything changes afterwards. Agents cannot run it: it refuses without a TTY.

If something looks wrong, `npx ways status`, `npx ways check` and `npx ways repair diagnose` explain the state without changing it.

## Work modes

| Mode | Purpose | Persistent ceremony |
| --- | --- | --- |
| `query` | Read-only exploration and memory search | None |
| `quick` | Small direct change | State during work, checks, one final commit |
| `plan` | Versioned proposal that can execute, promote, or be abandoned | Proposed plan until resolved |
| `sdd` | Strict phased delivery, inline or multiagent | State, gates, tasks, review, validation |

```bash
npx ways query "token rotation"
npx ways quick start button-spacing
npx ways plan start auth-refresh
npx ways sdd start auth-refresh --supervised
npx ways status
```

## SDD lifecycle

```text
intake → explore → assess → specify → plan → decompose
→ implement → review → validate → reconcile-memory → close
```

Each transition validates the previous certification in Git, updates JSON state, and creates an atomic commit with machine-readable trailers. `assess` can explicitly downgrade small work to `quick` or `plan`. Run `npx ways sdd validate` at the validate phase to run the configured checks against a clean committed tree. On failure it commits an attempt-scoped record containing the exact results, deterministic digest, and input commit/tree; then `npx ways sdd remediate <implement|decompose|plan|specify> --reason=<text>` links that committed record, starts a new attempt, and never rewrites the prior attempt. A passing `sdd validate` leaves the normal `sdd advance` path available.

SDD runs `inline` (the agent may implement itself) or `--delegated` (the session is the orchestrator and never edits production code: implementation always arrives through subagent task worktrees, integrated in dependency order, in parallel when independent). The implement gate in delegated mode rejects any commit that was not integrated from a task. Provider guards block main-worktree production writes, including write-like shell commands, throughout delegated `implement`, `review`, and `validate`, while allowing phase artifacts, Ways orchestration, and task worktrees.

Parallel tasks run in isolated worktrees. The core creates task packets and integrates traced commits, but deliberately does not launch agents. Review is delegated, read-only, severity-gated, and required even when implementation is inline. The review JSON carries the digest printed by `ways review digest`; submit and the gate recompute it, so a review dies with any later edit.

Supervised profile (`--supervised`) opens the work with a traced commit that fixes the profile in Git, and adds human gates at intake, plan and close. The way through is `ways approve`, run by the human in a real terminal: it refuses without a TTY, shows the gate and digest, asks for the phase name to be typed, and writes `.ways/sdd/<id>/approvals/<phase>.json` bound to work, phase, gate commit and content digest. The gate, the commit-msg hook and the provider guard all verify that binding; there is no flag an agent can pass, flipping the profile on disk is rejected, and any edit after approval invalidates it. Validation failure records likewise bind an immutable input commit/tree and digest. Every verifier re-runs the recorded checks in a fresh detached worktree at that input and rejects a result that does not reproduce; it never switches the caller's worktree to historical content. What remains unverifiable locally is authorship: an actor with unrestricted shell access can fabricate a record only when it describes a failure that the replay also observes. These checks establish Git linkage and reproducible results, not the identity of a local author.

## Outcome workflow (experimental)

An opt-in alternative to SDD that constrains results instead of reasoning steps. SDD stays the default.

```text
open → execute → evaluate → close
```

```bash
npx ways outcome open greeting --goal="Greet users" --criterion="AC1:greeting.txt says hi"
npx ways task add write --title="Write the greeting" && npx ways task prepare write
# implement and commit inside the task worktree, then:
npx ways task integrate write --commits=<sha>
# map every criterion in .ways/outcomes/greeting/attempts/0/evidence.json
npx ways outcome evaluate        # runs the configured checks against the executed input
npx ways outcome remediate --reason=<text>  # new attempt after a recorded failure or blocking review
npx ways review digest           # an independent reviewer binds a review to this digest
npx ways review submit review.json
npx ways outcome close
```

The goal and stable criterion identifiers are committed at open and cannot change afterwards. The first slice uses a fixed conservative policy: production changes arrive only through integrated task worktrees, `evaluate` refuses missing criterion evidence or failing checks, and `close` refuses without a passing, fresh, digest-bound review. The commit hook, `ways check --history`, `ways status` and `ways repair diagnose` all understand the workflow and reject skipped transitions, direct commits and forged or tampered evidence.

Remediation is additive. A failing `evaluate` commits a replayable check-failure record for the attempt; a blocking review stays pending. `ways outcome remediate --reason=<text>` then opens attempt n+1 from that evidence, and the attempt needs new tasks, its own evaluation and a fresh review. Artifacts of earlier attempts are immutable, and the hook and the history audit reject forged failures, remediations and rewrites.

Memory assurance is chosen at open with `--memory=none|normal|high` (default `normal`) and stored in the immutable spec; there is no blanket reconciliation phase:

- `none`: the increment must not change `.ways/knowledge/`; evaluate and close refuse it.
- `normal`: relevant sourced knowledge updates travel in task commits like any other change. The evaluation's integrity checks enforce OKF validity, sources and indexes; no separate memory review or commit is needed.
- `high`: close also requires a passing memory review bound to `ways outcome memory-review digest` (the evaluated input plus its exact knowledge diff), recorded with `ways outcome memory-review submit review.json`. A missing, blocking or stale memory review blocks close, the hook and the history audit.

Progress belongs in the outcome's evidence, never in knowledge. Legacy SDD reconcile-memory, `ways memory commit` and release reconciliation keep their original semantics.

## Knowledge

The current repository memory is an OKF v0.2 bundle under `.ways/knowledge/`. Supported core types are `system`, `component`, `convention`, `decision`, and `faq`; custom OKF types remain valid.

Agent-authored knowledge starts as a sourced `draft`. Stable concepts require deterministic or human verification. Search, graph, and catalog indexes under `.ways/indexes/` are derived and reproducible:

```bash
npx ways memory check
npx ways memory index
npx ways query "authentication convention"
```

## Integrity and recovery

```bash
scripts/check.sh
npx ways repair diagnose
npx ways upgrade
```

The canonical check validates managed files, schemas, state/Git consistency, compact agent prompts, OKF, derived indexes, and the configured unit-test command. Divergence fails closed; repair and destructive rollback always require explicit commands.

## Mechanical enforcement

Compliance does not depend on the agent obeying its prompt:

- Bootstrap installs a managed `commit-msg` hook under `.ways/hooks/` and sets `core.hooksPath`. Any commit not traced to the active work with a matching `Harness-Work` trailer is rejected. Small edits open `ways quick start <id>` first.
- `ways check --history [--since=<ref>] [--to=<ref>]` audits every commit in the selected ancestry range (or after `historySince` in config) for trailers and unbroken SDD certification chains. CI sets `--to` to the pull-request head so GitHub's synthetic merge commit is not treated as authored history. `scripts/check.sh` runs the audit, so a `--no-verify` bypass still fails in CI.
- With an active work, integrity also fails on any commit after its base that lacks the work trailer.
- Certifying a supervised human gate requires a bound approval artifact in the same commit; the closing commit must delete the one committed for `close`. Tool writes under `approvals/` and `reviews/` are blocked by the guard.

## Provider adapters

`assets/adapters/` is the canonical source: five commands, five roles (explorer, implementer, reviewer, qa, sweeper) with prompts of at most six lines, a statusline script, and a commit guard. The orchestrator is not a subagent: it is the main agent the human talks to, instructed by `AGENTS.md`. Bootstrap renders every registered provider from that source; `ways adapter install <provider> [--force]` regenerates one. Rendered files are hashed in the manifest, verified by integrity, and re-rendered by `ways upgrade` after checklist approval.

Each adapter follows the provider's current official documentation. Every one ships the same guard script fed with JSON on stdin: it blocks `git commit` without an active work and blocks main-worktree production writes during delegated implementation, review, and validation.

| Provider | Commands | Roles | Guard | Status |
| --- | --- | --- | --- | --- |
| Claude Code | `.claude/commands/ways-*.md`, invoked `/ways-quick` | `.claude/agents/ways-*.md`, read roles get `tools` and `permissionMode: plan` | `PreToolUse` in `.claude/settings.json` (merged) | `statusLine` wrapped around yours |
| Codex CLI | `.agents/skills/ways-*/SKILL.md`, invoked `$ways-quick` | `.codex/agents/ways-*.toml`, read roles get `sandbox_mode = "read-only"` | `PreToolUse` in `.codex/hooks.json` (merged) | not supported by Codex |
| Cursor | `.cursor/skills/ways-*/SKILL.md`, invoked `/ways-quick` | `.cursor/agents/ways-*.md`, read roles get `readonly: true` | `beforeShellExecution` and `preToolUse` in `.cursor/hooks.json` (merged, fail closed) | not supported per project |
| pi | `.pi/prompts/ways-*.md`, invoked `/ways-quick` | `.pi/agents/ways-*.md` for the subagent extension, read roles get `tools: read, grep, find, ls` | `.pi/extensions/ways/index.ts` on `tool_call` | same extension, `setStatus` in the footer |

Provider notes: Codex and Cursor only load project hooks in trusted projects, and pi asks for project trust before loading `.pi/`; Codex has no project prompts, so commands are repository skills; pi has no built-in subagents, so the role files target its documented subagent extension. `AGENTS.md` is read natively by all four. Advancing, finishing and cancelling are done by the agent through the CLI when the human asks; they are not user commands.

## Observable status

`.ways/status.json` is a tracked, derived projection of the active state: `active`, `mode`, `id`, `status`, `phase`, `profile`, `humanGate`, `gateCommit`, `updatedAt`, and, for remediation attempts after attempt zero, `attempt` plus `remediation`. It is rewritten on every transition, verified by integrity, and cheap to read from any agent statusline. `ways status --json` prints the same object. Attempt-zero output keeps its original shape.

`ways context [--json]` prints a resumable packet for a fresh session (`schemaVersion: 1`): HEAD, the active work (mode, stage or phase, attempt, profile, uncommitted paths, and the recorded remediation on later attempts), its tasks with the ones genuinely ready (every dependency completed and its commits reachable from HEAD), every outcome in the repository with its status (`open`, `closed`, `cancelled`, `incomplete`), and links (path and title) to relevant OKF concepts. For outcome work it adds the committed goal and criteria, per-criterion evidence (`missing`/`filled`) and evaluation (`absent`, `stale` when anything close would refuse changed since the evaluated input, including evidence edited after evaluation, `passed`, `failed`), the review status (`absent`, `invalid`, `stale` on digest mismatch, `pass`, `fail`) and the remaining blockers. An idle repository yields `active: null`. Context never writes anything, contains no wall-clock time, and reports `divergence` from the same checks as `ways repair diagnose` instead of failing.

Upgrades compare managed-file hashes and never overwrite modified files without checklist approval.

## Harness evals

`ways evals run` grades a fixed task corpus in disposable repositories under the no-ways (A), checks-only (B) or full-sdd (D) harness, and `ways evals compare` builds a report that links every score to its raw result files and keeps task success apart from harness compliance. See [docs/EVALS.md](docs/EVALS.md).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
scripts/check.sh
```

The implementation lives in `src/`, bootstrap resources in `assets/`, and integration tests in `tests/`. Do not edit generated `dist/` files.

## Current test baseline

- Contract, Git, bootstrap, integrity, mode, SDD, repair, upgrade, OKF, indexing, review, worktree, and baseline end-to-end coverage
- End-to-end SDD lifecycle test
- Packed-consumer bootstrap and canonical check coverage
- GitHub Actions using the same `scripts/check.sh` entrypoint

## License

MIT
