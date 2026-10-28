/**
 * The single source of truth for what the CLI offers: `ways --help`,
 * `ways <command> --help`, the README command table and the registry test all
 * read from here. A command that is dispatched in `cli.ts` but missing from
 * this list fails `tests/commands.test.ts`.
 */
export interface CommandSpec {
  name: string;
  summary: string;
  usage: readonly string[];
  examples: readonly string[];
  /** Set when the command only exists to finish or audit old work. */
  deprecated?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "bootstrap",
    summary: "Install the harness in a Git repository (config, hook, check script, memory, agent adapters)",
    usage: [
      "ways bootstrap [--test-command=<json-array>] [--commands=<json>] [--force] [--no-adapters]",
      "              [--release-branch=<name>] [--integration-branch=<name>] [--relevant-path=<glob>]... [--exclude-path=<glob>]...",
    ],
    examples: ["ways bootstrap --test-command='[\"npm\",\"test\"]'"],
  },
  {
    name: "status",
    summary: "Show the active work, if any",
    usage: ["ways status [--json]"],
    examples: ["ways status --json"],
  },
  {
    name: "context",
    summary: "Print a resumable packet for a fresh agent session",
    usage: ["ways context [--json]"],
    examples: ["ways context"],
  },
  {
    name: "query",
    summary: "Search the OKF memory; read-only",
    usage: ["ways query <terms>"],
    examples: ["ways query token rotation"],
  },
  {
    name: "quick",
    summary: "Small direct change: start, check, one commit",
    usage: ["ways quick start <id>", "ways quick finish --message=<subject>", "ways quick cancel"],
    examples: ["ways quick start button-spacing", "ways quick finish --message=\"fix: button padding\""],
  },
  {
    name: "outcome",
    summary: "Delivery constrained by criteria, evidence, checks and review (default for new work)",
    usage: [
      "ways outcome open <id> --goal=<text> --criterion=<ID>:<text>... [--memory=none|normal|high] [--evaluation=independent|self]",
      "                       [--isolation=required|optional] [--parallel=allowed|disabled] [--approvals=none|close|close,remediate]",
      "ways outcome evaluate",
      "ways outcome remediate --reason=<text>",
      "ways outcome memory-review digest | submit <review.json>",
      "ways outcome close",
      "ways outcome cancel",
    ],
    examples: ["ways outcome open greeting --goal=\"Greet users\" --criterion=\"AC1:greeting.txt says hi\"", "ways outcome evaluate", "ways outcome close"],
  },
  {
    name: "task",
    summary: "Isolated worktree tasks inside an outcome",
    usage: ["ways task add <id> --title=<text> [--depends=a,b]", "ways task prepare <id>", "ways task integrate <id> --commits=a,b"],
    examples: ["ways task add write --title=\"Write the greeting\"", "ways task prepare write", "ways task integrate write --commits=<sha>"],
  },
  {
    name: "review",
    summary: "Independent review bound to the exact content under review",
    usage: ["ways review digest", "ways review submit <review.json>"],
    examples: ["ways review digest", "ways review submit review.json"],
  },
  {
    name: "approve",
    summary: "Human approval of a gated checkpoint (needs a real terminal; agents cannot run it)",
    usage: ["ways approve [close|remediate]"],
    examples: ["ways approve close"],
  },
  {
    name: "check",
    summary: "Run integrity, the configured checks and the history audit (what CI runs)",
    usage: ["ways check [--integrity-only] [--with-services]", "ways check --history [--since=<ref>] [--to=<ref>]"],
    examples: ["ways check", "ways check --history --to=$GITHUB_SHA"],
  },
  {
    name: "memory",
    summary: "Validate and index the OKF memory under .ways/knowledge",
    usage: [
      "ways memory check",
      "ways memory index",
      "ways memory discovery request [--rediscover] | digest | complete <review.json>",
      "ways memory commit digest|create --implementation=<from>..<to> [--review=<review.json> --message=<subject>]",
      "ways memory reconcile inspect|validate|publication|back-sync ...",
    ],
    examples: ["ways memory check", "ways memory index"],
  },
  {
    name: "adapter",
    summary: "List or (re)install the agent adapters (Claude Code, Codex, Cursor, pi)",
    usage: ["ways adapter list", "ways adapter install <provider> [--force]"],
    examples: ["ways adapter list", "ways adapter install claude"],
  },
  {
    name: "upgrade",
    summary: "Re-render managed files after updating the package; never overwrites edits silently",
    usage: ["ways upgrade [--apply] [--overwrite-all | --overwrite=<path>...]"],
    examples: ["ways upgrade", "ways upgrade --apply"],
  },
  {
    name: "repair",
    summary: "Diagnose or restore state that diverged from Git",
    usage: ["ways repair [diagnose]", "ways repair adopt-head", "ways repair restore-state", "ways repair last-gate [--discard]"],
    examples: ["ways repair diagnose"],
  },
  {
    name: "hook",
    summary: "Entry point for the managed Git hooks (not called by hand)",
    usage: ["ways hook commit-msg <message-file>"],
    examples: ["ways hook commit-msg .git/COMMIT_EDITMSG"],
  },
  {
    name: "evals",
    summary: "Run or compare the harness evaluation corpus",
    usage: [
      "ways evals run [--adapter=fake|command] [--command=<executable>] [--harness=<label>] [--model=<name>] [--output=<file>]",
      "ways evals compare --input=<result.json>... [--output=<report.json>] [--markdown=<report.md>]",
    ],
    examples: ["ways evals run --harness=outcome --output=result.json", "ways evals compare --input=result.json"],
  },
  {
    name: "plan",
    summary: "Versioned proposal before executing",
    usage: ["ways plan start <id>", "ways plan propose", "ways plan promote [--supervised] [--delegated]", "ways plan finish --message=<subject>", "ways plan abandon"],
    examples: ["ways plan start auth-refresh"],
    deprecated: "plans belong to the legacy SDD flow; use `ways outcome open` for new work",
  },
  {
    name: "sdd",
    summary: "Strict phased delivery, kept only to finish or audit existing work",
    usage: [
      "ways sdd start <id> [--supervised] [--delegated]",
      "ways sdd advance",
      "ways sdd validate",
      "ways sdd remediate <implement|decompose|plan|specify> --reason=<text>",
      "ways sdd downgrade <quick|plan>",
    ],
    examples: ["ways sdd advance"],
    deprecated: "SDD is deprecated; use `ways outcome open` for new work",
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function renderOverview(name: string, version: string): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const lines = COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}${command.deprecated ? " (deprecated)" : ""}`);
  return [
    `${name} ${version}`,
    "",
    "Usage: ways <command> [options]",
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
    ...(command.deprecated ? ["", `Deprecated: ${command.deprecated}.`] : []),
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
  const rows = COMMANDS.map((command) => `| \`ways ${command.name}\` | ${command.summary}${command.deprecated ? " (deprecated)" : ""} | \`${command.examples[0]}\` |`);
  return ["| Command | What it does | Example |", "| --- | --- | --- |", ...rows].join("\n");
}
