# The event bus

The coding-agent hooks (`ways hook <event>`) record what they saw in a local, append-only log. It is the raw material for the board and for proving who reviewed what; ways itself only reads it to know which files a session touched.

## Where

```
<git-common-dir>/ways/events/<session>.jsonl
```

`<git-common-dir>` is `git rev-parse --git-common-dir` (usually `.git`), so every worktree of a repository writes to the same place and nothing ever enters Git history or `git status`. One file per agent session; the session id is used as the file name when it is plain (`[A-Za-z0-9_-]`, up to 128 characters), otherwise `s-<hash>`.

## Schema (version 1)

One JSON object per line:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | `1` | Schema version. Readers skip lines with another version. |
| `ts` | string | ISO 8601 UTC time the hook finished. |
| `session` | string | The agent's session id (`unknown` when the agent sent none). |
| `agent` | string | `claude`, `pi`, `codex` or `cursor`. |
| `type` | string | `session.started`, `prompt.submitted`, `tool.started`, `tool.denied`, `tool.finished`, `agent.stopped`, `session.ended`, `subagent.started`, `subagent.stopped`, `review.recorded` (a ways-reviewer subagent's verdict was recorded), `hook.error`. |
| `hook` | string | The provider event that produced it: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, `SubagentStart`, `SubagentStop`. |
| `worktree` | string | Absolute path of the worktree. |
| `branch` | string \| null | Current branch; null when detached. |
| `work` | string \| null | The active ways work, if any. |
| `tool` | string? | Tool name as the agent reports it (`Edit`, `Bash`, `write`, ...). |
| `agentId`, `agentType` | string? | Claude Code: the subagent the event happened in. The review provenance reads them: a ways-reviewer must have no write events. |
| `paths` | string[]? | Repository-relative paths the tool call names (normalized, confined to the worktree). |
| `result` | string | `ok`, `injected` (context was added), `silent` (nothing new to say), `denied` (the guard refused the call), `reminded` (a Stop reminder or a note to the human), `recorded` / `refused` (a reviewer's verdict was recorded or not, and why in `detail`), `error` (internal error; the hook still answered nothing). |
| `detail` | string? | A short code: the SessionStart source, the SessionEnd reason, the denial code (`record-write`, `hooks-bypass`) or the error message. At most 300 characters. |
| `chars` | number? | Characters of context injected. |
| `ms` | number | Time spent in the hook (excluding Node's start-up). |

Example:

```json
{"v":1,"session":"abc123","agent":"claude","type":"tool.denied","hook":"PreToolUse","worktree":"/home/me/app","branch":"feat/export","work":"billing-export","tool":"Write","ts":"2026-10-29T10:15:02.123Z","result":"denied","ms":4,"paths":[".ways/work/billing-export.json"],"detail":"record-write"}
```

Never recorded: prompts (not even their length), file contents, command lines, command output.

## Guarantees and limits

- **No torn lines.** Each event is one `appendFileSync` (`O_APPEND`, one write) of at most 4 KiB; when an event would be larger, paths are dropped first. Concurrent hooks of parallel tool calls and of other sessions never interleave lines.
- **Bounded size.** A session file past 1 MiB is renamed to `<session>.<ms>-<pid>.jsonl` and a new one starts (unique names, so concurrent rotations lose nothing). At each SessionStart the directory is pruned, oldest files first, to at most 400 files and 64 MiB.
- **Tolerant readers.** `parseEvents` skips lines that do not parse or are not version 1. `readSessionEvents` reads a session's rotated files and current file in order; hooks only read the last 256 KiB of the current file.
- **Never blocking.** A hook that cannot write its event still answers the agent; an internal error is logged as `hook.error` when the log itself is writable.

The functions live in `src/events/bus.ts` (`appendEvent`, `readSessionEvents`, `readAllEvents`, `pruneEvents`) and are exported for the board.
