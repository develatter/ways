# Roadmap

This roadmap defines the next milestones for ways. It is the source of planned work; `README.md` remains a product overview.

The product direction is minimal ceremony: the agent decides what to do, the harness supplies context, checks the result and blocks only what breaks a guarantee. Each phase is done when its criteria hold in the test suite and in a packed consumer project, not when its checklist is ticked.

## Done: lean (0.3)

Two ways to work, a change (`ways done`) and an outcome (`ways outcome open` → `ways done`); SDD, plan, tasks, attempts, remediation, discovery and reconciliation are gone. The hook observes by default and refuses only hand-made record changes; verifier-surface changes need approval; memory travels with the change and goes stale by content hash. See [decision 0003](decisions/0003-what-stays-and-what-goes.md) and [docs/acceptance.md](acceptance.md).

Still open from it: an eval run with real models comparing the lean E with the 0.2 E (the corpus and runner are ready; no real run has been recorded).

## Done: context at the right moment

`ways hook <event>` for Claude Code and pi (the brief at session start, only changes afterwards, the guard on record writes, one stop reminder), `ways context --brief`, Claude Code path rules generated from memory, `AGENTS.md` as a project map, and the JSONL event bus. See [decision 0006](decisions/0006-context-at-the-right-moment.md), [docs/CONTEXT.md](CONTEXT.md) and [docs/EVENTS.md](EVENTS.md).

Still open from it: the hook's p95 is above 100 ms on a slow host (about 25–30 ms over a bare Node start; bundling the hook path is the next step); the `memory-convention` eval (inject vs not) has not been run with a real model; lifecycle events from the CLI and inbox items are not in the bus yet.

## Next phases and their exit criteria

### Verification v2

Already in place since lean: one-line criteria with a verifier and a declared strength, review-only criteria forcing a review, evidence written by the harness with the strength recorded. Still to do:

- Evaluate in a clean worktree with the base commit's check contract, and require verifiers to go from red on the base to green on the input.
- Review provenance by session (fresh, read-only, attested by hooks) instead of a reviewer name; signed human approvals (SSH, FIDO key when available).
- `ways verify` in CI re-running the recorded verifiers of the works a pull request closes.

### Control plane

- A local, read-mostly kanban derived from the work state, and an inbox for the orchestrating agent (questions, approvals, blockers, decisions, instructions).
- Bound to localhost, no new runtime dependencies.

### Documentalist

- An agent role that writes only under `docs/wiki/`, in plain Markdown for humans and separate from the OKF memory.
- Pages carry the hashes of the sources they cite, so stale pages are detected mechanically.

Out of scope for now: a Symphony-style dispatcher, an MCP server, ACP/A2A clients, OTLP, SQLite, remote access, GitHub Issues sync, LLM-generated `AGENTS.md`, and mutation testing by default.
