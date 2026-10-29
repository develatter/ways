# 0004 — Observe by default; what breaks a guarantee

- Status: accepted
- Date: 2026-10-29
- Decided by: the implementing agent, within the maintainer's decisions (commit hook in `observe` by default; changing or deleting tests or the checks configuration needs approval, adding tests does not; CI is the final judge)

## Context

The 0.2 `commit-msg` hook refused every commit without an active work and a hand-typed trailer, so agents spent effort on trailers and humans found the escape hatch. A hook should only stand in the way of what would make a result unverifiable.

## Decision

`enforcement` in `.ways/config.json` is `observe` (default) or `enforce`; `WAYS_DISABLE=1` skips the hooks for one command.

**Breaking a guarantee** is exactly this, refused in both modes by `prepare-commit-msg` (which `--no-verify` does not skip):

- a commit not made by ways that adds, changes or deletes `.ways/work/<id>.json`, the record holding the criteria fixed at open, the evidence ways ran, reviews and human approvals.

Record files that arrive verbatim from a commit being merged, cherry-picked or rebased (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REBASE_HEAD`) are accepted. ways makes its own record commits with hooks disabled and only touching the record.

Everything else is accepted. In `observe` the hook adds `Harness-Work: <id>`; the first commit without an active work starts a change named after the branch (or the subject on a default branch), except the commit that installs ways. `enforce` additionally refuses commits outside an active work, as 0.2 did, and makes the history audit report untraced commits.

**Guarantees enforced by `ways done` instead of the hook**, because they need the increment as a whole:

- Verifier surface: an increment that modifies or deletes an existing file under `verifierPaths` (default: test directories and `*.test.*`/`*.spec.*` files, `.ways/config.json`, `.github/workflows/**`, test-runner configs) needs a human approval. Adding files never does. The ways config counts only when its check commands change, so upgrading ways never asks for approval. This holds for small changes too: a change that needs an approval gets a record so the approval is kept in Git.
- Evidence and close: see 0003.

**The CI is the final judge.** `scripts/check.sh --history` on pull requests audits every record version in the branch (definition unchanged since open, evidence bound to the commit it was recorded on and to that input's check contract, closed tree equal to the evaluated tree, review and approval bound). A record committed with `WAYS_DISABLE=1` is reported there.

## Consequences

- A small change costs at most `ways done`; no trailer is ever typed.
- The PreToolUse guard of 0.2 is gone (no false positives on shell redirections); provider hooks return in F3 for context, not for blocking.
- A local agent can still disable hooks or rewrite history; that is accepted and left to CI and branch protection. Evaluation in a clean worktree with the base contract, red-on-base verifiers and signed approvals are F4.
- Squash merges on the host fold record commits into an ordinary commit; audit pull requests on their own commits (docs/BRANCH_PROTECTION.md).
