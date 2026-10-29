# Acceptance criteria

What a repository gets from `ways bootstrap`, written from the consumer's side. Each line is checked by the test suite of this package.

1. A small change takes at most two ways commands (`ways start` and `ways done`, or only `ways done` in observe mode) and leaves no file of its own in the repository.
2. A delivery with criteria takes at most four (`ways outcome open`, `ways done`, and at most `ways review submit` and `ways approve`).
3. `ways done` runs integrity, the configured checks and every criterion's verifier once, on a clean committed tree, and records the evidence itself: command, exit code, duration, output sha256 and tail, bound to the input commit and tree.
4. An outcome closes only when its evidence passed for the closed tree, a required review names that evaluated commit with no unfixed `critical` or `high` finding, and any required human approval covers that evidence and review.
5. A criterion without an executable verifier is `review-only` and makes the review mandatory.
6. Modifying or deleting an existing test, or changing the check commands, needs a human approval; adding tests does not.
7. `ways approve` refuses without a real terminal.
8. The commit hook refuses, in every mode, a commit not made by ways that changes `.ways/work/`; `ways check --history` flags one that bypassed it. In `observe` mode (the default) it refuses nothing else and adds `Harness-Work`; in `enforce` mode it also refuses commits outside an active work.
9. Verifiers run without a shell; shell operators in `--verify` are refused.
10. Memory concepts are short facts; `paths:` ties them to code, and they are flagged possibly stale when that code's content changes after them. `stale_after` and long concepts only warn.
11. Bootstrap installs Claude Code and pi by default, writes at most 30 files, writes nothing that points at the ways repository itself, and makes `CLAUDE.md` import `AGENTS.md`.
12. Upgrades move a 0.2.x repository to this model without losing its checks, memory or active quick work, and never overwrite modified managed files without approval.
13. The CLI offers at most 28 actions; `ways --help` lists every command and `ways <command> --help` shows its usage and examples.
14. `ways hook` adds well under 100 ms to a commit beyond Node's start-up.
