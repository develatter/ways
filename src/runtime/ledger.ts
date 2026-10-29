import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeDir, writeFileAtomic } from "./runtime.js";

/**
 * Small runtime ledgers the evaluation keeps between runs, in
 * `<git-common-dir>/ways/` (never committed; the committed evidence carries
 * what matters):
 *
 * - `flaky.json`: the quarantine, checks and verifiers that failed and then
 *   passed on a retry. `ways status` and `ways done` show it.
 * - `tests.json`: how many tests the test check ran per commit, the ratchet's
 *   baseline when no committed evidence has one.
 * - `baseline/<commit>.json`: what each verifier returned on a base commit,
 *   so red-on-base runs once per base and verifier.
 */
function read<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export interface FlakyEntry {
  /** `check:test`, or a criterion id with its work: `greeting/AC1`. */
  key: string;
  command: string[];
  /** Times it failed and then passed on a retry. */
  count: number;
  lastAt: string;
  lastCommit: string;
  /** The tail of the failing attempt. */
  tail?: string;
}

const flakyPath = (cwd: string): string => join(runtimeDir(cwd), "flaky.json");

export function readQuarantine(cwd: string): FlakyEntry[] {
  const value = read<unknown>(flakyPath(cwd), []);
  return Array.isArray(value) ? value.filter((entry): entry is FlakyEntry => typeof entry?.key === "string" && typeof entry?.count === "number") : [];
}

export function quarantine(cwd: string, entry: Omit<FlakyEntry, "count">): void {
  const entries = readQuarantine(cwd);
  const existing = entries.find((candidate) => candidate.key === entry.key);
  if (existing) Object.assign(existing, entry, { count: existing.count + 1 });
  else entries.push({ ...entry, count: 1 });
  write(flakyPath(cwd), entries);
}

const testsPath = (cwd: string): string => join(runtimeDir(cwd), "tests.json");

export function recordTestsRan(cwd: string, commit: string, ran: number): void {
  const counts = read<Record<string, number>>(testsPath(cwd), {});
  counts[commit] = ran;
  // Keep the file small: the newest 500 commits are plenty for a baseline.
  const entries = Object.entries(counts);
  write(testsPath(cwd), Object.fromEntries(entries.slice(Math.max(0, entries.length - 500))));
}

export function testsRanAt(cwd: string, commit: string): number | undefined {
  const value = read<Record<string, unknown>>(testsPath(cwd), {})[commit];
  return typeof value === "number" ? value : undefined;
}

export interface BaselineRun {
  status: "passed" | "failed" | "error";
  exitCode?: number;
  durationMs?: number;
  outputSha256?: string;
  tail?: string;
  detail?: string;
}

const baselinePath = (cwd: string, commit: string): string => join(runtimeDir(cwd), "baseline", `${commit}.json`);

export function readBaseline(cwd: string, commit: string, key: string): BaselineRun | undefined {
  return read<Record<string, BaselineRun>>(baselinePath(cwd, commit), {})[key];
}

export function writeBaseline(cwd: string, commit: string, key: string, run: BaselineRun): void {
  const runs = read<Record<string, BaselineRun>>(baselinePath(cwd, commit), {});
  runs[key] = run;
  write(baselinePath(cwd, commit), runs);
}
