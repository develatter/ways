# Acceptance criteria

What a repository gets from `ways bootstrap`, written from the consumer's side. Each line is checked by the test suite of this package.

1. A small change takes at most two ways commands (`ways start` and `ways done`, or only `ways done` in observe mode) and leaves no file of its own in the repository.
2. A delivery with criteria takes at most four (`ways outcome open`, `ways done`, and at most `ways review` and `ways approve`).
3. `ways done` runs integrity, the check contract of the base and every criterion's verifier once, in a clean checkout of the committed tree (`--fast`: in place), retrying a failure twice, and records the evidence itself: command, exit code, duration, output sha256 and tail, attempts, execution ids and the runner, bound to the input commit and tree.
4. An outcome closes only when its evidence passed for the closed tree, a required review of that evaluated commit came from a reviewer ways launched or handed its prompt to (read-only, recorded by ways) with no unfixed `critical` or `high` finding, and any required human approval covers that evidence and review.
5. A criterion without an executable verifier, or whose verifier already passes on the base, is `review-only` and makes the review mandatory; `ways done` and `ways verify` say which strength backs each criterion.
6. Modifying or deleting an existing test, changing the check configuration or the script a verifier runs, or running fewer tests than the base, needs a human approval or an attested review that accepts it; adding tests does not.
7. `ways approve` refuses without a real terminal (unless given a signature made elsewhere); with `approvals.signature: required` an approval counts only when SSH-signed by a key in `.ways/allowed_signers` of the base.
8. The commit hook refuses, in every mode, a commit not made by ways that changes `.ways/work/`; `ways check --history` flags one that bypassed it. In `observe` mode (the default) it refuses nothing else and adds `Harness-Work`; in `enforce` mode it also refuses commits outside an active work.
9. Verifiers run without a shell; shell operators in `--verify` are refused.
10. Memory concepts are short facts; `paths:` ties them to code, and they are flagged possibly stale when that code's content changes after them. `stale_after` and long concepts only warn.
11. Bootstrap installs Claude Code and pi by default, writes at most 30 files, writes nothing that points at the ways repository itself, and makes `CLAUDE.md` import `AGENTS.md`.
12. Upgrades move a 0.2.x repository to this model without losing its checks, memory or active quick work, and never overwrite modified managed files without approval.
13. The CLI offers at most 28 actions; `ways --help` lists every command and `ways <command> --help` shows its usage and examples.
14. `ways hook` adds well under 100 ms to a commit beyond Node's start-up.
15. In Claude Code and pi, the agent receives at session start a deterministic brief of at most 6,000 characters (active work, criteria results, failures, what waits on whom, the next command, up to five memory facts for the code in play, possibly stale ones marked); later prompts receive only what changed, or nothing.
16. Agent hooks never break a session: bad input, no repository, no ways or an internal error answer nothing with exit 0. The only refusal is a tool call that writes `.ways/work/` (and, in `enforce` mode, one that switches the commit hooks off).
17. A Stop reminds the agent of a blocker it can act on once per session, and tells the human (not the agent) about a pending approval or a `ways block`.
18. Every memory concept with `paths:` becomes a generated Claude Code path rule; `ways memory check` warns when the rules drift.
19. Hook events go to `<git-common-dir>/ways/events/` as versioned JSONL, never into the working tree or history, without prompts or file contents.
20. The bootstrapped `AGENTS.md` is a map of the project of at most 100 lines; ways takes five of them.
21. `ways block "<reason>"` ends a task that cannot be done as asked: the reason is committed in the work, the human is told, and a later passing `ways done` clears it.
22. `ways verify --base=<sha>` re-runs, from scratch, the base's checks and the verifiers of the works the range touched, fails on a changed existing test no closed work had approved, and audits the records; bootstrap writes a CI job that runs it.
23. The adversarial regression tests (tamper-test, tamper-config, self-review, fake-approval, legit-block) pass, and fail when their guarantee is switched off.
