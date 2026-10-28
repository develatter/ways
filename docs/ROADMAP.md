# Roadmap

This roadmap defines the next milestones for ways. It is the source of planned work; `README.md` remains a product overview.

## 1. Transactional safety

Make state updates, staging, and gate commits recoverable as one logical transaction.

- Add fault-injection coverage before and after writes, staging, commits, and cleanup.
- Define explicit recovery states for failed cherry-picks and partial worktree cleanup.
- Never infer progress silently or discard project changes.

## 2. Trustworthy memory

Make repository memory verifiable and maintainable over time.

- Verify local sources against paths and Git revisions.
- Add promotion, deprecation, freshness, and FAQ workflows.
- Detect contradictory active concepts without inventing a winner.
- Make `ways query` use the derived search index.

## 3. Installation and CLI hardening

Validate the package as a consumer would use it and make the CLI predictable.

- Installation from `npm pack` as a consumer devDependency is tested (`npm run test:e2e`).
- Command help comes from one registry (`ways --help`, `ways <command> --help`); still open: robust argument parsing, stable exit codes, and structured output.
- Improve bootstrap repository detection and require confirmation for inferred configuration.
- Add an idempotent migration and rollback fixture.

## 4. Adapter validation and approval evolution

Validate provider integrations in their real environments and strengthen human approval options.

- Exercise the pi extension and Codex/Cursor hook payloads in live sessions.
- Preserve the six-line role-prompt limit and fail-closed guard behavior.
- Evaluate a remote or signed approval channel for humans without a local terminal.

## Next phases and their exit criteria

The product direction is minimal ceremony: the agent decides what to do, the harness supplies context, checks the result and blocks only what breaks a guarantee. The backlog above is picked up only where it serves these phases. Each phase is done when its criteria hold in the test suite and in a packed consumer project, not when its checklist is ticked.

### Lean

- Two ways to work, `quick` and `outcome`; the phased SDD flow and `plan` are gone from code, templates, schemas, evals and docs. Old SDD artifacts in a consumer repository are ignored, at most with a one-time notice.
- The commit hook observes by default and rejects only commits that break a guarantee; trailers are added by the harness, not typed by the agent.
- Worktree isolation is optional; independent review is configured, not declared by the agent, and only `critical` and `high` findings block.
- Memory needs no discovery, reconciliation or progress records: a short sourced fact can be captured when it is learned and goes stale by the hash of its sources.
- Changing or deleting existing tests, or the checks configuration, needs approval; adding tests does not.

### Context at the right moment

- Hooks inject a short packet relevant to what is being touched, including path-scoped rules drawn from memory.
- `AGENTS.md` is a map of the project, not a manual of the harness.
- `ways hook` stays fast enough for the hot path (p95 under 100 ms).

### Verification v2

- Every acceptance criterion is one line with an executable verifier and declares its strength (`proof`, `property`, `test`, `e2e` or `review-only`); a criterion without a strong verifier is marked and needs an independent review.
- The evidence is produced by the harness (a verifier that goes from red to green on a clean tree), never typed by the agent; its strength is recorded in the evidence.
- CI runs the same verification and is the final judge.

### Control plane

- A local, read-mostly kanban derived from the work state, and an inbox for the orchestrating agent (questions, approvals, blockers, decisions, instructions).
- Bound to localhost, no new runtime dependencies.

### Documentalist

- An agent role that writes only under `docs/wiki/`, in plain Markdown for humans and separate from the OKF memory.
- Pages carry the hashes of the sources they cite, so stale pages are detected mechanically.

Out of scope for now: a Symphony-style dispatcher, an MCP server, ACP/A2A clients, OTLP, SQLite, remote access, GitHub Issues sync, LLM-generated `AGENTS.md`, and mutation testing by default.
