---
title: Deliver something with criteria
kind: how-to
sources:
  - src/work/work.ts
  - src/work/evaluate.ts
  - src/work/policy.ts
  - src/commands.ts
reviewed: 2026-10-29
source_hashes:
  src/work/work.ts: 6cf798d8e5c6
  src/work/evaluate.ts: c1c45d85e5af
  src/work/policy.ts: 08dda9672054
  src/commands.ts: 1e705fb54baf
---

# Deliver something with criteria

Use an outcome when you want a statement of "done" that a person can read in thirty seconds and a machine can check. The only specification is one line per criterion plus the command that verifies it. You review those lines, not the diff.

## Open the outcome

```sh ways-check
npx ways outcome open auth-refresh --goal="Refresh tokens before they expire" \
  --criterion="AC1:refreshes 60 s before expiry" --verify='AC1:npm test -- -t "refresh before expiry"' \
  --criterion="AC2:never refreshes a revoked token" --verify='AC2:npm test -- -t "revoked"'
```

- The id is a lowercase slug (2 to 63 characters: `a-z`, `0-9`, `-`). Criterion ids are capital letters, digits and `-` (`AC1`, `PERF-2`).
- Only one work can be active in a worktree. Finish it with `ways done` or drop it with `ways cancel` first.
- ways commits the goal and the criteria as `.ways/work/<id>.json` (the commit is called `chore(ways): open <id>`) and prints them. After this, nobody edits them: the commit hook refuses a hand edit of `.ways/work/`, and the history audit that CI runs flags one that skipped the hook.
- The work starts from the commit before that one; that is its base.

## Choose verifiers that can fail

`ways done` runs each verifier on your commit and on the base (the base run happens once per base and is remembered). It must **fail on the base and pass on your commit**. A verifier that already passes before the work shows nothing was done, so the criterion is treated as `review-only`, like one with no `--verify` at all, and an independent review becomes mandatory for it.

State how strong a verifier is when it is more than an example-based test:

| `--strength` | Meaning |
| --- | --- |
| `proof` | a formal proof checker |
| `property` | a property-based test |
| `test` | an example-based test; the default |
| `e2e` | an end-to-end run; assumed when the command mentions `e2e`, `playwright` or `cypress` |

```sh ways-check
npx ways outcome open ordering --goal="Orders keep their order" --criterion="AC1:sorting is stable" --verify="AC1:npm run test:props" --strength=AC1:property
```

`ways done` ends with what backs the delivery, for example `Backed by: 1 property, 2 test`.

## Say who must look at it

- `--review=required` (the default, unless `.ways/config.json` says `"review": "none"`) asks for an independent read-only review after `ways done`. `--review=none` drops it, but a work with a review-only criterion still needs one.
- `--approval=required` adds a human approval at the end (`ways approve` in the human's terminal). Setting `"approvals": {"criteria": "required"}` in `.ways/config.json` makes that the default.

## Do the work, then finish

Implement and commit as you like. Then:

```sh ways-check
npx ways done
npx ways done --note="AC1:covered by the clock-skew test too"
```

`ways done` runs your checks and every verifier in a clean checkout, records the evidence, and says what is still missing and the command to run next. The one thing you may add is a note per criterion with `--note=<ID>:<text>`; everything else in the evidence is written by ways. Then `npx ways review` and, if needed, `npx ways approve`. The work closes when the evidence passed for the exact tree, a required review does not block, and a required approval is valid.

If the work cannot meet a criterion, do not weaken the test or the check to make it pass: `ways block "<what is missing; what would unblock it>"` and let the human decide. See [Make a small change](small-change.md).
