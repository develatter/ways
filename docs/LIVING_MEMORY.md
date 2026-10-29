# Living memory

ways keeps short, durable repository facts in OKF under `.ways/knowledge/`: the things an agent needs and cannot read from the code. Conventions, decisions, pitfalls and how to verify something. Not progress, not plans, not documents nobody reads again. Documentation for humans belongs in `docs/`.

## Writing a memory

The normal path costs one command or one file edit, in the same commit as the change that taught it:

```bash
npx ways remember "Tokens refresh 60 s before expiry; never on revoked tokens" --path='src/auth/**' --type=convention
```

That writes `.ways/knowledge/conventions/<slug>.md`:

```markdown
---
type: convention
title: Tokens refresh 60 s before expiry; never on revoked tokens
paths:
  - src/auth/**
generated:
  by: process:ways-remember
  at: 2026-10-29T10:00:00Z
---

Tokens refresh 60 s before expiry; never on revoked tokens
```

Editing a concept by hand is just as valid: `ways done` (through integrity) and `ways memory check` validate it. Keep each concept to a few lines (a warning appears above 15); split long ones, or move the detail to `docs/`. Types are free-form OKF types; `remember` uses `convention`, `decision`, `pitfall` and `howto`.

## What is checked

- Errors (fail `ways memory check`, `ways check` and `ways done`): missing frontmatter or `type`, invalid `status`, malformed `generated`/`verified` events, `paths:` that are not repository-relative globs, local `sources` that do not exist at HEAD, broken links.
- Warnings (never block): a concept longer than 15 lines, a passed `stale_after`, and **possibly stale** concepts.

## Freshness

A concept with `paths:` is possibly stale when the files under those globs now hash differently from when the concept was last committed. It is judged by content, so commits that move nothing, and changes to other files, do not mark it. Any commit that edits the concept refreshes it. There is no watermark, discovery or reconciliation step.

## Using memory

- `ways done` lists the concepts whose `paths` cover the files the work changed and that the work did not touch, marking the possibly stale ones: check they still hold.
- `ways status` shows the memory of the code being changed.
- `ways query <terms>` searches it, read-only. It excludes `deprecated` concepts and labels drafts, unverified concepts, `roadmap` and `debt`. Its index is a disposable cache in `.git/ways/indexes/`; `ways memory index` rebuilds it.

Removed facts are deleted; history that stays useful moves to `deprecated/`.
