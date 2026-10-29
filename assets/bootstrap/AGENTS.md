# AGENTS.md

<!-- A map of this project for coding agents. Replace each line below; keep it under ~100 lines. Durable facts belong in .ways/knowledge (`npx ways remember`), not here. -->

## Project

- What it is: (one or two sentences)
- Code: (where the source lives)
- Tests: (where they live and the command that runs them)
- Docs: (where to look first)
- Build and run: (commands)

## Working here

- Commit as you go; a commit hook adds the `Harness-Work` trailer. When a change is finished, run `npx ways done`: it runs the checks once and closes it. `npx ways status` shows what is missing and the next command.
- A delivery with acceptance criteria: `npx ways outcome open <id> --goal="<one line>" --criterion="AC1:<one line>" --verify="AC1:<command>"`, then commit and `npx ways done`.
- Never edit `.ways/work/` by hand. Changing or deleting an existing test or the check configuration needs a human approval (`npx ways approve`, run by the human); adding tests does not.
- Learned something durable (a convention, a decision, a pitfall, how to verify something)? `npx ways remember "<fact>" --path=<glob>` and commit it with the change.
