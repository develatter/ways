import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execute, executeWithRetries, type CapturedResult } from "../check/process.js";
import { GitRepository } from "../git/git.js";
import { readQuarantine } from "../runtime/ledger.js";
import { readActive, writeFileAtomic, type GitDirs } from "../runtime/runtime.js";
import { readChecksFile, sameCommand, DEFAULT_MAX_CHARS, DEFAULT_MAX_LINES, type Baseline } from "./checks-file.js";
import { readOutput, renderCounts, type Counts, type Failure } from "./parsers.js";

/**
 * One run of a check (or a criterion's verifier), as ways keeps it: the
 * whole output in `<git-common-dir>/ways/runs/<id>.log`, never in history,
 * and a reading of it in `<id>.json`. The agent gets the summary; the log is
 * there when it needs more (`ways run --show <id>`). `ways run`, `ways done`
 * and `ways verify` all record their runs this way.
 */
export interface RunRecord {
  v: 1;
  id: string;
  /** `test`, `lint`, ... or `criterion:AC1`. */
  check: string;
  command: string[];
  status: "passed" | "failed" | "timed-out" | "unavailable";
  exitCode?: number;
  detail?: string;
  durationMs: number;
  outputSha256?: string;
  bytes: number;
  lines: number;
  tool: string;
  counts: Counts;
  failures: Failure[];
  /** HEAD when it ran. */
  commit: string | null;
  /** The working tree had no changes: the run is of `commit` itself. */
  clean: boolean;
  at: string;
}

/** The most this keeps: older runs and their logs are removed. */
const KEEP_RUNS = 100;
const MAX_FAILURES_KEPT = 200;

export function runsDir(dirs: Pick<GitDirs, "common">): string {
  return join(dirs.common, "ways", "runs");
}

export function logPath(dirs: Pick<GitDirs, "common">, id: string): string {
  return join(runsDir(dirs), `${id}.log`);
}

/** The log path as the agent should read it: relative to the worktree when it is inside it. */
export function shownLogPath(dirs: GitDirs, id: string): string {
  const path = logPath(dirs, id);
  const inside = relative(dirs.top, path);
  return inside && !inside.startsWith("..") ? inside : path;
}

export function newRunId(check: string): string {
  const label = check.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 24) || "run";
  return `${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

export function readRun(dirs: Pick<GitDirs, "common">, id: string): RunRecord | undefined {
  if (!validId(id)) return undefined;
  try {
    const value = JSON.parse(readFileSync(join(runsDir(dirs), `${id}.json`), "utf8")) as RunRecord;
    return value.v === 1 && value.id === id ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Every recorded run, newest first. */
export function listRuns(dirs: Pick<GitDirs, "common">): RunRecord[] {
  let names: string[];
  try {
    names = readdirSync(runsDir(dirs)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const runs: RunRecord[] = [];
  for (const name of names) {
    const run = readRun(dirs, name.slice(0, -5));
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function prune(dirs: Pick<GitDirs, "common">): void {
  let entries: Array<{ name: string; mtime: number }>;
  try {
    entries = readdirSync(runsDir(dirs)).filter((name) => name.endsWith(".json")).map((name) => ({ name, mtime: statSync(join(runsDir(dirs), name)).mtimeMs }));
  } catch {
    return;
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const entry of entries.slice(KEEP_RUNS)) {
    const id = entry.name.slice(0, -5);
    rmSync(join(runsDir(dirs), entry.name), { force: true });
    rmSync(logPath(dirs, id), { force: true });
  }
}

/** Uncommitted changes (tracked or new, not ignored) make a run not a run of HEAD. */
async function treeIsClean(top: string): Promise<boolean> {
  try {
    return (await new GitRepository(top).run(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal"])).trim() === "";
  } catch {
    return false;
  }
}

async function headOf(top: string): Promise<string | null> {
  try {
    return await new GitRepository(top).head();
  } catch {
    return null;
  }
}

/** Plain output: tools print less decoration without colours, and the parsers read it better. */
function runEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR: "0" };
}

/** Turns a captured execution into a record, writes it next to its log, and prunes old runs. */
export function recordRun(dirs: Pick<GitDirs, "common">, input: { id: string; check: string; command: string[]; result: CapturedResult; commit: string | null; clean: boolean }): RunRecord {
  const { result } = input;
  const output = result.output ?? result.tail ?? "";
  const reading = result.status === "unavailable" ? { tool: "none", counts: {}, failures: [{ id: "cannot start", lines: [result.detail ?? "the command could not start"] }] } : readOutput(output, result.status === "timed-out" ? 124 : result.exitCode, input.command);
  const record: RunRecord = {
    v: 1,
    id: input.id,
    check: input.check,
    command: [...input.command],
    status: result.status,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.detail ? { detail: result.detail } : {}),
    durationMs: result.durationMs ?? 0,
    ...(result.outputSha256 ? { outputSha256: result.outputSha256 } : {}),
    bytes: result.bytes ?? Buffer.byteLength(output),
    lines: output === "" ? 0 : output.split("\n").length,
    tool: reading.tool,
    counts: reading.counts,
    failures: result.status === "passed" ? [] : reading.failures.slice(0, MAX_FAILURES_KEPT),
    commit: input.commit,
    clean: input.clean,
    at: new Date().toISOString(),
  };
  try {
    writeFileAtomic(join(runsDir(dirs), `${input.id}.json`), `${JSON.stringify(record)}\n`);
    prune(dirs);
  } catch {
    // An unwritable Git directory costs the record, not the run.
  }
  return record;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Retries of a failing run (`ways done`); a bare `ways run` runs once. */
  retries?: number;
  /** Where the command runs, when not the worktree (a clean checkout). */
  cwd?: string;
  /** What the run is of, when ways knows better than the working tree (a clean checkout of a commit). */
  commit?: string;
}

/** Runs one command with its whole output going to the log; returns the record and the raw result. */
export async function runCommand(dirs: GitDirs, check: string, command: string[], options: RunOptions = {}): Promise<{ record: RunRecord; result: CapturedResult & { attempts?: number; flakyFailure?: CapturedResult } }> {
  const id = newRunId(check);
  const cwd = options.cwd ?? dirs.top;
  const [commit, clean] = options.commit ? [options.commit, true] : await Promise.all([headOf(dirs.top), treeIsClean(dirs.top)]);
  const capture = { log: logPath(dirs, id), keep: true, env: runEnv() };
  const result = options.retries
    ? await executeWithRetries(command, cwd, options.timeoutMs, true, options.retries, capture)
    : await execute(command, cwd, options.timeoutMs, true, "capture", capture);
  return { record: recordRun(dirs, { id, check, command, result, commit, clean }), result };
}

export interface Comparison {
  /** What the failures were compared with. */
  against: string;
  base: string;
  /** Failure ids that did not fail there. */
  fresh: string[];
  known: string[];
}

/**
 * The commit a run is judged against: the active work's base, or HEAD when
 * the working tree has changes (what you changed against what is
 * committed). With neither, nothing.
 */
async function comparisonBase(dirs: GitDirs, record: RunRecord): Promise<string | undefined> {
  const active = readActive(dirs.top);
  if (active?.base && active.base !== record.commit) return active.base;
  if (!record.clean && record.commit) return record.commit;
  return active?.base;
}

/** The newest clean run of the same check and command on `commit`. */
export function runAt(dirs: Pick<GitDirs, "common">, check: string, command: readonly string[], commit: string, except?: string): RunRecord | undefined {
  return listRuns(dirs).find((run) => run.id !== except && run.check === check && run.clean && run.commit === commit && sameCommand(run.command, command) && run.status !== "unavailable");
}

/** New failures against the base's run, or else against the line base in .ways/checks.json; undefined with nothing to compare. */
export async function compare(dirs: GitDirs, record: RunRecord, baseline?: Baseline): Promise<Comparison | undefined> {
  if (record.status === "passed" || record.failures.length === 0) return undefined;
  const base = await comparisonBase(dirs, record);
  const ids = record.failures.map((failure) => failure.id);
  const previous = base ? runAt(dirs, record.check, record.command, base, record.id) : undefined;
  if (base && previous) {
    const failed = new Set(previous.failures.map((failure) => failure.id));
    return { against: `the run of the base ${base.slice(0, 12)} (${previous.id})`, base, fresh: ids.filter((id) => !failed.has(id)), known: ids.filter((id) => failed.has(id)) };
  }
  if (baseline && baseline.status !== "timed-out") {
    const failed = new Set(baseline.failures ?? []);
    return { against: `the line base in .ways/checks.json (${baseline.commit.slice(0, 12)})`, base: baseline.commit, fresh: ids.filter((id) => !failed.has(id)), known: ids.filter((id) => failed.has(id)) };
  }
  return undefined;
}

export interface Budget {
  maxLines: number;
  maxChars: number;
}

export function budgetOf(top: string): Budget {
  const output = readChecksFile(top).output;
  return { maxLines: output?.maxLines ?? DEFAULT_MAX_LINES, maxChars: output?.maxChars ?? DEFAULT_MAX_CHARS };
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The one line that says how a run went. */
export function headline(record: RunRecord, comparison?: Comparison): string {
  const mark = record.status === "passed" ? "✓" : "✗";
  const counts = renderCounts(record.counts);
  const status = record.status === "passed" ? "passed" : record.status === "timed-out" ? "timed out" : record.status === "unavailable" ? "could not start" : "failed";
  const exit = record.status === "failed" && record.exitCode !== undefined ? ` (exit ${record.exitCode})` : "";
  const versus = comparison ? `; ${comparison.fresh.length} new, ${comparison.known.length} already failing at ${comparison.base.slice(0, 12)}` : "";
  return `${mark} ${record.check}: ${status} in ${seconds(record.durationMs)}${exit}${counts ? ` — ${counts}` : ""}${versus}`;
}

/**
 * The summary the agent reads instead of the log: one line when it passed;
 * otherwise the headline, each failure on one line with its first error
 * lines (new failures first, known ones as a bare list), and where the log
 * is. It never exceeds the budget; what does not fit is counted.
 */
export function renderRun(dirs: GitDirs, record: RunRecord, budget: Budget, comparison?: Comparison, flaky = false): string {
  const show = `ways run --show ${record.id}`;
  if (record.status === "passed") return `${headline(record)} (log: ${show})`;
  const lines: string[] = [headline(record, comparison) + (flaky ? " — known flaky here (it failed and then passed on a retry before)" : "")];
  const footer = `Full log (${record.lines} lines): ${show} [--grep=<regex>] [--tail=<n>]  ${shownLogPath(dirs, record.id)}`;
  // Room is kept for the footer and for the line that counts what did not fit.
  const more = 70;
  let chars = lines[0]!.length + footer.length + more + 2;
  let used = 3;
  const fits = (text: string): boolean => used + 1 <= budget.maxLines && chars + text.length + 1 <= budget.maxChars;
  const push = (text: string): boolean => {
    if (!fits(text)) return false;
    lines.push(text);
    used += 1;
    chars += text.length + 1;
    return true;
  };
  const known = new Set(comparison?.known ?? []);
  const fresh = record.failures.filter((failure) => !known.has(failure.id));
  const old = record.failures.filter((failure) => known.has(failure.id));
  let shown = 0;
  outer: for (const failure of fresh) {
    const label = comparison ? "new " : "";
    if (!push(`  ✗ ${label}${clip(failure.id, 140)}${failure.where && !failure.id.includes(failure.where) ? `  (${failure.where})` : ""}`)) break;
    shown += 1;
    for (const detail of failure.lines.slice(0, 4)) {
      if (!push(`      ${clip(detail, 160)}`)) break outer;
    }
  }
  let listed = 0;
  if (old.length > 0) {
    const names = old.map((failure) => clip(failure.id, 80));
    let text = `  already failing at the base: `;
    for (const name of names) {
      const next = `${text}${listed > 0 ? ", " : ""}${name}`;
      if (next.length > 300 || !fits(next)) break;
      text = next;
      listed += 1;
    }
    if (listed > 0) push(text);
  }
  const hidden = fresh.length - shown + (old.length - listed);
  if (hidden > 0) lines.push(`  … ${hidden} more failure(s) in the log (--grep=<name>)`);
  lines.push(footer);
  return lines.join("\n");
}

/** The summary kept in evidence: the headline and each failure on one line (at most five, 800 characters). */
export function compactSummary(record: RunRecord): string {
  const lines = [headline(record)];
  for (const failure of record.failures.slice(0, 5)) {
    const detail = failure.lines[0] ? `: ${failure.lines[0]}` : "";
    lines.push(`  ✗ ${clip(`${failure.id}${failure.where && !failure.id.includes(failure.where) ? ` (${failure.where})` : ""}${detail}`, 150)}`);
  }
  if (record.failures.length > 5) lines.push(`  … ${record.failures.length - 5} more`);
  const text = lines.join("\n");
  return text.length > 800 ? `${text.slice(0, 799)}…` : text;
}

/** Whether a check key is in the local flaky quarantine. */
export function isFlaky(top: string, check: string): boolean {
  return readQuarantine(top).some((entry) => entry.key === `check:${check}`);
}

/** `ways run --show <id>`: the log, all or filtered. */
export function showRun(dirs: GitDirs, id: string, options: { grep?: string; tail?: number | "all" } = {}): string {
  if (!validId(id)) throw new Error(`"${id}" is not a run id; \`ways run\` prints the id of each run after --show`);
  const path = logPath(dirs, id);
  if (!existsSync(path)) throw new Error(`No log for run ${id}: runs are kept in ${runsDir(dirs)} (the newest ${KEEP_RUNS}); run the check again with \`ways run <check>\``);
  const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
  const all = text.replace(/\n$/, "").split("\n");
  if (options.grep !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(options.grep, "i");
    } catch {
      throw new Error(`--grep must be a regular expression, got "${options.grep}"`);
    }
    const hits = all.map((line, index) => [index + 1, line] as const).filter(([, line]) => pattern.test(line));
    const limit = options.tail === "all" ? hits.length : options.tail ?? 200;
    const kept = hits.slice(-limit);
    return [...kept.map(([number, line]) => `${number}: ${line}`), `(${hits.length} of ${all.length} lines match${hits.length > kept.length ? `; the last ${kept.length} shown, --tail=all for every one` : ""})`].join("\n");
  }
  const limit = options.tail === "all" ? all.length : options.tail ?? 200;
  const kept = all.slice(-limit);
  return kept.length < all.length ? [`(the last ${kept.length} of ${all.length} lines; --tail=<n> or --tail=all for more, --grep=<regex> to filter)`, ...kept].join("\n") : kept.join("\n");
}
