# The control plane: board and inbox

`ways serve` shows, on one local page, what every coding agent in your repositories is doing and what they wait on from you. The inbox is how agents ask you things and how you (or an orchestrating agent) tell them things. Both work from the CLI too, with `--json`, so an orchestrator needs nothing else.

Design and trade-offs: [decision 0008](decisions/0008-control-plane.md).

## Start it

```bash
npx ways serve --open          # in any repository with ways installed
npx ways serve --demo          # made-up data, to see the board without agents
```

It prints a URL like `http://127.0.0.1:7420/?token=…`. Open that URL (the token is also in `<git-common-dir>/ways/serve.json`, mode 0600). Options: `--port=<n>` (default 7420, `0` for any free port; if 7420 is taken and you did not ask for it, another free port is used), `--repo=<path>` to add another repository, `--lang=en|es`.

Repositories: each `ways serve` adds the repository it runs in to `~/.config/ways/registry.json` (`{"repos": ["/abs/path", …]}`; `$WAYS_CONFIG_DIR` or `$XDG_CONFIG_HOME` move it), and the board shows all of them. Remove a line to stop showing one. `~/.config/ways/config.json` may hold `{"lang": "es"}`.

## The board

One card per worktree with a ways work (or with an agent active in it), plus works closed in the last 7 days. Nothing is dragged: each refresh derives the cards from `git worktree list`, each worktree's active work and records (`.ways/work/`), the last `ways done`, the hook event bus ([EVENTS.md](EVENTS.md)) and the inbox.

| Column | When (first match wins) |
| --- | --- |
| Done | the work closed in the last 7 days |
| Waiting for you | an open inbox item about it, a `ways block`, a pending approval; or the agent's turn ended (or its session did) and the work is open |
| Blocked | no hook event for 10 minutes while the agent had not stopped; the last `ways done` failed and no agent is on it |
| Verifying | the evidence certifies HEAD and an independent review is pending |
| Working | an agent is active on it |
| Preparing | no commits since the work started, or an agent active with no ways work yet |

Each card shows the work and its goal, the agent (`claude`, `pi`, …) and session, the branch, the last hook event and how long ago, one bar per criterion (green passed, red failed, violet review-only, grey not run on HEAD), what the last `ways done` failed on, and why it is in its column. Expanding a card shows the criteria, the worktree path and a box to **tell the agent** something.

The page updates live (Server-Sent Events): a new hook event reaches it in about a second (tests measure under 2 s; once the events directory exists, a file watcher makes it tens of milliseconds).

## The inbox

| Type | From → to | Answer |
| --- | --- | --- |
| `ask` | agent → you | free text, or one of its options |
| `decision` | agent → you | one of its options; its `--default` applies when it expires unanswered |
| `approval` | agent → you | approve or reject (advice to the agent, not a ways approval) |
| `block` | `ways block` → you | what unblocks it; closed when a later `ways done` passes or the work is cancelled |
| `instruction` | you or an orchestrator → an agent | none: it is delivered |

States: `open → answered → delivered → closed`, and `expired` for an open item past its `--expires` (with a default, it is answered with the default instead). You can change an answer until the agent has received it. Each item keeps its history (who did what, when). Items live in `<git-common-dir>/ways/inbox/<id>.json`, outside Git history; finished items are pruned after 30 days.

A work's **approval** (when its policy or a changed test needs one) also appears in the inbox, derived from its record. *Approve* on the board records the same approval `ways approve` would, with `via: "board"`, for exactly the evaluated commit the page showed. If the repository requires SSH-signed approvals (`approvals.signature: required`), the board cannot sign: it shows the exact command to run in a terminal instead.

## Protocol for agents and orchestrators

Everything is CLI + JSON; any agent with a shell can use it. Run the commands in any worktree of the repository.

```bash
# An agent asks the human (prints the item; --wait blocks for the answer)
npx ways ask "Mock Stripe in CI, or will you add STRIPE_TEST_KEY?" --options=mock,key --default=mock --expires=30m --json
npx ways ask "Keep the old endpoint for one release?" --wait=5m      # exit 0 answered, 2 still open, 3 expired/closed

# The human, or an orchestrator, reads and answers
npx ways inbox --json                      # open and answered items (--all for every item)
npx ways inbox show <id> --json            # status, answer.choice, answer.text, delivered, history
npx ways inbox answer <id> "yes, in a separate section" [--choice=<option>]
npx ways inbox close <id> --reason="no longer needed"

# Tell an agent what to do; it gets it once, at its next prompt, stop or session start
npx ways inbox tell "Stream the export; it must stay under 2 s" --work=billing-export
npx ways inbox tell "Rebase on main first" --worktree=../app-wt/auth   # or --session=<id>
```

How an answer reaches the agent:

- **At once:** `ways ask --wait[=5m]` polls until the answer, prints it and marks it delivered. In Claude Code keep the wait under the Bash tool's timeout (2 minutes by default, up to 10 with a `timeout`).
- **Through the hooks:** otherwise, the agent's next `SessionStart` or `UserPromptSubmit` adds it to the context, and its `Stop` keeps it going with it (Claude Code: `decision: "block"` with the answer as the reason; pi: a message that starts a turn). Each item is delivered exactly once (an exclusive claim file), and `delivered` records the session and the hook.
- **Routing:** an answer goes to the session that asked. The hooks export that session to the agent's shell (`WAYS_SESSION`, via Claude Code's `CLAUDE_ENV_FILE` and the pi extension); without it, the worktree routes. A new session starting in the same worktree also picks up what an earlier one never got. An instruction goes to the session, work or worktree it names.

The `ways-orchestrator` skill (installed for Claude Code and pi by `ways bootstrap`) says this in two lines.

## HTTP API

All on `http://127.0.0.1:<port>`, all requiring the token.

| Method and path | What |
| --- | --- |
| `GET /` | the page |
| `GET /api/state` | `{repos, cards, inbox, live, lang, demo, generatedAt}` |
| `GET /events` | SSE: an `event: state` with the same JSON whenever it changes |
| `POST /api/inbox/<id>/answer` | `{choice?, text?}`; for a work's approval (`a-…` ids) `{choice: "approve"}` |
| `POST /api/inbox/<id>/close` | `{reason?}` |
| `POST /api/tell` | `{repo, text, worktree?, work?, session?}`; the worktree must be one of that repository's |
| `POST /api/refresh` | re-derive now |

## Security

- Listens on 127.0.0.1 only.
- **Token:** 256 random bits, compared in constant time. Accepted from `Authorization: Bearer`, `X-Ways-Token`, or the `HttpOnly; SameSite=Strict` cookie the first visit sets; from the URL's `?token=` only for GET (the page then removes it from the address bar). Without it: 401.
- **Host and Origin:** `Host` must be `127.0.0.1`, `localhost` or `[::1]` with the server's port (against DNS rebinding); a foreign `Origin` or `Sec-Fetch-Site: cross-site` is refused with 403. No CORS headers, ever.
- **Mutations:** POST only, `Content-Type: application/json` (415 otherwise; a cross-site form cannot send it), at most 16 KiB (413).
- **Page:** a Content-Security-Policy that allows only the hashes of its own inline script and style, `frame-ancestors 'none'`, `no-referrer`, `nosniff`; all text from agents is inserted as text, never as HTML.
- **Paths:** the server serves one file and fixed routes; inbox ids are validated against a fixed pattern; a worktree in `/api/tell` must be one `git worktree list` reports.
- **Limit:** the token keeps browsers and other web pages out. It does not keep out your own agents, which run as you and can read `serve.json`. That is why a work's approval from the board is refused where SSH signatures are required, and why an inbox answer is advice, never a ways approval.
