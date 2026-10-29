# 0007 — Verification v2: the harness produces the evidence

- Status: accepted
- Date: 2026-10-29
- Decided by: the implementing agent, within the maintainer's brief (results verifiable, the agent cannot pass what did not pass, no new ceremony; CI is the final judge; reviews by configuration; signed approvals with OpenSSH)

## Context

After lean (0003, 0004) ways already wrote the evidence itself, but it ran the checks in the working tree with the increment's own configuration, accepted any verifier that passed (even one that passed before the work), took the reviewer's name on trust, approved on a TTY alone, and had no exit for impossible tasks. Those are the shortcuts agents take (editing tests, loosening checks, self-review, faking approvals). The constraint: no new steps for the agent; move the work into the harness.

## Decision

1. **Clean checkout, reused.** `ways done` evaluates in one detached worktree per repository under `$TMPDIR/ways-eval/` (outside the tree, so test runners' ignore rules for `.git` never interfere), reset with `checkout --force` and `clean -ffdx` except dependency directories. Setup runs there, cached by a digest of the setup command and lockfiles. *Deviation:* with no setup configured, ways links the working tree's `node_modules`/`.venv` instead of failing every Node project on its first clean run; the evidence records it and CI installs from scratch. `--fast` / `"evaluation": "fast"` runs in place, without red-on-base, for slow setups.
2. **The base's contract** runs, always. A changed contract is still a verifier change (approval), and takes effect for later works once merged. A work that removes a check the base still runs cannot close on its own: the agent blocks and the human merges the contract change. That is rare and safer than letting an increment pick its judge.
3. **Red on the base, not a new flag.** Each verifier also runs on the base (once per base and command). A green-on-base verifier downgrades the criterion to `review-only` instead of failing it, so "keeps working" criteria stay possible but need a reviewer. `test` is the default strength, `e2e` is inferred; the summary line reports what backs the delivery.
4. **Retries and quarantine**: two retries for checks and verifiers; a pass after a failure is flaky, recorded and quarantined locally. Not retried on the base (a pass there is the signal).
5. **Verifier checkpoint** = changed existing verifier files + the script a verifier runs (the program, or an interpreter's first argument; files a verifier only reads are the code under test) + a test-count drop. Covered by the human, or by an attested review's `accepts`, per `approvals.verifierChanges` (default `human-or-review`, as the brief allows).
6. **Review provenance by construction**, not by attestation after the fact. `ways review` (replacing the agent's `review submit`) launches the reviewer process with ways' own prompt and reads its stdout; the Claude Code `ways-reviewer` subagent is handed the prompt in `SubagentStart` and its answer is recorded in `SubagentStop`, if ways started it and the events with its `agent_id` show no writes. *Deviation from the analysis:* a separate `review start` + `submit` pair would add a command and let the implementer relay (and edit) the verdict; one command that never lets the review pass through the implementer is both shorter and stronger. Review files remain only for humans at a terminal.
7. **SSH-signed approvals** over a fixed payload (work, evaluated commit, approval digest), verified against `.ways/allowed_signers` of the base. Signing is automatic when a key is configured; `--payload`/`--signature` allow signing elsewhere. Required only by policy (`approvals.signature: required`); default optional for personal repositories. The history audit re-verifies signatures.
8. **`ways block`** as the legitimate exit: a harness commit with the reason; Stop tells the human; a later passing `done` clears it. One new action.
9. **`ways verify --base`** for CI; `bootstrap` seeds `.github/workflows/ways.yml`.
10. The evidence snapshots the base's approval policy so the pure close policy (`pending`) needs no config; the audit checks the snapshot against the base.

Not done: mutation testing, hidden CI checks, in-toto attestations, LLM judges, reading the agent's reasoning.

## Consequences

- Commands: a small change is still `ways done` (1–2 commands); a delivery is `outcome open`, `done`, `review`, and `approve` only when a human is needed (3–4), as in lean. CLI actions: 27 of 28 (`block`, `review`, `verify` added; `review submit` kept for humans).
- Existing records keep validating (new fields are optional), but a review without provenance no longer counts: works that were verifying at upgrade need a fresh `ways review`.
- Trivial verifiers (`true`, `node -e 0`) no longer close a work without review; tests and evals were moved to discriminating verifiers.
- The clean run costs a checkout and, with a setup, one install per lockfile change. The first evaluation in a repository creates the worktree; `git worktree list` shows it.
- Agents need Claude Code's `SubagentStart`/`SubagentStop` hooks (`ways adapter install claude` re-merges them) or a working `claude`/`pi` CLI for `ways review`.
- The threat model and the remaining gaps are in [VERIFICATION.md](../VERIFICATION.md).
