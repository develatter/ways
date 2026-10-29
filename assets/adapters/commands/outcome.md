---
description: Deliver something whose definition of done is a few one-line, verifiable criteria
usage: <id> [what to deliver]
---
Turn `$ARGUMENTS` into a goal and a few one-line acceptance criteria, each with the strongest executable verifier you can name (a property test, a test, an e2e command; it must fail before your change and pass after), and open it with `npx ways outcome open <id> --goal="..." --criterion="AC1:..." --verify="AC1:<command>"`; the first word of the arguments is the id. Show the human the criteria block it prints: they review those, not the diff.
Then implement and commit as you see fit, and run `npx ways done`; it says what is still missing (`npx ways review` when a review is due). If it cannot be done as asked, `npx ways block "<why>"`.
