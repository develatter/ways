---
title: ways wiki
---

# ways wiki

ways is a harness for coding agents (Claude Code, pi). The agent decides how to work; ways gives it context, checks the result, records the evidence itself and blocks only what would break a guarantee.

This wiki is for people. Coding agents do not read it as truth: what they know about a project is its `AGENTS.md` and the short facts under `.ways/knowledge`, which is a different thing (see [Memory and wiki](explanation/memory-and-wiki.md)). Every page lists the files it documents and the hash of each when it was written, and `ways wiki check` fails when one of them changes; see [Keep this wiki up to date](how-to/wiki.md).

## Learn

- [Get started in five minutes](tutorials/get-started.md): install ways, make a change, deliver something with criteria.

## Do

- [Make a small change](how-to/small-change.md)
- [Deliver something with criteria](how-to/delivery-with-criteria.md)
- [Get a review, and an approval](how-to/review.md)
- [See your agents and answer them](how-to/control-plane.md)
- [Keep this wiki up to date](how-to/wiki.md)

## Look up

- [Commands](reference/commands.md): every command, its usage and examples.
- [Modules](reference/modules.md): what each folder under `src/` is for.

## Understand

- [What ways guarantees](explanation/guarantees.md)
- [How verification works](explanation/verification.md)
- [Memory and wiki](explanation/memory-and-wiki.md)
