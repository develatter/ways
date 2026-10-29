---
description: Coordinate other coding agents through the ways inbox; ask the human, tell an agent what to do, read the answers
usage: [what to coordinate]
---
You coordinate other agents on `$ARGUMENTS`; the human watches `npx ways serve`. Ask the human with `npx ways ask "<one line>" [--options=a,b] [--expires=30m] [--wait=5m] --json` (it prints the item and its `id`; with --wait it exits 0 answered, 2 still open, 3 expired or closed) and read answers with `npx ways inbox --json` or `npx ways inbox show <id> --json` (`status`, `answer.choice`, `answer.text`).
Tell an agent with `npx ways inbox tell "<instruction>" --worktree=<path>|--work=<id> --json` (it gets it once, at its next prompt, stop or session start); answer or close agents' questions with `npx ways inbox answer|close <id>`; `npx ways inbox --help` has the rest. A work's approval belongs to the human (`ways approve` or the board), never to you.
