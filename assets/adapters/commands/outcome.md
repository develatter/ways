---
description: Deliver something whose definition of done is a few one-line, verifiable criteria
usage: <id> [what to deliver]
---
Turn `$ARGUMENTS` into a goal and a few one-line acceptance criteria, each with the strongest executable verifier you can name (a test, a property test, an e2e command), and open it with `npx ways outcome open <id> --goal="..." --criterion="AC1:..." --verify="AC1:<command>"`; the first word of the arguments is the id. Show the human the criteria: they review those, not the diff. Then implement and commit as you see fit, and run `npx ways done`; it says what is still missing.
