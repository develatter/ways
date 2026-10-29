/**
 * The single source of truth for what the CLI offers: `ways --help`,
 * `ways <command> --help`, the README command table and the registry test all
 * read from here. A command dispatched in `cli.ts` but missing from this list
 * fails `tests/commands.test.ts`, and so does a total above the action budget.
 */
export interface CommandSpec {
  name: string;
  summary: string;
  usage: readonly string[];
  examples: readonly string[];
  /** Every distinct invocation the command offers; their total is the CLI's surface. */
  actions: readonly string[];
}

/** The lean target: no more distinct CLI actions than this. */
export const ACTION_BUDGET = 28;

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "bootstrap",
    summary: "Install ways in a Git repository: config, commit hooks, memory and the Claude Code and pi adapters",
    usage: ["ways bootstrap [--test-command=<json-array>] [--commands=<json>] [--agents=claude,pi[,codex,cursor]] [--no-adapters] [--force]"],
    examples: ["ways bootstrap --test-command='[\"npm\",\"test\"]'"],
    actions: ["bootstrap"],
  },
  {
    name: "status",
    summary: "What is active, what done means for it, what is missing and the next command",
    usage: ["ways status [--json]"],
    examples: ["ways status"],
    actions: ["status"],
  },
  {
    name: "context",
    summary: "The facts an agent needs now: active work, its criteria, what fails, what waits on whom, the next command, memory of the code in play",
    usage: ["ways context [--brief] [--json] [--session=<agent-session-id>]"],
    examples: ["ways context --brief"],
    actions: ["context"],
  },
  {
    name: "start",
    summary: "Start a small change (optional in observe mode: the first commit starts one from the branch)",
    usage: ["ways start [<id>]"],
    examples: ["ways start fix-button-padding"],
    actions: ["start"],
  },
  {
    name: "outcome",
    summary: "Open a delivery whose definition of done is one-line criteria, each with an executable verifier",
    usage: [
      "ways outcome open <id> --goal=<text> --criterion=<ID>:<text>... [--verify=<ID>:<command>]... [--strength=<ID>:proof|property|test|e2e]...",
      "                       [--review=required|none] [--approval=required|none]",
    ],
    examples: ["ways outcome open greeting --goal=\"Greet users\" --criterion=\"AC1:greeting.txt says hi\" --verify=\"AC1:grep -q hi greeting.txt\""],
    actions: ["outcome open"],
  },
  {
    name: "done",
    summary: "Finish the active work: run integrity, checks and verifiers once, record the evidence, close when nothing is missing",
    usage: [
      "ways done [--message=<subject>] [--fast] [--note=<ID>:<text>]...",
      "  runs in a clean checkout of HEAD with the base's checks; --fast runs in place and leaves the clean run to CI",
    ],
    examples: ["ways done", "ways done --message=\"fix: button padding\"", "ways done --fast"],
    actions: ["done"],
  },
  {
    name: "block",
    summary: "Stop on purpose when the task cannot be done as asked: record what is missing and what would unblock it, for the human",
    usage: ["ways block \"<what is missing; what would unblock it>\""],
    examples: ["ways block \"AC2 needs the payments sandbox key; set PAYMENTS_KEY in .env.test or drop AC2\""],
    actions: ["block"],
  },
  {
    name: "review",
    summary: "Launch an independent read-only reviewer of the evaluated commit and record its verdict; closes the work when nothing else is missing",
    usage: [
      "ways review [--agent=claude|pi] [--print]",
      "  starts a new read-only process with a prompt ways builds (criteria, evidence, diff); --print shows it instead",
      "  in Claude Code the ways-reviewer subagent works too: ways records its final answer itself",
      "ways review submit <review.json>   (a human at an interactive terminal)",
    ],
    examples: ["ways review", "ways review --agent=pi", "ways review --print"],
    actions: ["review", "review submit"],
  },
  {
    name: "approve",
    summary: "Human approval (a real terminal, signed with the human's SSH key when configured); closes the work when nothing else is missing",
    usage: [
      "ways approve [--key=<ssh key>]          at an interactive terminal; signs when a key is given or Git signs with SSH",
      "ways approve --payload                  print what to sign elsewhere: ssh-keygen -Y sign -n ways-approval -f <key>",
      "ways approve --signature=<file>         record a signature made elsewhere (verified against .ways/allowed_signers of the base)",
    ],
    examples: ["ways approve", "ways approve --key=~/.ssh/id_ed25519_sk"],
    actions: ["approve"],
  },
  {
    name: "cancel",
    summary: "Drop the active work; commits stay, an open record is marked cancelled",
    usage: ["ways cancel"],
    examples: ["ways cancel"],
    actions: ["cancel"],
  },
  {
    name: "check",
    summary: "Run integrity and the configured checks (what CI runs); --history audits work records and trailers",
    usage: ["ways check [--integrity-only] [--with-services]", "ways check --history [--since=<ref>] [--to=<ref>]"],
    examples: ["ways check", "ways check --history --to=$GITHUB_SHA"],
    actions: ["check", "check --history"],
  },
  {
    name: "remember",
    summary: "Write one short memory (a convention, decision, pitfall or how-to), tied to the code it is about",
    usage: ["ways remember \"<fact>\" [--path=<glob>]... [--type=convention|decision|pitfall|howto] [--id=<slug>]"],
    examples: ["ways remember \"Tokens refresh 60 s before expiry\" --path=src/auth/**"],
    actions: ["remember"],
  },
  {
    name: "memory",
    summary: "Validate the OKF memory under .ways/knowledge (and flag possibly stale concepts), or rebuild its search index",
    usage: ["ways memory check", "ways memory index"],
    examples: ["ways memory check"],
    actions: ["memory check", "memory index"],
  },
  {
    name: "query",
    summary: "Search the memory; read-only",
    usage: ["ways query <terms>"],
    examples: ["ways query token refresh"],
    actions: ["query"],
  },
  {
    name: "adapter",
    summary: "List or (re)install agent adapters: claude and pi by default, codex and cursor best effort",
    usage: ["ways adapter list", "ways adapter install <provider> [--force]"],
    examples: ["ways adapter list", "ways adapter install codex"],
    actions: ["adapter list", "adapter install"],
  },
  {
    name: "upgrade",
    summary: "Move a repository to this version of ways (including 0.2.x); never overwrites edits silently",
    usage: ["ways upgrade [--apply] [--overwrite-all | --overwrite=<path>...]"],
    examples: ["ways upgrade", "ways upgrade --apply"],
    actions: ["upgrade", "upgrade --apply"],
  },
  {
    name: "hook",
    summary: "Entry point of the managed Git hooks and the coding-agent hooks (not called by hand)",
    usage: [
      "ways hook prepare-commit-msg <message-file> [source] [sha]",
      "ways hook commit-msg <message-file>",
      "ways hook SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd [--agent=claude|pi]   (agent's JSON payload on stdin)",
    ],
    examples: ["ways hook prepare-commit-msg .git/COMMIT_EDITMSG", "echo '{\"session_id\":\"s1\"}' | ways hook SessionStart --agent=claude"],
    actions: ["hook prepare-commit-msg", "hook commit-msg", "hook <agent event>"],
  },
  {
    name: "evals",
    summary: "Run or compare the harness evaluation corpus",
    usage: [
      "ways evals run [--adapter=fake|command] [--command=<executable>] [--harness=<label>] [--model=<name>] [--review=required|none] [--approval=required|none] [--output=<file>]",
      "ways evals compare --input=<result.json>... [--output=<report.json>] [--markdown=<report.md>]",
    ],
    examples: ["ways evals run --harness=outcome --output=result.json", "ways evals compare --input=result.json"],
    actions: ["evals run", "evals compare"],
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function actionCount(): number {
  return COMMANDS.reduce((total, command) => total + command.actions.length, 0);
}

export function renderOverview(name: string, version: string): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const lines = COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);
  return [
    `${name} ${version}`,
    "",
    "Usage: ways <command> [options]",
    "",
    "A small change: commit as usual, then `ways done`.",
    "A delivery: `ways outcome open <id> --goal=... --criterion=AC1:... --verify=AC1:<command>`, commit, `ways done`.",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `ways <command> --help` for usage and examples; `ways --version` prints the version.",
    "",
  ].join("\n");
}

export function renderCommandHelp(command: CommandSpec): string {
  return [
    `ways ${command.name}: ${command.summary}`,
    "",
    "Usage:",
    ...command.usage.map((line) => `  ${line}`),
    "",
    "Examples:",
    ...command.examples.map((line) => `  ${line}`),
    "",
  ].join("\n");
}

export const README_COMMANDS_START = "<!-- commands:start (generated from src/commands.ts; run `UPDATE_README=1 npx vitest run tests/commands.test.ts`) -->";
export const README_COMMANDS_END = "<!-- commands:end -->";

/** The README command table, kept in sync with the registry by tests/commands.test.ts. */
export function renderReadmeTable(): string {
  const rows = COMMANDS.map((command) => `| \`ways ${command.name}\` | ${command.summary} | \`${command.examples[0]}\` |`);
  return ["| Command | What it does | Example |", "| --- | --- | --- |", ...rows].join("\n");
}
