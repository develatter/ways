# How context works

ways does not tell the agent how to work. It tells it, at the moment it matters, what state it is working in: what is active, what "done" means for it, what fails, what is waiting on whom, and the short facts the repository has learned about the code being touched. Everything else is the project's own `AGENTS.md` and `MAP.md`, which describe the project, not ways.

## The three layers of a repository

What a repository has after `ways bootstrap` and its first session, and why only this is generated ([decision 0012](decisions/0012-three-layers-of-the-first-session.md)): context files an LLM writes that repeat what the agent can read from the code make agents slower and costlier, so ways generates only what is deterministic, what the code does not say (with sources), and commands it ran.

| Layer | Files | Written by |
| --- | --- | --- |
| Baseline | `AGENTS.md` (what it is, commands, five lines on ways; under 100 lines), `MAP.md` (folders, entry points, stack, commands, tests, CI), `CLAUDE.md`, the roles (reviewer, documentalist, onboarder), skills and hooks | bootstrap, from the repository; `ways map` regenerates `MAP.md`; the onboarder proposes `AGENTS.md` additions in a marked block and folder purposes in `.ways/map-notes.json` |
| Memory | `.ways/knowledge/` | people and agents with `ways remember`; `ways onboard` seeds 8 to 15 facts with `sources`, hashed by ways and *unverified* until `ways memory confirm` |
| Verification | `commands` in `.ways/config.json` (the contract) and `.ways/checks.json` (what ways observed) | bootstrap and `ways onboard` detect candidates and run each once; `ways check add`; the onboarder can only propose |

The first session: `.ways/onboarding.json` is `pending` after bootstrap, and the SessionStart hook says so in at most 600 characters (what it generates, which agent, how many files it may read, that it spends the human's quota, and the command). With `"onboarding": "ask"` (default) the agent asks the human (`ways ask`) and runs `ways onboard --yes` on a yes; `auto` runs it; `off` silences it.

## Three channels

| Channel | When the agent gets it | What |
| --- | --- | --- |
| `AGENTS.md` (imported by `CLAUDE.md`) | Always, at session start, by the agent itself | What the project is, its commands as `ways run <check>`, five lines on ways, a link to `MAP.md` |
| Path rules (`.claude/rules/ways-*.md`) | Claude Code, when it reads or edits a matching file | One memory fact per rule, generated from `.ways/knowledge` |
| Hooks (`ways hook <event>`) | Session start, each prompt, around tool calls, at stop | The brief and its changes, the guard, one reminder of a blocker |

## The brief

`npx ways context --brief` prints what the hooks inject, at most 6,000 characters, always in this order and deterministic for a given state:

```text
Work: outcome billing-export — Export invoices as CSV (branch feat/export, base 1a2b3c4d5e6f)
- AC1 [test] failed: exports one row per invoice
- AC2 [test] passed: amounts are integer cents
- AC3 [review-only] needs review: the export is readable by a human
Failing: the last `ways done` ran on 9f8e7d6c5b4a (HEAD):
- check test: failed (exit 1)
    ✕ export › one row per invoice (12 ms)
    Expected 3 rows, received 2
    Tests: 1 failed, 41 passed
- criterion AC1 (test): failed (exit 1)
Next: fix what fails, commit, then `ways done`.
Memory for the code in play (short facts from .ways/knowledge; fix a concept in the same commit when it no longer holds):
- [pitfall] Billing amounts are integer cents; never floats — src/billing/** (.ways/knowledge/pitfalls/billing-amounts-are-integer-cents.md)
- [convention] CSV exports use RFC 4180 quoting through lib/csv — src/billing/** (.ways/knowledge/conventions/csv-quoting.md) (possibly stale: its code changed after it was written)
```

- **Work** and its criteria, each with its strength and its result (from the evidence when it still certifies HEAD, else from the last run on HEAD).
- **Failing**: every failing check, setup, service or criterion of the last `ways done`, each with only the last lines of its output.
- **Waiting on**: a required review, a human approval.
- **Next**: one exact command or action.
- **Onboarding** (while `.ways/onboarding.json` is pending and the policy is not `off`) and **MAP.md** (when it drifted from the repository: a top-level folder added or gone, the stack, commands, entry points, CI or notes changed): one line each, said once per session.
- **Memory**: up to five concepts covering the files in play: those the session touched (newest first), then uncommitted ones, then those the work changed; the more specific glob first, fresh before possibly stale. A possibly stale concept is marked, not hidden: the agent should check it still holds and fix it in the same commit if not.

Without `--brief` nothing is capped; `--json` gives the same data to an orchestrator; `--session=<id>` ranks memory by what that agent session touched. With nothing in play the brief is empty and the hooks say nothing.

## What each hook does

| Event | Claude Code | pi (extension event) | ways answers |
| --- | --- | --- | --- |
| Session start | `SessionStart` | `session_start` | The whole brief (nothing if empty), after any inbox answers or instructions waiting for this session or worktree. Prunes the event log; exports `WAYS_SESSION` to the agent's shell. |
| Each prompt | `UserPromptSubmit` | `before_agent_start` | Inbox answers and instructions not yet delivered, then only the sections that changed since this session last heard them, a one-line note for a section that went away, and memory not yet given. Usually nothing. |
| Before a tool call | `PreToolUse` | `tool_call` | Refuses a write, move or delete of `.ways/work/**` (every mode), and in `enforce` mode a command that switches the commit hooks off. In a session launched as the documentalist or the onboarder (`WAYS_ROLE`, [WIKI.md](WIKI.md)) it also refuses any write outside the role's paths. When a shell call runs a configured check by hand (`pytest`, `npm test`, `npx eslint .`), Claude Code gets, once per session, a one-line hint to use `ways run <check>` instead; nothing is ever blocked for it. Otherwise nothing. |
| After a tool call | `PostToolUse` (in the background) | `tool_result` | Logs the paths. In pi, appends the memory of a newly touched area to the tool result (Claude Code gets it from the rules), and the one `ways run` hint (pi's `tool_call` cannot add context). |
| Stop | `Stop` | `agent_end` | An inbox answer or instruction keeps the agent going with it (each delivered once, see [CONTROL_PLANE.md](CONTROL_PLANE.md)). Once per blocker and session: if the last `ways done` failed on HEAD or a review is required, the agent is told and keeps going; a pending human approval or a `ways block` is shown to the human only. |
| Session end | `SessionEnd` | `session_shutdown` | Logs it. |
| Reviewer starts | `SubagentStart` (matcher `ways-reviewer`) | — | Hands the subagent the review prompt ways builds (criteria, evidence, diff of the evaluated commit). |
| Reviewer ends | `SubagentStop` (matcher `ways-reviewer`) | — | Records its final answer as the review, if ways started it and its tool calls show no writes; asks once for the JSON when it is missing. pi has no subagents: `ways review --agent=pi` launches a reviewer process instead. |

Every event is recorded in the [event bus](EVENTS.md).

### It never breaks a session

Bad input, no Git repository, ways not installed, a missing CLI or any internal error: the hook answers nothing and exits 0 (the error goes to the event log). The only refusal is the guard's, and only for what would break a guarantee; the commit hook refuses the same record changes anyway, and CI audits them, so the guard is early feedback, not the last line.

### Speed

Hooks run as a fresh Node process per event, so the hot path loads no schema validator, no YAML parser, no crypto or child-process module, and reads cached facts from `<git-common-dir>/ways/context/` (rebuilt after a commit or a memory edit). In Claude Code the guard runs only for tool calls whose arguments could touch a record or the hooks (`if` rules in `.claude/settings.json`), and the edit log runs in the background; pi's extension filters the same way. `WAYS_PROFILE=1` prints the timing of each phase on stderr. See [decision 0006](decisions/0006-context-at-the-right-moment.md) for measured numbers.

## Path rules

For every concept with `paths:` and Claude Code installed, ways writes `.claude/rules/ways-<type>-<slug>.md`:

```markdown
---
paths:
  - "src/billing/**"
---
<!-- Generated by ways from .ways/knowledge/pitfalls/billing-amounts-are-integer-cents.md; edit that concept, not this file, and run `ways memory index`. -->

ways memory (pitfall): Billing amounts are integer cents; never floats

Source: .ways/knowledge/pitfalls/billing-amounts-are-integer-cents.md
```

`ways remember` and `ways memory index` keep them in sync (commit them with the memory); `ways memory check` warns when one drifts. Rules without the marker are yours and are never touched. A fact seeded by `ways onboard` and not confirmed yet says so in its rule and in the brief (`unverified: seeded by onboarding, not confirmed by a person yet`); one whose source file changed is marked possibly stale.

## Installing and wiring

`ways bootstrap` (or `ways adapter install claude|pi`) installs everything:

- **Claude Code**: hook entries in `.claude/settings.json` running `"$CLAUDE_PROJECT_DIR"/.ways/hooks/agent-hook claude <event>`, kept next to your own hooks; skills in `.claude/skills/`; the reviewer and documentalist agents; the status line.
- **pi**: the extension `.pi/extensions/ways/index.ts` (pi loads it once the project is trusted), skills in `.agents/skills/`, the reviewer and documentalist agents.
- **Codex, Cursor** (best effort): `ways hook <event> --agent=codex` answers in the Claude-compatible format if you wire it yourself; Cursor runs Claude Code's project hooks.

`.ways/hooks/agent-hook` finds the CLI like the Git hooks do (`$WAYS_CLI`, then `node_modules/@develatter/ways`, then `ways` on the `PATH`) and stays silent without it. `WAYS_DISABLE=1` skips it.
