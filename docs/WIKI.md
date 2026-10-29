# The wiki for humans, and the documentalist

`docs/wiki/` is a wiki for people, in plain Markdown that GitHub renders as it is: no generator, no build. It is **not** the agents' memory. The memory (`.ways/knowledge`) is short facts that hooks hand to agents; the wiki explains the project to a person, is checked against the code by hash, and is never given to an agent as truth. A documentalist agent, launched by `ways wiki update`, keeps it up to date.

Decision and trade-offs: [decision 0009](decisions/0009-wiki-and-documentalist.md). The wiki of ways itself is in [docs/wiki](wiki/index.md); its how-to guide ([Keep this wiki up to date](wiki/how-to/wiki.md)) is the short version of this page.

## Start

```bash
npx ways wiki init        # docs/wiki/index.md, the four folders, .ways/wiki.json; touches nothing that exists
npx ways wiki check       # what CI runs
npx ways wiki update      # have the documentalist write or catch up pages
```

Layout, after [Diátaxis](https://diataxis.fr/): `tutorials/` (learn by doing), `how-to/` (reach a goal), `reference/` (look things up), `explanation/` (understand why). A folder exists when its first page does. Every page must be reachable from `index.md`.

## A page

```yaml
---
title: Make a small change
kind: how-to                 # tutorial | how-to | reference | explanation
sources:                     # repository paths the page documents
  - src/work/work.ts
  - src/hooks/               # a trailing / is a folder
source_hashes:               # written by ways
  src/work/work.ts: 3f2a9c1d0e4b
reviewed: 2026-10-29         # last time it was checked against its sources
---
```

`index.md` needs only a `title`. A page is **stale** when a source's hash differs from the recorded one (or none was recorded). Hashes are over the working tree, so a page can be checked before the change it documents is committed:

- a file source hashes like `git hash-object`, cut to 12 hex characters;
- a folder source (trailing `/`) hashes the names of the files under it: adding, removing or renaming one makes the page stale, editing one does not. Cite files to follow their content.

Cite the narrowest files the page is about; a source may be anything in the repository outside `docs/wiki`, `.ways/knowledge` included (the wiki may cite the memory, never the reverse).

## Commands

| Command | What it does |
| --- | --- |
| `ways wiki init` | Creates what is missing: `docs/wiki/index.md`, the Diátaxis folders and `.ways/wiki.json`. |
| `ways wiki check [--json]` | Validates the wiki; exit 1 on any problem. A repository without a wiki passes. |
| `ways wiki stale [--json]` | Lists the pages that are out of date, with the sources that changed, and the sources that no longer exist. Always exits 0. |
| `ways wiki update [--agent=claude\|pi\|<command>] [--dry-run]` | Launches the documentalist (below). |
| `ways wiki update --stamp <page>...` | Records the current hashes and today's date in pages you checked against their sources. Pages are paths from the wiki folder (`how-to/wiki.md`) or from the repository root. |

`check` reports, one line each with the page and line: **front** (frontmatter missing or wrong, `kind` not matching the folder), **source** (does not exist), **stale**, **broken** (internal link or `#anchor`; external links are not checked), **orphan** (not reachable from the index), **example**, **gap** (coverage), **config** (`.ways/wiki.json` unusable).

### Command examples

A fenced block whose info string has `ways-check` (```` ```sh ways-check ````) is checked against the command registry: each line that starts with `ways` or `npx [--flags] ways` (after `$ `, in pipelines, with `\` continuations) must name an existing command, an existing action if that command has actions, and options that appear in that command's usage. Other lines in the block are ignored; blocks without the mark are not looked at. Nothing is executed.

### Coverage and configuration

`.ways/wiki.json`, all optional:

```json
{
  "agent": "claude",
  "command": ["my-agent", "--flag"],
  "scope": { "modules": ["src/*/"], "commands": "ways" }
}
```

- `agent`: `claude`, `pi` or `command` (which runs `command`). `--agent=` on the command line wins.
- `scope.modules`: globs of folders (a trailing `/`) or files; each one found in the repository must be cited by some page, as itself, as a file inside it, or as a folder around it.
- `scope.commands`: `"ways"` requires every ways command to be mentioned as `ways <name>`; a list of names requires each to be mentioned.

Without the file, no coverage is demanded.

## `ways wiki update`

1. ways runs `check` and builds the **brief**: stale pages and the sources that changed, coverage gaps, other problems, and the existing pages. If there is nothing, it says so and starts no agent. `--dry-run` prints the brief, the role and the exact command, and stops.
2. It starts the agent as a new process in the repository with the role text plus the brief on stdin and `WAYS_ROLE=documentalist` in the environment:
   - **Claude Code:** `claude -p … --permission-mode dontAsk` with `--allowedTools` limited to `Read`, `Grep`, `Glob`, `Edit(docs/wiki/**)`, `Write(docs/wiki/**)`, `ways wiki check` and read-only `git log/diff/show`; `--disallowedTools` for `.ways/**` edits, `git commit/add/push` and the web; and, when ways is installed, a `--settings` PreToolUse hook so that ways' guard sees every write and shell call.
   - **pi:** `pi -p --no-session --tools read,grep,find,ls,edit,write` (no shell).
   - **Any other command:** `--agent="<command>"` or `"command"` in `.ways/wiki.json`; the brief is on stdin. ways cannot limit its tools, so only the checks below apply.
3. When it exits, ways compares the uncommitted paths outside the wiki (by content) and HEAD with how they were before. **Anything new or changed outside `docs/wiki/`, or committed outside it, fails the run**, lists the paths and stamps nothing; ways does not revert, because the tree may hold your own work, and prints how to undo.
4. Otherwise ways stamps every page the agent changed (the index excepted), runs `check` and prints the result. You review the diff of `docs/wiki/` and commit it.

The session is logged on the event bus with `role: documentalist`, so the board shows it.

## How it stays apart from the memory

| | |
| --- | --- |
| Reading | Context (`ways context`, the hooks), the memory index and search read only `.ways/knowledge`. Touching or changing a wiki page does not bring up the memory of the code it describes and does not make a concept possibly stale. |
| Writing | In a session with `WAYS_ROLE=documentalist` the guard refuses a file-tool or shell write outside `docs/wiki/` (and `WAYS_DISABLE=1`), in Claude Code through the `--settings` hook and in pi through the extension, which asks the guard about every call of such a session. |
| Commits | The commit hook refuses a commit from that session that stages anything outside `docs/wiki/`, `.ways/knowledge/**` included, and adds `Harness-Role: documentalist`. `ways check --history`, which CI runs, flags a commit with that trailer that left the wiki: `history-role-scope`. |
| Citations | `ways memory check` fails a concept whose `sources`, `paths` or links point into `docs/wiki/` (`okf-wiki-citation`). |

`tests/wiki-separation.test.ts` pins each of these.

## CI

The ways repository runs `node dist/cli.js wiki check` after its tests. The workflow `ways bootstrap` writes for a consumer (`.github/workflows/ways.yml`) has a `ways wiki check` step that does nothing until the project has a wiki. To keep it from failing CI on every edit of a cited file in a busy repository, cite narrow files or folders, and run `ways wiki update` in the same pull request.

## Limits

- A stamp says someone looked, not that the page is true. Review the diff of `docs/wiki/` the way you review code.
- The check is structural: it cannot tell that a sentence is wrong while its sources are unchanged.
- The agents' invocations were written from the CLIs' documented flags and tested with fake agents; see the decision.
