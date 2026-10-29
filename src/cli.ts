#!/usr/bin/env node

import { fstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/*
 * Modules load per command: `ways hook` runs on every commit and must not pay
 * for schemas, evals or adapters it never uses.
 */

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

  try {
    return await dispatch(command, args, cwd);
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

async function dispatch(command: string, args: string[], cwd: string): Promise<number> {
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
    const weak = record.criteria.filter((criterion) => criterion.strength === "review-only").map((criterion) => criterion.id);
    console.log(`Outcome ${id} opened with ${record.criteria.length} criteria (review ${record.policy.review}, human approval ${record.policy.approval}).`);
    if (weak.length > 0) console.log(`No executable verifier for ${weak.join(", ")}: they are review-only, so an independent review is required. Add --verify=<ID>:<command> when a check exists.`);
    console.log("Implement and commit as you go; run `ways done` when it is finished.");
    return 0;
  }

  if (command === "done") {
    const { done } = await import("./work/work.js");
    const message = option(args, "--message");
    const result = await done(cwd, message === undefined ? {} : { message });
    const { printDone } = await import("./work/report.js");
    printDone(result);
    return result.status === "failed" ? 1 : 0;
  }

  if (command === "review") {
    const [action, path] = args;
    if (action !== "submit" || !path) throw new Error("Usage: ways review submit <review.json>");
    const { submitReview } = await import("./work/work.js");
    const result = await submitReview(cwd, userPath(cwd, path));
    console.log(result.blockers.length > 0 ? `Review recorded; it blocks: ${result.blockers.join(", ")}. Fix them, commit, run \`ways done\` and get a fresh review.` : "Review recorded: pass.");
    for (const note of result.notes) console.log(`  non-blocking ${note}`);
    if (result.status === "closed") console.log("Work closed.");
    else if (result.pending.approval) console.log(`Human approval needed (${result.pending.approval}): ask the human to run \`ways approve\` in their own terminal.`);
    return 0;
  }

  if (command === "approve") {
    const { approve } = await import("./work/work.js");
    const result = await approve(cwd);
    console.log(result.status === "closed" ? "Approved; work closed." : "Approved.");
    return 0;
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
    const { failedCheckDetails, runChecks } = await import("./check/check.js");
    const result = await runChecks(cwd, { integrityOnly: args.includes("--integrity-only"), services: args.includes("--with-services") });
    for (const issue of result.issues) console.error(`${issue.code}: ${issue.path}: ${issue.message}`);
    for (const failure of failedCheckDetails(result)) console.error(failure);
    if (!result.passed) return 1;
    console.log("Checks passed.");
    return 0;
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
    return 0;
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
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
