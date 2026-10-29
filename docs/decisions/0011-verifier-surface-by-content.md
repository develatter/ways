# 0011 — The verifier surface by content, coverage by content, terminal reviews need the human

- Status: accepted; amends [0007](0007-verification-v2.md)
- Date: 2026-10-29
- Decided by: the implementing agent, within the maintainer's brief (minimal ceremony; results verifiable; the agent cannot pass off what is not)

## Context

Installing the package in clean repositories and the independent review of phase D found three real problems in 0007's verification:

- **A false positive that would make approvals noise.** Appending one test to an existing `*.test.mjs` needed a human approval, because the checkpoint looked at whether the file existed in the base (status `M`), not at what changed in it. Adding tests is almost always editing an existing file.
- **Coverage bound to a path.** In `ways verify`, a closed work with an approved edit of `tests/x.test.js` covered every later edit of that path in the range, so a plain commit (allowed in observe mode) could weaken the test again after the approval.
- **A self-served review.** `ways review submit` checks only for a TTY, which `script -qc` gives an agent; the record said `via: terminal` and satisfied `review: required` and review-only criteria, locally and in CI.

## Decision

- **The checkpoint is judged by content** (`git diff -U0` per file on the surface). Free: new files, added lines anywhere, and an import of the same module widened with more names. Counted: removed or changed lines, deleted files, added lines with a disabling, focusing or exiting marker (built-in list, extensible with `testMarkers` in the base's config), and any change, adding included, to check configuration. Dependency and build directories are off the surface. The exact table is in [VERIFICATION.md](../VERIFICATION.md#what-needs-approval-on-the-verifier-surface).
- **Two deviations from the brief, for less friction without losing a guarantee.** Adding a CI pipeline (`.github/workflows/**`, `.gitlab-ci.yml`) is free: it adds jobs and cannot stop others, and which checks are required is the branch protection's to say; changing or deleting one still counts. An increment that installs ways (no `.ways/config.json` in its base) adds configuration freely. `enforcement` is not a watched field: `ways verify` now reads it from the base, so a range cannot relax it for itself.
- **Coverage is bound to content, from the range's base to the head.** A checkpoint entry at the head is covered by a chain of closed works: the head's file, compared with the last work's evaluated commit, has nothing the checkpoint would count, and that work's base is reached from the range's base with nothing counted, or is itself covered the same way by an earlier work. An approval sees only `git diff <work base> <evaluated commit>`, so it covers neither what came after it nor what came before the work started (a weakening committed in observe mode, then one legitimate approved edit of the same file). A test-count drop is covered only down to the count that was approved.
- **A terminal review needs the human's approval.** Where a review is required (by policy or by a review-only criterion), a `via: terminal` review adds an approval reason instead of clearing the requirement. The approval digest already covers the review, and the approval is signed when a key is configured or required, so no new signing path was added. `ways review` (a process ways launches) and the `ways-reviewer` subagent stay the one-step path. The history audit and `ways verify` apply the same rule through `pending()`.
- **Hook latency.** `module.enableCompileCache()` in the user's cache directory, and an agent-hook wrapper that takes the root from its absolute path instead of forking. Measured on the development host, 200 runs each of `.ways/hooks/agent-hook claude UserPromptSubmit` in a bootstrapped repository: before p50 106.6 ms / p95 135.3 ms (`node -e 0`: 61.5 / 80.9), after p50 101.0 ms / p95 124.2 ms (`node -e 0`: 63.8 / 84.6); through `node_modules` instead of `WAYS_CLI`, after: p50 102.0 / p95 123.7 ms. The warm hook loads 14 small modules of ways and no ajv, yaml, crypto or child_process; what remains is Node's ESM loader and V8. The 100 ms p95 target is not met on this host; a single-file bundle of the hook path is the next step, and it needs a bundler at build time.

## Consequences

- Adding tests never waits for a human; weakening one still does, and CI checks the content that was approved, not the file name.
- The rule is a line heuristic: an added early `return` or a mock of the module under test inside an existing test is not seen. The ratchet, red-to-green verifiers and the review stand behind it, and VERIFICATION.md says so.
- With signatures optional, a terminal review plus a terminal approval through a pseudo-terminal still closes a work: two deliberate commands, both recorded as `via: terminal`. Only `approvals.signature: required` closes that gap, as for test changes.
- `bootstrap` warns, with the command, when `package.json` lacks `@develatter/ways`, which the CI job's `npx --no-install ways` needs.
