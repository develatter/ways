---
title: Keep this wiki up to date
kind: how-to
sources:
  - src/wiki/check.ts
  - src/wiki/update.ts
  - src/wiki/command.ts
  - src/wiki/config.ts
  - src/wiki/pages.ts
  - src/wiki/sources.ts
reviewed: 2026-10-29
source_hashes:
  src/wiki/check.ts: b2412627e159
  src/wiki/update.ts: b0818db42522
  src/wiki/command.ts: 9921f4eaa81c
  src/wiki/config.ts: 3d61e4198584
  src/wiki/pages.ts: 405df025b851
  src/wiki/sources.ts: db3ded8f7b84
---

# Keep this wiki up to date

A wiki rots when nobody can tell a page is wrong. Here every page says which files it documents and what they looked like when the page was written, so that a tool can tell, and an agent, the documentalist, can catch the page up. Your own project can have the same.

## Create it

```sh ways-check
npx ways wiki init
```

This writes `docs/wiki/index.md`, the four Diátaxis folders (`tutorials/`, `how-to/`, `reference/`, `explanation/`) and `.ways/wiki.json`. It never touches what already exists. The wiki is plain Markdown, rendered by GitHub as it is; there is no generator and nothing to build.

## Write a page

A page is a Markdown file in one of those folders, linked from `index.md`, that starts with frontmatter:

```yaml
---
title: Make a small change
kind: how-to            # tutorial | how-to | reference | explanation
sources:                # the repository files the page documents
  - src/work/work.ts
  - src/hooks/             # a trailing / is a folder
source_hashes:          # written by ways, not by hand
  src/work/work.ts: 3f2a9c1d0e4b
reviewed: 2026-10-29    # the day it was last checked against its sources
---
```

Cite the narrowest files that the page is about: a page is stale when any of its sources changes. A file source is fingerprinted like `git hash-object`, cut to 12 characters. A folder source follows only the names of the files in it, so adding, removing or renaming a file makes the page stale and editing one does not; cite the files to follow their content.

After you check a page against its sources, record that it is current:

```sh ways-check
npx ways wiki update --stamp how-to/wiki.md
```

## Check it

```sh ways-check
npx ways wiki check
npx ways wiki check --json
npx ways wiki stale
```

`check` fails (exit 1) when it finds any of these, each with the page and line:

- **Frontmatter.** Missing or invalid `title`, `kind`, `sources` or `reviewed`; a `kind` that does not match the folder; a source inside the wiki.
- **Links.** An internal link or `#anchor` that does not resolve, or points outside the repository. External links are not checked.
- **Sources.** A source that does not exist.
- **Freshness.** A source that changed since the page was stamped, or a page never stamped.
- **Reachability.** A page that `index.md` does not link to, directly or through other pages.
- **Examples.** In a block marked ` ```sh ways-check `, every line that starts with `ways` (also after `npx`) must name a real command, a real action and options that command's usage shows. Other lines in the block are ignored, and so are blocks without the mark.
- **Coverage.** What `.ways/wiki.json` asks for.

`stale` only lists the pages that are out of date and why, and always exits 0. A repository without a wiki passes `check`, so a CI step can run it everywhere.

## Say what the wiki must cover

`.ways/wiki.json` is optional:

```json
{
  "agent": "claude",
  "scope": { "modules": ["src/*/"], "commands": "ways" }
}
```

- `scope.modules`: globs of folders (a trailing `/`) or files. Each one found must be cited in the `sources` of some page, as itself, as a file inside it, or as a folder around it.
- `scope.commands`: `"ways"` requires every ways command to be mentioned as `ways <command>` somewhere in the wiki; a list of names requires each to be mentioned. For your own project, list the commands your tool has.
- `agent`: `"claude"`, `"pi"` or `"command"`, with `"command": ["my-agent", "--flag"]` for the last one.

## Let an agent do it

```sh ways-check
npx ways wiki update --dry-run
npx ways wiki update
npx ways wiki update --agent=pi
```

`update` builds a brief from what `check` finds (stale pages and which source changed, gaps, broken links) and starts the documentalist with it: Claude Code with `claude -p`, pi with `pi -p`, or any other command (`--agent="my-agent --flag"`, brief on stdin). It may read the code and write only under `docs/wiki/`: Claude Code is started with edit and write permission for that folder alone and no git writes, pi without a shell, and a session that ways launched is refused by the guard and the commit hook when it writes or commits anywhere else, `.ways/knowledge` included. The agent is told not to copy between the wiki and the memory. Whatever agent runs, when it ends ways compares the working tree and HEAD with how they were before: any change outside `docs/wiki/` fails the run and names the paths. If all is well, ways records the hashes of the pages the agent changed (the agent cannot write those) and runs `check` once more. You review the diff of `docs/wiki/` and commit it. `--dry-run` prints the brief and the exact command and runs nothing. If nothing is stale, missing or broken, no agent is started.

The session shows on the [board](control-plane.md) with the badge `documentalist`.

## Run it in CI

Add the step to the workflow of your repository, after the build:

```yaml
- run: npx --no-install ways wiki check
```
