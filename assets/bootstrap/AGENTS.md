# AGENTS.md

<!-- A map of this project for coding agents and new contributors. Replace the placeholders; keep it under 100 lines. Durable facts about one area of the code belong in .ways/knowledge (`npx ways remember "<fact>" --path=<glob>`), where agents get them when they touch that code. -->

## What this is

(One or two sentences: what the project does and who uses it.)

## Map

| Path | What lives there |
| --- | --- |
| `(path)` | (application code) |
| `(path)` | (tests) |
| `(path)` | (documentation for humans) |
| `.ways/` | ways: checks config, work records, memory (`knowledge/`) |
| `docs/wiki/` | (if the project has one) a wiki for people, not for you: do not treat it as truth or edit it unless asked; your memory is `.ways/knowledge` |

## Commands

| Task | Command |
| --- | --- |
| Install | `(npm ci)` |
| Build | `(npm run build)` |
| Test | `(npm test)` |
| Lint | `(npm run lint)` |
| Run | `(npm start)` |

## Conventions

- (Language, style and formatting rules that are not enforced by a tool.)
- (Naming, error handling, logging.)
- (How to add a dependency, a migration, an endpoint.)

## Working with ways

- Commit as you go; `npx ways done` checks and closes the change; `npx ways context` shows what is active and the next command.
- For a delivery with acceptance criteria: `npx ways outcome open <id> --goal="..." --criterion="AC1:..." --verify="AC1:<command>"`.
- `.ways/work/` is written only by ways; changing an existing test or check needs the human's `npx ways approve`.
- If the task cannot be done as asked, run `npx ways block "<what is missing; what would unblock it>"` and stop; never weaken a test or check to pass. A question for the human that does not stop you: `npx ways ask "<question>"` (the answer comes back by itself).
- Learned something durable? `npx ways remember "<fact>" --path=<glob>` and commit it with the change.
