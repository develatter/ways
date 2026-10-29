---
title: Make a small change
kind: how-to
sources:
  - src/cli.ts
  - src/work/work.ts
  - src/work/evaluate.ts
  - src/hooks/hook.ts
reviewed: 2026-10-29
source_hashes:
  src/cli.ts: 6801ff123cbd
  src/work/work.ts: 6cf798d8e5c6
  src/work/evaluate.ts: 6abdbb69b336
  src/hooks/hook.ts: fd41f9993c45
---

# Make a small change

A small change has no criteria of its own: its judge is your check suite. You commit as you would anyway and run one command at the end.

1. **Commit as you go.** In the default `observe` mode the first commit starts the change, named after the branch (after the commit subject on `main`, `master` or `trunk`), and the commit hook adds a `Harness-Work: <id>` trailer to every commit. To pick the name yourself, run `ways start <id>` first.

2. **Finish with `ways done`.**

   ```sh ways-check
   npx ways done
   npx ways done --message="fix: button padding"
   ```

   It runs the integrity checks and your checks once, in a clean checkout of the committed HEAD, with the check configuration as it was where the change started. Then it records the evidence and closes the change when nothing is missing. It refuses to run with uncommitted changes in the tree, since they would not be what it checks; commit them, or pass `--message="<subject>"` and ways commits everything that is left (`git add -A`) with that subject, and starts the change if there was none.

3. **If it fails**, it lists what failed and the next command. Fix, commit and run it again. A failing check is run again up to twice before the failure is recorded; a check that fails and then passes is recorded as flaky and listed by `ways status`.

## Variations

- **Too slow for your loop.** `npx ways done --fast` runs in your working tree and leaves the clean run to CI. Setting `"evaluation": "fast"` in `.ways/config.json` makes that the default.
- **It cannot be done as asked** (a test contradicts the requirement, a secret is missing): stop instead of working around a check, and say why.

  ```sh ways-check
  npx ways block "AC2 needs the payments sandbox key; set PAYMENTS_KEY in .env.test or drop AC2"
  ```

  The reason is recorded in the work, the human is told, and a later passing `ways done` clears the block.
- **Drop it.** `npx ways cancel` forgets the active work. Your commits stay.
- **Where am I?** `npx ways status` shows the active work, what is missing and the exact next command; `npx ways context --brief` prints what an agent is told.

## When it needs a person

Modifying or deleting an existing test, changing the check configuration, or running fewer tests than the base did is not blocked locally, but it cannot close without either a human's `ways approve` or an independent review that accepts the change. Adding tests never needs one. See [Get a review, and an approval](review.md).
