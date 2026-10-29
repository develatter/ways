# Roadmap

What is done and what is pending, in one page. `README.md` is the product overview; [CHANGELOG.md](../CHANGELOG.md) lists changes per version.

The product direction is minimal ceremony: the agent decides what to do, the harness supplies context, checks the result and blocks only what breaks a guarantee. Each phase is done when its criteria hold in the test suite and in a packed consumer project, not when its checklist is ticked.

## Done: lean (0.3)

Two ways to work, a change (`ways done`) and an outcome (`ways outcome open` → `ways done`); SDD, plan, tasks, attempts, remediation, discovery and reconciliation are gone. The hook observes by default and refuses only hand-made record changes; verifier-surface changes need approval; memory travels with the change and goes stale by content hash. See [decision 0003](decisions/0003-what-stays-and-what-goes.md) and [docs/acceptance.md](acceptance.md).

Still open from it: an eval run with real models comparing the lean E with the 0.2 E (the corpus and runner are ready; no real run has been recorded).

## Done: context at the right moment

`ways hook <event>` for Claude Code and pi (the brief at session start, only changes afterwards, the guard on record writes, one stop reminder), `ways context --brief`, Claude Code path rules generated from memory, `AGENTS.md` as a project map (since 0.3.0-dev.1 the map is `MAP.md`, generated), and the JSONL event bus. See [decision 0006](decisions/0006-context-at-the-right-moment.md), [docs/CONTEXT.md](CONTEXT.md) and [docs/EVENTS.md](EVENTS.md).

Still open from it: the hook's p95 is above 100 ms on a slow host (about 25–30 ms over a bare Node start; bundling the hook path is the next step); the `memory-convention` eval (inject vs not) has not been run with a real model; lifecycle events from the CLI and inbox items are not in the bus yet.

## Done: verification v2

Evaluation in a clean, reused checkout with the base's check contract; verifiers red on the base and green on the input (a green-on-base verifier counts as review-only); retries with a flaky quarantine; a test-count ratchet; the verifier checkpoint (changed tests, check files, verifier scripts) approved by the human or accepted by an attested review; independent review by configuration (`ways review` launches a read-only reviewer process; the Claude Code `ways-reviewer` subagent is recorded by its hooks); SSH-signed approvals against the base's `allowed_signers`; `ways block`; `ways verify --base` in CI with a consumer workflow; adversarial regression tests and corpus. See [decision 0007](decisions/0007-verification-v2.md) and [docs/VERIFICATION.md](VERIFICATION.md).

Still open from it: the adversarial corpus has not been run with real models (target: no closed `tamper-test`/`tamper-config` shortcut in five runs per agent); the ratchet only reads common runners' summaries, and in CI only finds a baseline in committed evidence; a pi reviewer is a process (pi has no subagents); in-toto attestations of `ways verify` and mutation testing are not done.

## Done: control plane

`ways serve`: a live board on 127.0.0.1 of every worktree's work across registered repositories, derived from worktrees, records, the last run, the event bus and the inbox; a typed inbox in files (`ways ask [--wait]`, `ways inbox list|show|answer|close|tell`, `--json` everywhere) whose answers and instructions the hooks deliver once; `ways block` in the inbox; approvals from the board where signatures are not required; one static page under 60 KB, en/es; a `ways-orchestrator` skill; `--demo`. See [decision 0008](decisions/0008-control-plane.md) and [docs/CONTROL_PLANE.md](CONTROL_PLANE.md).

Still open from it: the round trip is tested with Claude Code and pi hook payloads, not yet with live agents; liveness depends on hook events, and Claude Code only reports guarded and file-writing tools, so a long shell command reads as stalled after 10 minutes; an idle agent gets an answer only at its next prompt; inbox transitions are not in the event bus.

## Done: wiki for humans and the documentalist

`docs/wiki/` in plain Markdown (Diátaxis folders, no generator) whose pages carry the files they document and a hash of each, so `ways wiki check` finds stale pages, broken links and anchors, bad `ways-check` examples and uncovered modules or commands; `ways wiki stale`; `ways wiki update`, which launches a documentalist agent (`claude -p`, `pi -p` or any command) with a brief and a minimal tool set, compares the tree and HEAD afterwards and stamps what it wrote; a session with role `documentalist` on the event bus and the board. The wiki is mechanically apart from the OKF memory: context and indexes ignore it, the role cannot write or commit outside it, and a memory cannot cite it. The wiki of ways itself is `docs/wiki`, checked in CI. See [decision 0009](decisions/0009-wiki-and-documentalist.md) and [docs/WIKI.md](WIKI.md).

Still open from it: the `claude -p` and `pi -p` invocations are tested with fake agents, not yet run against the real binaries; no `wiki.stale` nudge to the inbox when a work closes; example blocks are checked against the registry, not executed; external links are not checked.

## Done: ready for the first day (0.3.0-dev.0)

An end-to-end smoke test of the packed tarball in `npm test` (bootstrap, the brief in Claude Code and pi, a change, a delivery, a block, a question answered on the board and delivered by the hooks, the wiki, `ways verify`); a tarball with only what `src/` compiles to; every command usable from any directory of the repository; the README, CHANGELOG with migration notes from 0.2.x, and the ADR index. See [decision 0010](decisions/0010-first-day-release.md).

## Done: the three layers of the first session (0.3.0-dev.1)

The baseline (`AGENTS.md` written once from what was detected and validated, `MAP.md` generated apart from it, the roles, skills and hooks), the memory (facts seeded by `ways onboard` with sources hashed by ways, unverified until `ways memory confirm`) and the verification layer (`ways run`: the real command, a summary with new vs already-failing failures, the full log kept; checks detected from manifests and CI and kept only when they ran; `ways check`, `ways done` and `ways verify` on the same wrapper). See [decision 0012](decisions/0012-three-layers-of-the-first-session.md).

Still open from it: the onboarder and the PreToolUse `additionalContext` hint are exercised with stand-in agents and recorded payloads, not live; the parsers' fixtures are written to each tool's format (only Node is on the development host), so the next step is recorded output from real projects per tool; confirmation of a seeded fact by use (a `done` that touched its area without contradicting it) is not done, only by a person; a check whose validation run times out is kept as slow with an unknown line base; `ways run` compares only with runs of the same command on the base commit, and in CI only with the committed line base.

## Pending, in the order we would do them

Each item is done when its exit criterion holds, not when its checklist is ticked.

1. **Evals with real models (F1), within a fixed budget.** Configurations B, C and E with Claude Code (and pi), five repetitions each, plus the adversarial corpus. Exit: a comparable report per agent in `docs/evals/` with tokens, cost, invocations and violations; no closed `tamper-test` or `tamper-config` shortcut in five runs per agent; the `memory-convention` comparison (brief vs. no brief). Until this runs, nothing here is measured against a real agent.
2. **Light dogfooding.** The proposal in [DOGFOODING.md](DOGFOODING.md): a published, pinned version, `observe` mode, `AGENTS.md` as a map, `WAYS_DISABLE=1` as the switch, `ways verify` informative in CI for one month. Exit: a month of event metrics read, and no false refusal.
3. **Live agents.** Run the hooks, `ways review` and `ways wiki update` against the real `claude` and `pi` binaries (today: recorded payloads and stand-in agents). Exit: the smoke test's session replayed by a live agent of each kind.
4. **Hook latency.** Measured on 2026-10-29 on the development host (200 runs per event, nothing else running): agent hook p95 112–138 ms, against 89 ms for a bare `node -e 0`. Most of the cost is Node's own start; bundling the hook path into one file should take most of the remaining 25–50 ms. Exit: p95 under 100 ms where `node -e 0` is under 60 ms.
5. **Attestations.** Sign the `ways verify` report as an in-toto attestation, so evidence can travel outside the repository.
6. **Mutation testing, opt-in.** A run that checks a criterion's verifier fails on mutants of the code it covers, recorded in the evidence; never on by default.
7. Smaller items listed as "still open" above (inbox transitions in the event bus, the `wiki.stale` nudge, external links in the wiki check).

Not now, and why: a Symphony-style dispatcher, an MCP server and ACP/A2A clients (ways must first prove it helps one agent at a time; the hooks already reach the agents that matter), OTLP and SQLite (files in the Git directory are enough at this scale), remote access and GitHub Issues sync (the board is local on purpose), an LLM-generated `AGENTS.md` (the evidence is against it), and mutation testing by default (too slow for the loop).
