#!/usr/bin/env node

import { fstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * Modules load per command: `ways hook` runs on every commit and must not pay
 * for schemas, evals or adapters it never uses.
 */

/**
 * V8's compile cache (Node 22.1+) for the modules each command imports: on the
 * agent hooks it saves most of what ways costs over Node's own start-up. It
 * lives in the user's cache directory, outside any repository; anything that
 * goes wrong only means compiling as usual.
 */
function enableCompileCache(): void {
  const enable = (nodeModule as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache;
  if (typeof enable !== "function" || process.env.NODE_DISABLE_COMPILE_CACHE) return;
  try {
    enable(process.env.NODE_COMPILE_CACHE || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ways", "compile-cache"));
  } catch {
    // An unwritable cache directory: no cache.
  }
}

function option(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Every `--name=value`, and `--name value` when `spaced` is set. */
function options(args: readonly string[], name: string, spaced = false): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
    else if (spaced && arg === name && args[index + 1] !== undefined) values.push(args[++index]!);
  }
  return values;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing required option ${name}=<value>`);
  return value;
}

function choice<T extends string>(args: readonly string[], name: string, allowed: readonly T[]): T | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be ${allowed.join(" or ")}, got "${value}"`);
  return value as T;
}

function userPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function jsonOption(args: readonly string[], name: string): unknown {
  const value = option(args, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be JSON, got ${value}`);
  }
}

export async function run(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  const [command, ...args] = argv;
  // Agent hooks run once per tool call: they skip the registry and everything else.
  if (command === "hook" && args[0] !== undefined && /^[A-Z]/.test(args[0])) return dispatch(command, args, cwd);
  const { findCommand, renderCommandHelp, renderOverview } = await import("./commands.js");
  const { HARNESS_NAME, HARNESS_VERSION } = await import("./version.js");

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(HARNESS_VERSION);
    return 0;
  }

  if (command === "--help" || command === "-h" || command === undefined || (command === "help" && args[0] === undefined)) {
    process.stdout.write(renderOverview(HARNESS_NAME, HARNESS_VERSION));
    return 0;
  }

  const helpTarget = command === "help" ? args[0] : command;
  if (command === "help" || args.includes("--help") || args[0] === "-h") {
    const spec = helpTarget === undefined ? undefined : findCommand(helpTarget);
    if (!spec) {
      console.error(`Unknown command: ${helpTarget}. Run \`ways --help\` to list the commands.`);
      return 1;
    }
    process.stdout.write(renderCommandHelp(spec));
    return 0;
  }

  // A command works on the repository the shell is in, from any of its directories; paths the user
  // types stay relative to where they typed them. The evals and the board need no repository.
  let root = cwd;
  if (findCommand(command) && command !== "evals" && command !== "serve" && !(command === "adapter" && args[0] === "list")) {
    const { gitDirs } = await import("./runtime/runtime.js");
    try {
      root = gitDirs(cwd).top;
    } catch {
      throw new Error(`Not inside a Git repository: ${cwd}. Run \`ways ${command}\` from your project's directory (or \`git init\` one first).`);
    }
  }

  try {
    return await dispatch(command, args, root, cwd);
  } catch (error) {
    // Usage errors point at the registry instead of leaving the caller to guess the next command.
    if (error instanceof Error && findCommand(command) && /^(Usage:|Missing required option)/.test(error.message)) {
      throw new Error(`${error.message}\nRun \`ways ${command} --help\` for the full usage and examples.`);
    }
    throw error;
  }
}

/**
 * The hook payload, read from descriptor 0 directly: touching `process.stdin`
 * (or `process.stdout`) builds a stream and loads `net`, a few milliseconds on
 * every agent event.
 */
function readStdin(): string {
  try {
    if (fstatSync(0).isCharacterDevice()) return "";
    return readFileSync(0, "utf8");
  } catch {
    // Closed or unreadable stdin: an empty payload.
    return "";
  }
}

/** `cwd` is the repository's top directory; `invoked` is where the user ran the command, for the paths they give. */
async function dispatch(command: string, args: string[], cwd: string, invoked = cwd): Promise<number> {
  if (command === "hook") {
    const [name, messagePath] = args;
    const { AGENT_EVENTS, isAgentEvent, isAgentId } = await import("./hooks/providers.js");
    if (name !== undefined && isAgentEvent(name)) {
      const agent = option(args, "--agent") ?? "claude";
      if (!isAgentId(agent)) throw new Error(`--agent must be claude, pi, codex or cursor, got "${agent}"`);
      const { runAgentHook } = await import("./hooks/agent.js");
      const result = await runAgentHook(name, agent, readStdin(), cwd);
      if (result.stdout) writeSync(1, result.stdout);
      return result.exitCode;
    }
    if ((name !== "prepare-commit-msg" && name !== "commit-msg") || !messagePath) {
      throw new Error(`Usage: ways hook prepare-commit-msg|commit-msg <message-file> (Git hooks), or ways hook ${AGENT_EVENTS.join("|")} [--agent=claude|pi] with the agent's JSON payload on stdin`);
    }
    const { commitMsg, prepareCommitMsg } = await import("./hooks/hook.js");
    const verdict = await (name === "prepare-commit-msg" ? prepareCommitMsg : commitMsg)(cwd, messagePath);
    if (verdict.message) console.error(verdict.message);
    return verdict.accepted ? 0 : 1;
  }

  if (command === "status") {
    const { buildStatus, renderStatus } = await import("./work/status.js");
    const packet = await buildStatus(cwd);
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(packet, null, 2)}\n` : renderStatus(packet));
    return 0;
  }

  if (command === "context") {
    const { gitDirs } = await import("./runtime/runtime.js");
    const { buildBrief, renderBrief } = await import("./context/brief.js");
    const dirs = gitDirs(cwd);
    const session = option(args, "--session");
    let touched: string[] = [];
    if (session) {
      const { readSessionEvents } = await import("./events/bus.js");
      touched = [...new Set(readSessionEvents(dirs, session).filter((event) => event.worktree === dirs.top).flatMap((event) => event.paths ?? []).reverse())];
    }
    const brief = await buildBrief(dirs, { touched, brief: args.includes("--brief") });
    if (!brief.installed) throw new Error("ways is not installed in this repository (no .ways/config.json); run `ways bootstrap` first");
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
      return 0;
    }
    const text = renderBrief(brief, args.includes("--brief") ? undefined : Number.POSITIVE_INFINITY);
    console.log(text || "Nothing in play: no active work, and no memory covers the files being changed.");
    return 0;
  }

  if (command === "start") {
    const { startChange } = await import("./work/work.js");
    const active = await startChange(cwd, args.find((arg) => !arg.startsWith("--")));
    console.log(`Change ${active.id} started at ${active.base.slice(0, 12)}. Commit as you go; run \`ways done\` when it is finished.`);
    return 0;
  }

  if (command === "outcome") {
    const [action, id] = args;
    if (action !== "open" || !id || id.startsWith("--")) throw new Error("Usage: ways outcome open <id> --goal=<text> --criterion=<ID>:<text>... [--verify=<ID>:<command>]... [--strength=<ID>:<strength>]... [--review=required|none] [--approval=required|none]");
    const { openOutcome } = await import("./work/work.js");
    const review = choice(args, "--review", ["required", "none"] as const);
    const approval = choice(args, "--approval", ["required", "none"] as const);
    const record = await openOutcome(cwd, id, {
      goal: requiredOption(args, "--goal"),
      criteria: options(args, "--criterion"),
      verify: options(args, "--verify"),
      strength: options(args, "--strength"),
      ...(review ? { review } : {}),
      ...(approval ? { approval } : {}),
    });
    const { formatCommandLine } = await import("./work/argv.js");
    const weak = record.criteria.filter((criterion) => criterion.strength === "review-only").map((criterion) => criterion.id);
    const width = Math.max(...record.criteria.map((criterion) => criterion.text.length));
    console.log(`Outcome ${id} opened: ${record.goal}`);
    for (const criterion of record.criteria) {
      console.log(`  ${criterion.id}  ${criterion.text.padEnd(width)}  [${criterion.verify ? `${criterion.strength}: ${formatCommandLine(criterion.verify)}` : "review-only: no verifier, an independent review decides"}]`);
    }
    console.log(`This is what done means; the human reviews these lines, not the diff. Review ${record.policy.review}, human approval ${record.policy.approval}. Each verifier must fail on the base and pass on your commit.`);
    if (weak.length > 0) console.log(`No executable verifier for ${weak.join(", ")}: an independent review is required. Add --verify=<ID>:<command> when a check exists.`);
    console.log("Implement and commit as you go; run `ways done` when it is finished.");
    return 0;
  }

  if (command === "done") {
    const { done } = await import("./work/work.js");
    const message = option(args, "--message");
    const result = await done(cwd, { ...(message === undefined ? {} : { message }), fast: args.includes("--fast"), notes: options(args, "--note") });
    const { printDone } = await import("./work/report.js");
    printDone(result);
    return result.status === "failed" ? 1 : 0;
  }

  if (command === "review") {
    const [action, path] = args;
    let result: Awaited<ReturnType<typeof import("./work/work.js").submitReview>>;
    if (action === "submit") {
      if (!path) throw new Error("Usage: ways review submit <review.json>   (a human at a terminal; agents run `ways review`)");
      const { submitReview } = await import("./work/work.js");
      result = await submitReview(cwd, userPath(invoked, path));
    } else if (action === undefined || action.startsWith("--")) {
      const agent = option(args, "--agent");
      if (args.includes("--print")) {
        const { describeReview } = await import("./work/review.js");
        const { prompt, commands } = await describeReview(cwd, agent);
        process.stdout.write(prompt.text);
        console.log(`\n# To launch it yourself, save the prompt above and run one of:\n${Object.entries(commands).map(([name, line]) => `#   ${name}: ${line}`).join("\n")}\n# then record the answer at a terminal with \`ways review submit <file>\` and confirm it with \`ways approve\`.`);
        return 0;
      }
      const { launchReview } = await import("./work/review.js");
      // Said only once the reviewer is really starting, not before a missing precondition.
      const onLaunch = (): void => console.log("Launching an independent read-only reviewer; this can take a few minutes.");
      const launched = await launchReview(cwd, { onLaunch, ...(agent === undefined ? {} : { agent }) });
      console.log(`Reviewed by ${launched.reviewer} in a new read-only process.`);
      result = launched;
    } else {
      throw new Error("Usage: ways review [--agent=claude|pi] [--print]   or   ways review submit <review.json> (a human at a terminal)");
    }
    console.log(result.blockers.length > 0 ? `Review recorded; it blocks: ${result.blockers.join(", ")}. Fix them, commit, run \`ways done\` and \`ways review\` again.` : "Review recorded: pass.");
    for (const note of result.notes) console.log(`  non-blocking ${note}`);
    if (result.status === "closed") console.log("Work closed.");
    else if (result.pending.approval && action === "submit") console.log(`Approval needed too (${result.pending.approval}): if you are the human, run \`ways approve\` now.`);
    else if (result.pending.approval) console.log(`Human approval needed (${result.pending.approval}): ask the human to run \`ways approve\` in their own terminal.`);
    return 0;
  }

  if (command === "approve") {
    const { approvalPayloadOf, approve, processTerminal } = await import("./work/work.js");
    if (args.includes("--payload")) {
      process.stdout.write(await approvalPayloadOf(cwd));
      return 0;
    }
    const key = option(args, "--key");
    const signatureFile = option(args, "--signature");
    const { readFile } = await import("node:fs/promises");
    const signature = signatureFile === undefined ? undefined : await readFile(userPath(invoked, signatureFile), "utf8");
    const result = await approve(cwd, processTerminal(), { ...(key ? { key } : {}), ...(signature ? { signature } : {}) });
    console.log(`Approved${result.signedBy ? ` (signed by ${result.signedBy})` : ""}${result.status === "closed" ? "; work closed." : "."}`);
    return 0;
  }

  if (command === "block") {
    const reason = args.filter((arg) => !arg.startsWith("--")).join(" ");
    const { block } = await import("./work/work.js");
    const result = await block(cwd, reason);
    let item: string | undefined;
    try {
      const { gitDirs } = await import("./runtime/runtime.js");
      const { blockItem } = await import("./inbox/commands.js");
      item = blockItem(gitDirs(cwd), result.id, reason)?.id;
    } catch {
      // The record holds the block; the inbox is a convenience.
    }
    console.log(`Work ${result.id} is blocked; the human sees why${item ? ` (inbox ${item}: their answer reaches this session through the hooks)` : ""}. Stop here: that is a valid end of this task. A later passing \`ways done\` clears the block; \`ways cancel\` drops the work.`);
    return 0;
  }

  if (command === "ask") {
    const { runAsk } = await import("./inbox/commands.js");
    return runAsk(args, cwd, { option, options });
  }

  if (command === "inbox") {
    const { runInbox } = await import("./inbox/commands.js");
    return runInbox(args, cwd, { option, options });
  }

  if (command === "serve") {
    const { runServe } = await import("./serve/command.js");
    return runServe(args, cwd, { option, options });
  }

  if (command === "cancel") {
    const { cancel } = await import("./work/work.js");
    const result = await cancel(cwd);
    console.log(`Work ${result.id} cancelled${result.commit ? "; its record is marked cancelled" : ""}. Commits are left as they are.`);
    return 0;
  }

  if (command === "check") {
    if (args.includes("--history")) {
      const { checkHistory } = await import("./integrity/history.js");
      const since = option(args, "--since");
      const to = option(args, "--to");
      const issues = await checkHistory(cwd, { ...(since ? { since } : {}), ...(to ? { to } : {}) });
      for (const issue of issues) console.error(`${issue.code}: ${issue.path}: ${issue.message}`);
      if (issues.length > 0) return 1;
      console.log("History checks passed.");
      return 0;
    }
    if (args[0] === "add") {
      const separator = args.indexOf("--");
      const name = args[1];
      const command = separator >= 0 ? args.slice(separator + 1) : [];
      if (!name || name.startsWith("-") || command.length === 0) throw new Error("Usage: ways check add <test|lint|typecheck|build|e2e> -- <command> [args...]   (ways runs it once to validate it)");
      const { addCheck } = await import("./run/validate.js");
      const { gitDirs } = await import("./runtime/runtime.js");
      console.log(`Running \`${command.join(" ")}\` once to validate it…`);
      const added = await addCheck(gitDirs(cwd), name, command);
      for (const line of added.lines) console.log(line);
      if (!added.accepted) return 1;
      console.log(`Saved in ${added.written.join(" and ")}. \`ways run ${name}\` runs it; commit the change (the human approves check changes at \`ways done\` when a check existed before).`);
      return 0;
    }
    const { runChecks } = await import("./check/check.js");
    const { gitDirs } = await import("./runtime/runtime.js");
    const result = await runChecks(cwd, { integrityOnly: args.includes("--integrity-only"), services: args.includes("--with-services"), capture: true, runs: { dirs: gitDirs(cwd) } });
    const { renderCheckReport } = await import("./check/report.js");
    const report = renderCheckReport(result);
    (result.passed ? console.log : console.error)(report);
    // In CI the runner's Git directory is gone after the job: the log of what failed goes to the job's output.
    if (process.env.CI && !result.passed) {
      const { showRun } = await import("./run/run.js");
      for (const check of result.checks.filter((entry) => entry.run && entry.status !== "passed")) {
        console.error(`::group::ways: full log of ${check.name}`);
        try {
          console.error(showRun(gitDirs(cwd), check.run!, { tail: "all" }));
        } catch {
          // No log to show.
        }
        console.error("::endgroup::");
      }
    }
    return result.passed ? 0 : 1;
  }

  if (command === "run") {
    const { runRunCommand } = await import("./run/command.js");
    return runRunCommand(args, cwd, { option });
  }

  if (command === "map") {
    const { writeMap } = await import("./map/map.js");
    const result = await writeMap(cwd, { check: args.includes("--check") });
    if (args.includes("--check")) {
      for (const orphan of result.orphans) console.log(`note for a path that is gone: ${orphan} (.ways/map-notes.json)`);
      if (result.drift.reasons.length === 0) {
        console.log("MAP.md matches the repository.");
        return 0;
      }
      console.error(`MAP.md is out of date: ${result.drift.reasons.join("; ")}. Run \`ways map\` and commit MAP.md.`);
      return 1;
    }
    console.log(result.written ? "MAP.md written; review and commit it. Folder purposes come from .ways/map-notes.json (path → one line)." : "MAP.md is up to date.");
    for (const orphan of result.orphans) console.log(`  note for a path that is gone: ${orphan}; remove it from .ways/map-notes.json`);
    return 0;
  }

  if (command === "verify") {
    const base = option(args, "--base");
    if (!base) throw new Error("Usage: ways verify --base=<sha> [--head=<sha>] [--in-place] [--json=<file>] [--markdown=<file>]   (in a pull request: --base=${{ github.event.pull_request.base.sha }})");
    const head = option(args, "--head");
    const { renderVerifyMarkdown, verifyRange } = await import("./work/verify.js");
    const report = await verifyRange(cwd, { base, ...(head ? { head } : {}), inPlace: args.includes("--in-place") });
    const { appendFile, writeFile } = await import("node:fs/promises");
    const json = option(args, "--json");
    if (json) await writeFile(userPath(invoked, json), `${JSON.stringify(report, null, 2)}\n`);
    const markdown = renderVerifyMarkdown(report);
    const summary = option(args, "--markdown") ?? process.env.GITHUB_STEP_SUMMARY;
    if (summary) await appendFile(userPath(invoked, summary), markdown);
    for (const failure of report.failures) console.error(failure);
    const backed = Object.entries(report.strength).map(([strength, count]) => `${count} ${strength}`).join(", ");
    console.log(`ways verify ${report.passed ? "passed" : "failed"} for ${report.base.slice(0, 12)}..${report.head.slice(0, 12)}: ${report.checks.filter((check) => check.status === "passed").length} check(s) passed, ${report.works.length} work(s)${backed ? `, criteria backed by ${backed}` : ""}.`);
    return report.passed ? 0 : 1;
  }

  if (command === "remember") {
    const fact = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--path").join(" ");
    const { remember, MEMORY_TYPES } = await import("./memory/memory.js");
    const type = choice(args, "--type", Object.keys(MEMORY_TYPES) as Array<keyof typeof MEMORY_TYPES>);
    const id = option(args, "--id");
    const result = await remember(cwd, fact, { paths: options(args, "--path", true), ...(type ? { type } : {}), ...(id ? { id } : {}) });
    const { syncRules } = await import("./context/rules.js");
    const rules = await syncRules(cwd);
    console.log(`Remembered in ${result.path}${rules.written.length > 0 ? ` (Claude Code rule: ${rules.written.join(", ")})` : ""}; commit it with the change that taught it.`);
    for (const warning of result.warnings) console.log(`  note: ${warning}`);
    return 0;
  }

  if (command === "memory") {
    const [action] = args;
    if (action === "index") {
      const { writeIndexes } = await import("./knowledge/indexes.js");
      const indexes = await writeIndexes(cwd);
      const { syncRules } = await import("./context/rules.js");
      const rules = await syncRules(cwd);
      const changed = rules.written.length + rules.removed.length;
      console.log(`Indexed ${indexes.catalog.documents.length} concepts${changed > 0 ? `; Claude Code rules: ${rules.written.length} written, ${rules.removed.length} removed (commit them)` : ""}.`);
      return 0;
    }
    if (action === "check") {
      const { checkMemory } = await import("./memory/memory.js");
      const result = await checkMemory(cwd);
      for (const issue of result.issues) console.error(`${issue.code}: ${issue.path}: ${issue.message}`);
      for (const warning of result.warnings) console.log(`warning ${warning.code}: ${warning.path}: ${warning.message}`);
      if (result.issues.length > 0) return 1;
      console.log(`Memory is valid: ${result.concepts} concepts${result.warnings.length > 0 ? `, ${result.warnings.length} warnings` : ""}.`);
      return 0;
    }
    throw new Error("Usage: ways memory check | index");
  }

  if (command === "query") {
    const query = args.join(" ").trim();
    if (!query) throw new Error("Usage: ways query <terms>");
    const { queryKnowledgeResult } = await import("./query/query.js");
    const result = await queryKnowledgeResult(cwd, query);
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    if (result.hits.length === 0) console.log("No memory matches.");
    for (const hit of result.hits) {
      const labels = hit.labels.length > 0 ? ` [${hit.labels.join(", ")}]` : "";
      console.log(`${hit.score}\t${hit.path}${labels}\t${hit.preview}`);
    }
    return 0;
  }

  if (command === "adapter") {
    const [action, provider] = args;
    const { installAdapter, PROVIDERS } = await import("./adapters/install.js");
    if (action === "list") {
      for (const adapter of PROVIDERS) console.log(`${adapter.id}${adapter.tier === "default" ? "" : " (best effort)"}`);
      return 0;
    }
    if (action === "install" && provider) {
      const result = await installAdapter(cwd, provider, args.includes("--force"));
      console.log(`Adapter ${result.provider} installed: ${result.files.length} files${result.merged.length ? `, merged ${result.merged.join(", ")}` : ""}.`);
      for (const note of result.notes) console.log(`- ${note}`);
      return 0;
    }
    throw new Error("Usage: ways adapter list | install <provider> [--force]");
  }

  if (command === "upgrade") {
    const { applyUpgrade, planUpgrade } = await import("./upgrade/upgrade.js");
    const plan = await planUpgrade(cwd);
    if (!args.includes("--apply")) {
      console.log(`Upgrade ${plan.from} -> ${plan.to}`);
      for (const path of plan.modifiedManagedFiles) console.log(`- [ ] overwrite ${path} (you edited it)`);
      for (const note of plan.notes) console.log(`- ${note}`);
      console.log("Run `ways upgrade --apply` to apply it.");
      return 0;
    }
    const approved = args.includes("--overwrite-all") ? new Set(["*"]) : new Set(options(args, "--overwrite"));
    const applied = await applyUpgrade(cwd, approved);
    for (const note of applied.notes) console.log(`- ${note}`);
    console.log(`ways upgraded to ${applied.to}. Review and commit the changes.`);
    return 0;
  }

  if (command === "bootstrap") {
    const { bootstrap, DEFAULT_AGENTS } = await import("./bootstrap/bootstrap.js");
    const testCommand = jsonOption(args, "--test-command") ?? ["npm", "test"];
    if (!Array.isArray(testCommand) || !testCommand.every((part) => typeof part === "string")) throw new Error("--test-command must be a JSON string array, e.g. --test-command='[\"npm\",\"test\"]'");
    const commands = jsonOption(args, "--commands");
    if (commands !== undefined && (typeof commands !== "object" || commands === null || Array.isArray(commands))) {
      throw new Error("--commands must be a JSON object, e.g. --commands='{\"required\":[\"test\",\"lint\"],\"test\":[\"npm\",\"test\"],\"lint\":[\"npm\",\"run\",\"lint\"]}'");
    }
    const agentsOption = option(args, "--agents");
    const agents = args.includes("--no-adapters") ? [] : agentsOption === undefined ? [...DEFAULT_AGENTS] : agentsOption.split(",").map((agent) => agent.trim()).filter(Boolean);
    const result = await bootstrap({
      cwd,
      testCommand,
      ...(commands === undefined ? {} : { commands: commands as never }),
      force: args.includes("--force"),
      agents,
    });
    console.log(`ways installed (${result.files.length} files, agents: ${agents.join(", ") || "none"}). Describe your project in AGENTS.md, commit, and work as usual: \`ways done\` finishes a change.`);
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
    return 0;
  }

  if (command === "wiki") {
    const { runWiki } = await import("./wiki/command.js");
    return runWiki(args, cwd, { option, options });
  }

  if (command === "evals") {
    return (await import("./evals/cli.js")).runEvalsCommand(args, cwd, { option, options, requiredOption, userPath, relative });
  }

  console.error(`Unknown command: ${command}. Run \`ways --help\` to list the commands.`);
  return 1;
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  enableCompileCache();
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
