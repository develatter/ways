import { effectiveContract } from "../check/contract.js";
import { loadConfig } from "../config/config.js";
import { CHECKS_PATH, CONFIG_PATH } from "../domain/constants.js";
import { CHECK_NAMES, type CheckContract, type CheckName } from "../domain/types.js";
import { gitDirs } from "../runtime/runtime.js";
import { readChecksFile, sameCommand } from "./checks-file.js";
import { budgetOf, compare, isFlaky, renderRun, runCommand, showRun, type Budget, type RunRecord } from "./run.js";

/** A bare run of a check is not bounded by the contract's per-check timeout unless one is configured. */
const RUN_TIMEOUT_MS = 30 * 60_000;

/** The checks that have a command, in their fixed order. */
export function configuredChecks(contract: CheckContract): Array<{ name: CheckName; command: string[] }> {
  if (!contract.commands) return [{ name: "test", command: [...contract.testCommand] }];
  return CHECK_NAMES.flatMap((name) => contract.commands![name] ? [{ name, command: [...contract.commands![name]!] }] : []);
}

export interface RunReport {
  runs: Array<{ record: RunRecord; text: string }>;
  skipped: Array<{ name: CheckName; why: string }>;
  exitCode: number;
  text: string;
}

/**
 * `ways run [<check>...] [--all]`: the configured checks (all of them, in
 * order, without the slow ones unless `--all`), each through the same
 * wrapper `ways done` uses, reported as one compact summary.
 */
export async function runChecksCompact(cwd: string, names: readonly string[], options: { all?: boolean } = {}): Promise<RunReport> {
  const dirs = gitDirs(cwd);
  const contract = effectiveContract(await loadConfig(dirs.top));
  const configured = configuredChecks(contract);
  const file = readChecksFile(dirs.top);
  for (const name of names) {
    if (!configured.some((check) => check.name === name)) {
      const known = configured.map((check) => check.name).join(", ") || "none";
      const hint = (CHECK_NAMES as readonly string[]).includes(name) ? `add it with \`ways check add ${name} -- <command>\`` : `check names are ${CHECK_NAMES.join(", ")}`;
      throw new Error(`No check named "${name}" is configured (configured: ${known}); ${hint}`);
    }
  }
  const skipped: RunReport["skipped"] = [];
  const selected = configured.filter((check) => {
    if (names.length > 0) return names.includes(check.name);
    const entry = file.checks[check.name];
    if (!options.all && entry?.slow && sameCommand(entry.command, check.command)) {
      skipped.push({ name: check.name, why: `slow (${Math.round((entry.durationMs ?? 0) / 1000)} s)` });
      return false;
    }
    return true;
  });
  const budget = budgetOf(dirs.top);
  const runs: RunReport["runs"] = [];
  let exitCode = 0;
  // The budget is for the whole report: every later check keeps room for its one line.
  let remaining: Budget = { ...budget };
  for (const [index, check] of selected.entries()) {
    const { record } = await runCommand(dirs, check.name, check.command, { timeoutMs: contract.commands?.timeoutMs ?? RUN_TIMEOUT_MS });
    const entry = file.checks[check.name];
    const comparison = await compare(dirs, record, entry && sameCommand(entry.command, check.command) ? entry.baseline : undefined);
    const reserve = selected.length - index - 1;
    const text = renderRun(dirs, record, { maxLines: Math.max(3, remaining.maxLines - reserve), maxChars: Math.max(240, remaining.maxChars - reserve * 120) }, comparison, record.status !== "passed" && isFlaky(dirs.top, check.name));
    remaining = { maxLines: remaining.maxLines - text.split("\n").length, maxChars: remaining.maxChars - text.length - 1 };
    runs.push({ record, text });
    if (exitCode === 0 && record.status !== "passed") exitCode = record.exitCode && record.exitCode > 0 ? record.exitCode : 1;
  }
  const lines = runs.map((run) => run.text);
  if (skipped.length > 0) lines.push(`(skipped: ${skipped.map((entry) => `${entry.name}, ${entry.why}`).join("; ")}; \`ways run --all\` includes them)`);
  if (selected.length === 0 && skipped.length === 0) lines.push(`No checks are configured: add one with \`ways check add test -- <command>\` (it is run once to validate it, then saved in ${CONFIG_PATH} and ${CHECKS_PATH}).`);
  return { runs, skipped, exitCode, text: lines.join("\n") };
}

type Options = { option(args: readonly string[], name: string): string | undefined };

export async function runRunCommand(args: readonly string[], cwd: string, { option }: Options): Promise<number> {
  const showIndex = args.indexOf("--show");
  const show = option(args, "--show") ?? (showIndex >= 0 ? args[showIndex + 1] : undefined);
  if (showIndex >= 0 || option(args, "--show") !== undefined) {
    if (!show || show.startsWith("--")) throw new Error("Usage: ways run --show <id> [--grep=<regex>] [--tail=<n>|all]   (the id is printed after each run)");
    const tail = option(args, "--tail");
    const parsed = tail === undefined ? undefined : tail === "all" ? "all" as const : Number(tail);
    if (typeof parsed === "number" && (!Number.isInteger(parsed) || parsed < 1)) throw new Error(`--tail must be a positive number of lines or "all", got "${tail}"`);
    const grep = option(args, "--grep");
    process.stdout.write(`${showRun(gitDirs(cwd), show, { ...(grep === undefined ? {} : { grep }), ...(parsed === undefined ? {} : { tail: parsed }) })}\n`);
    return 0;
  }
  const names = args.filter((arg) => !arg.startsWith("--"));
  const report = await runChecksCompact(cwd, names, { all: args.includes("--all") });
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ exitCode: report.exitCode, runs: report.runs.map((run) => run.record), skipped: report.skipped }, null, 2)}\n`);
  else process.stdout.write(`${report.text}\n`);
  return report.exitCode;
}
