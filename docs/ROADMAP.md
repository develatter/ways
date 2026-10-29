# Roadmap

This roadmap defines the next milestones for ways. It is the source of planned work; `README.md` remains a product overview.

The product direction is minimal ceremony: the agent decides what to do, the harness supplies context, checks the result and blocks only what breaks a guarantee. Each phase is done when its criteria hold in the test suite and in a packed consumer project, not when its checklist is ticked.

## Done: lean (0.3)

Two ways to work, a change (`ways done`) and an outcome (`ways outcome open` → `ways done`); SDD, plan, tasks, attempts, remediation, discovery and reconciliation are gone. The hook observes by default and refuses only hand-made record changes; verifier-surface changes need approval; memory travels with the change and goes stale by content hash. See [decision 0003](decisions/0003-what-stays-and-what-goes.md) and [docs/acceptance.md](acceptance.md).

Still open from it: an eval run with real models comparing the lean E with the 0.2 E (the corpus and runner are ready; no real run has been recorded).

## Next phases and their exit criteria

### Context at the right moment

- Hooks inject a short packet relevant to what is being touched, including path-scoped rules drawn from memory.
- `AGENTS.md` is a map of the project, not a manual of the harness.
- `ways hook` stays fast enough for the hot path (p95 under 100 ms).

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
