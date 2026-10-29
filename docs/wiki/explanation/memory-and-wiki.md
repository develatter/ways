---
title: Memory and wiki
kind: explanation
sources:
  - src/knowledge/okf.ts
  - src/memory/memory.ts
  - src/context/brief.ts
  - src/hooks/guard.ts
  - src/hooks/hook.ts
  - src/domain/constants.ts
reviewed: 2026-10-29
source_hashes:
  src/knowledge/okf.ts: d1a844070e37
  src/memory/memory.ts: 0702906b59c4
  src/context/brief.ts: 3734c2012bbb
  src/hooks/guard.ts: 4d3ff1f5e49b
  src/hooks/hook.ts: bf698ab3883e
  src/domain/constants.ts: dd9777c3e34c
---

# Memory and wiki

A ways project has two places where knowledge about it is written down, and they are deliberately not the same place.

| | Memory (`.ways/knowledge`) | Wiki (`docs/wiki`) |
| --- | --- | --- |
| For | coding agents | people |
| Shape | one short fact per file, about fifteen lines at most | pages: tutorials, guides, reference, explanation |
| Written | at the moment something is learned: `ways remember "<fact>" --path=<glob>`, or an edit in the same commit | by a person, or by the documentalist agent from the code |
| Tied to code by | `paths:` globs | `sources:` files and their hashes |
| Reaches the reader | injected when the agent touches the code it is about | read on GitHub |
| When the code changes | the concept is flagged *possibly stale* in the brief and by `ways memory check`; nothing fails | `ways wiki check` fails until the page is caught up |

Memory is a source of truth for agents, so it has to stay short and relevant to what is being touched. The wiki is explanation for humans, derived from the code and, where useful, from the memory. If the two were mixed, a page that nobody checks against the code could become a fact an agent acts on.

## How they are kept apart

The separation is mechanical, not a convention:

1. **Reading.** The memory index, search, `ways context` and the hooks read only `.ways/knowledge`. Touching or changing a wiki page never brings up the memory of the code it describes, and never makes a concept *possibly stale*.
2. **Writing.** A session that `ways wiki update` started carries the role `documentalist`. The agent guard refuses its writes outside `docs/wiki/`, `.ways/knowledge` included, and so does the commit hook for its commits.
3. **History.** The commit hook adds a `Harness-Role: documentalist` trailer to those commits, and `ways check --history` (so CI) refuses one that touches anything outside the wiki, even if the hook was skipped.
4. **Direction.** The wiki may cite the memory in its `sources`. A memory may not cite the wiki: `ways memory check` fails a concept whose `sources`, `paths` or links point into `docs/wiki/`.

The documentalist is told the same in one line. Neither is generated from the other.

## Which one to write

If an agent would make a mistake without knowing it, it is memory: a convention, a decision, a pitfall, how to verify something. Write it where it is learned, short, tied to the code. If a person would be lost without knowing it, it is wiki: how to start, how to do a task, what the pieces are, why the design is this way. Often there is a bit of both, and they stay separate texts for separate readers. See [Keep this wiki up to date](../how-to/wiki.md).
