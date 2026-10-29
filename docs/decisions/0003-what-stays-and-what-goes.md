# 0003 — What stays and what goes (ways lean)

- Status: accepted; amended by [0006](0006-context-at-the-right-moment.md) (a narrow guard on record writes is back) and [0007](0007-verification-v2.md) (agents run `ways review`, which launches the reviewer; `review submit` is for a human at a terminal). The file and action counts below are those of this step, not of 0.3.
- Date: 2026-10-29
- Decided by: the implementing agent, within the maintainer's brief (SDD and `plan` removed without legacy; minimal ceremony; results must stay verifiable)

## Context

ways 0.2 modelled delivery as a process: 5 modes, 11 SDD phases, outcome stages, tasks with mandatory worktrees, numbered attempts, remediation records, review digests fetched by hand, a hand-written evidence file, a memory discovery/commit/reconciliation flow and 54 CLI actions. The maintainer's direction: the agent decides how to work; the harness gives context, checks the result and only blocks what breaks a guarantee. For every concept we asked: *which real guarantee does it give that a hook, the CI or the agent itself cannot?*

The guarantees we keep (non-negotiable): criteria are immutable once opened; the evaluation is bound to the exact input it ran on; human approvals cannot be written by the agent through the CLI; work records live in Git; the agent cannot mark as passed what did not pass.

## Audit

| Concept (0.2) | Guarantee it gave | Verdict |
| --- | --- | --- |
| SDD phases, phase certifications, plans | None beyond "the steps happened"; 49 % of the old history was phase bookkeeping | **Removed** (maintainer decision). Old `.ways/sdd/`, `.ways/plans/` are ignored; `ways upgrade` says once that they can be deleted. |
| Outcome (goal + criteria fixed at open) | Immutable "definition of done" | **Kept** as the only delivery record, `.ways/work/<id>.json`. |
| Evidence written by the agent | None (free text nobody verified) | **Replaced**: `ways done` runs the checks and every criterion's verifier and writes the evidence itself (command, exit code, duration, output digest and tail, strength). |
| Evaluation bound to input commit/tree | Evaluation is of exactly this code | **Kept**, inside the record; close requires the closed tree to equal the evaluated tree except for the record. |
| Task + worktree (mandatory isolation) | None; parallelism is an execution choice | **Removed as a concept.** Agents that parallelise use `git worktree` or their provider's worktree isolation; commits in any worktree of the repository are attributed to the active work because the active pointer is read from the per-worktree Git dir, falling back to the main one. Isolation is therefore always "optional". |
| Attempt numbering, immutable prior attempts | History of failures | **Removed.** After a failure the agent fixes and runs `ways done` again. Every run is appended to a local run log and the closing evidence lists the earlier runs; Git history keeps every committed record version. |
| Remediation records and their approvals | None once attempts are gone | **Removed.** |
| Review digest (`ways review digest`) | Review is of the content being closed | **Replaced** by binding to the evaluated input commit, which `ways done` prints and the reviewer copies into its JSON. Stale reviews are refused; a new `done` invalidates the review. |
| Reviewer independence by name | Weak (self-declared string) | **Kept** as is (author/committer of the increment cannot be the reviewer); provenance by session is F4. Only `critical`/`high` block. |
| Human approval at checkpoints (`close`, `remediate`) | Human, not the agent, accepts | **Kept for close** (`--approval=required`) and **added automatically** when the increment modifies or deletes an existing test or the check configuration (see 0004). `ways approve` still requires a TTY (signatures are F4). |
| Committed state file + `status.json` mirror | None: derivable from the record and Git | **Removed.** Which work is active on this machine is runtime (`<git-dir>/ways/active.json`); open outcomes are rediscovered from the records in HEAD. |
| Trailers written by the agent | Traceability | **Kept, written by a `prepare-commit-msg` hook.** Only `Harness-Work` (all commits) and `Harness-State` (harness commits). |
| History replay of phases, attempts, remediations | Detects forged chains | **Reduced** to record checks: criteria unchanged since open, evidence bound to its parent commit, closed tree equals evaluated tree, review and approval bound, and (enforce only) untraced commits. |
| Memory discovery, separate memory commits, reconciliation, `memory: high`, coverage shards, watermark | Mostly process; 3 concepts written in a month | **Removed.** Memory is short OKF concepts with optional `paths:` globs, written in the same commit as the change (`ways remember` makes it one command). Freshness is by content hash of the `paths` (see 0005). |
| `repair` | Fixing a committed state that could diverge | **Removed**: nothing committed can diverge any more; `ways cancel` clears a stale pointer. |
| `context` vs `status` | Two views of the same facts | **Merged** into `ways status` (`--json` for machines). |
| PreToolUse guard | Blocks tool writes to approvals and commits without work | **Removed**: records are only read from Git or written by the harness, so a hand edit can only matter when committed, and the commit hook refuses that in every mode. No false positives on shell redirections any more. |
| Run checks three times per close | None | **Once**: `done` runs integrity, checks and verifiers once; `scripts/check.sh` runs `ways check` (no history audit unless asked). |

Resulting model: **work → criteria (one line + an executable verifier with a declared strength) → `ways done` (the harness evaluates and records the evidence) → short memory that travels with the change.** Two paths:

```sh
ways start fix-padding   # optional in observe mode: the first commit opens it from the branch
git commit ...           # any number of commits; the hook adds Harness-Work
ways done                # integrity + checks once; closes

ways outcome open auth-refresh --goal="Refresh tokens before expiry" \
  --criterion="AC1:refreshes 60 s early" --verify='AC1:npm test -- -t "refresh"'
git commit ...
ways done                # runs checks + verifiers, writes evidence; closes or moves to verifying
ways review submit review.json   # closes when nothing else is missing
ways approve             # only when a human approval is pending; closes
```

## Consequences

- CLI: 21 actions (was 54); bootstrap writes 18 files by default (was ~77).
- A small change leaves no file in the repository, only trailers. Its judge is the CI.
- Deferred to F4 (verification v2), with the same records: evaluation in a clean worktree with the base's contract, red-on-base verifiers, session provenance for reviews, signed approvals, CI re-execution (`ways verify`). The local harness assumes an honest but possibly careless agent; a deliberate agent with a shell can bypass any local hook, so the CI stays the final judge.
