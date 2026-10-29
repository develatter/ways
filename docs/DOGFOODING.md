# Dogfooding ways on ways (proposal, not active)

This repository does not run ways on itself. The 0.2 attempt was heavy: the hooks ran the `dist/` under development, every commit needed an active work and a hand-typed trailer, one work at a time, minor review findings blocked, and memory discovery was mandatory. It produced more phase certificates than features. This is a proposal for a light version; nothing here is installed.

## The setup

1. **A published, pinned version, never the working tree.** `npm install --save-dev --save-exact @develatter/ways@<published version>` under an alias so it does not collide with the package itself, e.g. `"ways-harness": "npm:@develatter/ways@0.3.0"`, and the Git and agent hooks pointed at it with `WAYS_CLI=<absolute path of the checkout>/node_modules/ways-harness/dist/cli.js` in the environment of whoever works here (the hooks otherwise look for `node_modules/@develatter/ways`, which here is nothing). A bug in the code being changed can then never break the commit that fixes it. Move the pin on purpose, in its own commit, after a release.
2. **`observe` mode, the default.** The context and event hooks are on; the commit hook never refuses anything but a hand-edited work record, and only adds the `Harness-Work` trailer. No `enforce`.
3. **`AGENTS.md` as a map of this repository** (what ways is, `src/` module by module, the commands: `npm run check`, `npm run test:e2e`, `node dist/cli.js wiki check`), at most 100 lines. Seed the memory with 10–15 short facts that already cost time once: the pitfalls in the archived 0.2 memory, how the hook path stays fast, why tests drive `dist/`, the wiki/memory separation.
4. **Small changes stay `ways done`; outcomes only for features with criteria.** `ways serve` to watch the agents working on ways.
5. **`WAYS_DISABLE=1` is the switch** for any command where ways is in the way; using it is not a failure, it is data.
6. **CI: `npm run check` stays the required job. `ways verify --base` runs as an informative, non-required job for one month.**

## After the month

Read the event log (`.git/ways/events/`) and the informative CI runs, and decide with numbers:

- How often the hooks injected something, and how often the agent used it (the next command, a memory fact).
- False refusals: any refusal of a legitimate action is a bug to fix before going further.
- How many `WAYS_DISABLE=1` commits there were, and why.
- Whether `ways verify` would have caught anything `npm run check` did not.

Make `ways verify` required only if it caught something real and never failed a legitimate pull request. A rule moves to `enforce` only if the evals ([EVALS.md](EVALS.md)) say it pays for itself.

## Undoing it

`npm uninstall ways-harness`, delete `.ways/`, `.claude/settings.json` hook entries, `.pi/extensions/ways/` and the CI job, and `git config --unset core.hooksPath`. Work records and memory stay in history; nothing else depends on them.
