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
export const ACTION_BUDGET = 44;

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
    name: "ask",
    summary: "Ask the human something (a question, a decision, an approval); the answer comes back through the hooks, or at once with --wait",
    usage: [
      "ways ask \"<question>\" [--options=a,b] [--type=ask|decision|approval] [--default=<option>] [--body=<text>]",
      "        [--work=<id>] [--priority=low|normal|high] [--expires=30m] [--wait[=5m]] [--session=<id>] [--json]",
      "  --wait exits 0 with the answer, 2 if still open (it arrives later through the hooks), 3 if it expired or was closed unanswered",
    ],
    examples: ["ways ask \"Mock Stripe in CI, or will you add STRIPE_TEST_KEY?\" --options=mock,key --wait=5m"],
    actions: ["ask"],
  },
  {
    name: "inbox",
    summary: "What agents wait on from the human, and what the human tells them: list, show, answer, close, or tell an agent something",
    usage: [
      "ways inbox [list] [--all] [--json]",
      "ways inbox show <id> [--json]",
      "ways inbox answer <id> \"<answer>\" [--choice=<option>] [--json]",
      "ways inbox close <id> [--reason=<text>] [--json]",
      "ways inbox tell \"<instruction>\" [--session=<id> | --work=<id> | --worktree=<path>] [--priority=high] [--json]",
      "  answers and instructions reach the agent once, at its next prompt, stop or session start",
    ],
    examples: ["ways inbox", "ways inbox answer i-mabc12-1a2b3c4d mock", "ways inbox tell \"Stream the export; it must stay under 2 s\" --work=billing-export"],
    actions: ["inbox", "inbox answer", "inbox close", "inbox tell"],
  },
  {
    name: "serve",
    summary: "The local board: a kanban of every agent's work derived from hooks, records and worktrees, and the inbox, live on 127.0.0.1",
    usage: [
      "ways serve [--port=<n>] [--open] [--repo=<path>]... [--lang=en|es] [--demo]",
      "  prints a URL with a one-time token; --repo adds a repository to ~/.config/ways/registry.json; --demo shows made-up data",
    ],
    examples: ["ways serve --open", "ways serve --demo"],
    actions: ["serve"],
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
    name: "run",
    summary: "Run a configured check (test, lint, typecheck, build, e2e) and get a short summary instead of its output: counts, each failure on a line, new vs already failing at the base, and the full log kept",
    usage: [
      "ways run [<check>...] [--all] [--json]",
      "ways run --show <id> [--grep=<regex>] [--tail=<n>|all]",
      "  without a name: every configured check in order, except the slow ones (--all includes them); the exit code is the check's",
    ],
    examples: ["ways run test", "ways run", "ways run --show test-m3k2p0a1 --grep=FAIL"],
    actions: ["run", "run --show"],
  },
  {
    name: "check",
    summary: "Integrity and every configured check (what CI runs), one line per area; add a check, validated by running it; --history audits work records and trailers",
    usage: [
      "ways check [--integrity-only] [--with-services]",
      "ways check add <test|lint|typecheck|build|e2e> -- <command> [args...]",
      "ways check --history [--since=<ref>] [--to=<ref>]",
    ],
    examples: ["ways check", "ways check add lint -- npx eslint .", "ways check --history --to=$GITHUB_SHA"],
    actions: ["check", "check add", "check --history"],
  },
  {
    name: "map",
    summary: "Write MAP.md from the repository (stack, commands, folders, entry points, tests, CI) with the folder purposes in .ways/map-notes.json; --check fails when it drifted",
    usage: ["ways map [--check]"],
    examples: ["ways map", "ways map --check"],
    actions: ["map", "map --check"],
  },
  {
    name: "verify",
    summary: "The CI's judgement of a range: re-run the base's checks and every criterion's verifier clean, require changed tests to be approved, audit the records",
    usage: [
      "ways verify --base=<sha> [--head=<sha>] [--in-place] [--json=<report.json>] [--markdown=<report.md>]",
      "  --in-place runs in the current checkout when it is clean and at the head (a fresh CI checkout); the Markdown also goes to $GITHUB_STEP_SUMMARY",
    ],
    examples: ["ways verify --base=origin/main", "ways verify --base=$BASE_SHA --in-place --json=ways-report.json"],
    actions: ["verify"],
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
      "ways hook SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SessionEnd [--agent=claude|pi|codex|cursor]   (agent's JSON payload on stdin)",
    ],
    examples: ["ways hook prepare-commit-msg .git/COMMIT_EDITMSG", "echo '{\"session_id\":\"s1\"}' | ways hook SessionStart --agent=claude"],
    actions: ["hook prepare-commit-msg", "hook commit-msg", "hook <agent event>"],
  },
  {
    name: "wiki",
    summary: "A wiki for humans in docs/wiki, apart from the agents' memory: create it, check it (links, frontmatter, freshness by source hash, coverage), list stale pages, or launch the documentalist agent to update it",
    usage: [
      "ways wiki init",
      "ways wiki update [--agent=claude|pi|<command>] [--dry-run]",
      "ways wiki update --stamp <page>...",
      "ways wiki check [--json]",
      "ways wiki stale [--json]",
      "  update launches the documentalist with a brief ways builds (stale pages, gaps, broken links), allowed to write only under docs/wiki/; --stamp records that pages you checked match their sources",
    ],
    examples: ["ways wiki check", "ways wiki update --dry-run", "ways wiki update --stamp reference/commands.md"],
    actions: ["wiki init", "wiki update", "wiki check", "wiki stale"],
  },
  {
    name: "evals",
    summary: "Run or compare the harness evaluation corpus",
    usage: [
      "ways evals run [--adapter=fake|command --command=<executable> [--arg=<arg>]...] [--harness=<label>] [--model=<name>] [--corpus=<file>]",
      "               [--review=required|none] [--approval=required|none] [--revision=<label>] [--seed=<n>] [--timeout-ms=<n>] [--max-output-bytes=<n>] [--output=<file>]",
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

export const WIKI_COMMANDS_START = "<!-- commands:start (generated from src/commands.ts; run `UPDATE_README=1 npx vitest run tests/commands.test.ts`, then `ways wiki update --stamp reference/commands.md`) -->";
export const WIKI_COMMANDS_END = "<!-- commands:end -->";

/**
 * The body of the wiki's command reference (docs/wiki/reference/commands.md),
 * one section per command, kept in sync with the registry by
 * tests/commands.test.ts. Its examples are `ways-check` blocks: `ways wiki
 * check` verifies them against this same registry.
 */
export function renderWikiReference(): string {
  const sections = COMMANDS.map((command) => [
    `## \`ways ${command.name}\``,
    "",
    command.summary,
    "",
    "```text",
    ...command.usage,
    "```",
    "",
    "```sh ways-check",
    ...command.examples,
    "```",
  ].join("\n"));
  return sections.join("\n\n");
}

/** The README command table, kept in sync with the registry by tests/commands.test.ts. */
export function renderReadmeTable(): string {
  const rows = COMMANDS.map((command) => `| \`ways ${command.name}\` | ${command.summary} | \`${command.examples[0]}\` |`);
  return ["| Command | What it does | Example |", "| --- | --- | --- |", ...rows].join("\n");
}
