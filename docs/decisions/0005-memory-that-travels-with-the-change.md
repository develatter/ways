# 0005 — Memory that travels with the change

- Status: accepted
- Date: 2026-10-29
- Decided by: the implementing agent, within the maintainer's decision (memory without mandatory discovery or reconciliation)

## Context

In 0.2 memory needed a reviewed discovery, separate digest-bound memory commits, release reconciliation branches, coverage shards for every relevant path and a code-tree watermark whose freshness changed with any edit anywhere. After a month the product's own memory held three concepts. A memory that is expensive to write is not written.

## Decision

- A memory is one short OKF concept (a convention, decision, pitfall or how-to), a few lines long; above 15 lines `ways memory check` warns.
- It is written in the commit of the change that taught it: by editing a `.md` or with `ways remember "<fact>" --path=<glob> [--type=...]`, which writes the file and does not commit.
- `paths:` frontmatter replaces coverage shards: it ties a concept to the code it is about. `ways done` lists the concepts whose paths cover the changed files and that the work did not update; `ways status` shows them for the code being changed. Nothing is required.
- Freshness is per concept and by content: a concept is possibly stale when the blobs under its `paths` at its last commit differ from those at HEAD. It is derived from Git, so nothing is stored and any edit of the concept refreshes it. We chose this over storing a hash in the frontmatter, which every edit of the concept would have to recompute, and over comparing commit dates, which history rewrites and unrelated commits would trip.
- Errors (fail `done`): malformed frontmatter, invalid paths, missing local sources, broken links. Warnings only: length, possibly stale, a passed `stale_after` (it used to fail integrity on the clock), and unverified stable concepts are no longer an error (queries label them).
- Removed: discovery, `memory commit`, `memory-review`, reconciliation and back-sync, the `none|normal|high` tiers, the watermark (`state.json`), coverage shards, `.ways/memory/`. The derived search index moved to `.git/ways/indexes/`.

## Consequences

- The CLI keeps `memory check`, `memory index`, `query` and `remember`.
- `ways upgrade` moves 0.2 coverage globs onto the concepts they covered as `paths:` and deletes the rest.
- Path-scoped rules for agents (`.claude/rules/` from `paths:`) are the next step (F3); the data is already there.
