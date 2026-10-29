import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECKS_PATH, CONFIG_PATH } from "../domain/constants.js";
import { CHECK_NAMES, type CheckName, type HarnessConfig, type NamedChecksConfig } from "../domain/types.js";
import { validateConfig, validationDetails } from "../domain/validation.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import type { DetectedCommand } from "../map/detect.js";
import type { GitDirs } from "../runtime/runtime.js";
import { DEFAULT_SLOW_MS, readChecksFile, writeChecksFile, type CheckEntry } from "./checks-file.js";
import { runCommand, type RunRecord } from "./run.js";

/**
 * A check enters the project only after ways ran it: a detected or proposed
 * command that cannot start, is not there (exit 126/127, a missing script or
 * module) or runs no tests is rejected with the reason; one that runs and
 * reports (passing, or failing with failures its tool names) is kept with
 * its line base. The agent can propose; only this decides.
 */
export interface Candidate {
  name: CheckName;
  command: string[];
  source: string;
}

export interface Accepted {
  name: CheckName;
  command: string[];
  source: string;
  run: RunRecord;
  slow: boolean;
}

export interface Rejected {
  name: CheckName;
  command: string[];
  source: string;
  reason: string;
  run?: string;
}

export interface Validation {
  accepted: Accepted[];
  rejected: Rejected[];
}

/** Output that says the command itself is missing or broken, not the code it checks. */
const BROKEN: RegExp[] = [
  /npm (?:ERR!|error) Missing script/i,
  /^error Command ".*" not found/im,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /No module named (?:pytest|ruff|mypy|flake8)\b/i,
  /^error: no such command/im,
  /could not determine executable to run/i,
  /npm (?:ERR!|error) could not determine executable/i,
  /No test files found/i,
  /no tests ran in/i,
  /Cannot find module '.*?(?:vitest|jest|eslint|typescript)/i,
  /^make: \*\*\* No rule to make target/im,
];

export function rejection(record: RunRecord, output: string): string | undefined {
  if (record.status === "unavailable") return `it cannot start (${record.detail ?? "not found"})`;
  if (record.status === "timed-out") return undefined;
  if (record.exitCode === 126 || record.exitCode === 127) return `exit ${record.exitCode}: the program is not installed or not executable`;
  // pytest's "no tests collected" exit code.
  if (record.exitCode === 5 && record.tool === "pytest") return "it collected no tests";
  const broken = BROKEN.map((pattern) => pattern.exec(output)?.[0]).find(Boolean);
  if (broken) return `it reports "${broken.trim()}"`;
  if (record.status === "failed" && record.tool === "generic") return `exit ${record.exitCode ?? "?"} and no output ways recognises as a test, lint or type report (see \`ways run --show ${record.id}\`)`;
  return undefined;
}

export interface ValidateOptions {
  /** The longest a validation run may take; a run that hits it is kept as slow, its line base unknown. */
  timeoutMs?: number;
  slowMs?: number;
  /** Called before each run, for progress. */
  onRun?: (candidate: Candidate) => void;
}

/** Runs candidates in order; per check, the first that validates wins and the rest of that check's candidates are not run. */
export async function validateCandidates(dirs: GitDirs, candidates: readonly Candidate[], options: ValidateOptions = {}): Promise<Validation> {
  const accepted: Accepted[] = [];
  const rejected: Rejected[] = [];
  const slowMs = options.slowMs ?? readChecksFile(dirs.top).slowMs ?? DEFAULT_SLOW_MS;
  for (const candidate of candidates) {
    if (accepted.some((entry) => entry.name === candidate.name)) continue;
    options.onRun?.(candidate);
    const { record, result } = await runCommand(dirs, candidate.name, candidate.command, { timeoutMs: options.timeoutMs ?? 5 * 60_000 });
    const reason = rejection(record, result.output ?? result.tail ?? "");
    if (reason) rejected.push({ ...candidate, reason, run: record.id });
    else accepted.push({ ...candidate, run: record, slow: record.status === "timed-out" || record.durationMs > slowMs });
  }
  return { accepted, rejected };
}

/** Candidates from a detection: every alternative per check, in check order. */
export function detectedCandidates(candidates: Partial<Record<CheckName, DetectedCommand[]>>, only?: readonly CheckName[]): Candidate[] {
  return CHECK_NAMES.filter((name) => !only || only.includes(name)).flatMap((name) => (candidates[name] ?? []).map((entry) => ({ name, command: entry.argv, source: entry.source })));
}

export function entryOf(accepted: Accepted): CheckEntry {
  const run = accepted.run;
  return {
    command: [...accepted.command],
    source: accepted.source,
    durationMs: run.durationMs,
    ...(accepted.slow ? { slow: true } : {}),
    ...(run.commit ? {
      baseline: {
        commit: run.commit,
        status: run.status === "passed" ? "passed" : run.status === "timed-out" ? "timed-out" : "failed",
        at: run.at,
        ...(Object.keys(run.counts).length > 0 ? { counts: run.counts } : {}),
        ...(run.failures.length > 0 ? { failures: run.failures.map((failure) => failure.id) } : {}),
      },
    } : {}),
  };
}

/**
 * Records accepted checks: the commands in `.ways/config.json` (`commands`,
 * required; `testCommand` follows `test`) and what ways observed in
 * `.ways/checks.json`. Returns the paths written.
 */
export async function recordChecks(top: string, accepted: readonly Accepted[]): Promise<string[]> {
  if (accepted.length === 0) return [];
  const config = JSON.parse(await readFile(join(top, CONFIG_PATH), "utf8")) as HarnessConfig;
  const commands: NamedChecksConfig = config.commands ? structuredClone(config.commands) : { required: [], test: [...config.testCommand] };
  if (!config.commands && !commands.required.includes("test")) commands.required.push("test");
  for (const entry of accepted) {
    commands[entry.name] = [...entry.command];
    if (!commands.required.includes(entry.name)) commands.required.push(entry.name);
  }
  commands.required = CHECK_NAMES.filter((name) => commands.required.includes(name));
  const next: HarnessConfig = { ...config, commands, ...(commands.test ? { testCommand: [...commands.test] } : {}) };
  if (!validateConfig(next)) throw new Error(`The checks would make ${CONFIG_PATH} invalid: ${validationDetails("config", next).errors.join("; ")}`);
  const written: string[] = [];
  const content = stableJson(next);
  if (content !== await readFile(join(top, CONFIG_PATH), "utf8")) {
    await writeAtomic(join(top, CONFIG_PATH), content);
    written.push(CONFIG_PATH);
  }
  const file = readChecksFile(top);
  for (const entry of accepted) {
    file.checks[entry.name] = entryOf(entry);
    if (file.proposed?.[entry.name]) delete file.proposed[entry.name];
  }
  writeChecksFile(top, file);
  written.push(CHECKS_PATH);
  return written;
}

/** `ways check add <name> -- <command>`: run it once, keep it only if it validates; MAP.md follows when there is one. */
export async function addCheck(dirs: GitDirs, name: string, command: readonly string[]): Promise<{ accepted: boolean; lines: string[]; written: string[] }> {
  if (!(CHECK_NAMES as readonly string[]).includes(name)) throw new Error(`A check is one of ${CHECK_NAMES.join(", ")}, got "${name}"; e.g. \`ways check add lint -- npx eslint .\``);
  if (command.length === 0 || command.some((part) => part.length === 0)) throw new Error("Give the command after `--`, e.g. `ways check add lint -- npx eslint .`");
  const validation = await validateCandidates(dirs, [{ name: name as CheckName, command: [...command], source: "ways check add" }]);
  const lines = describeValidation(validation);
  if (validation.accepted.length === 0) return { accepted: false, lines: [...lines, "Nothing was saved. Fix the command (it runs without a shell: no pipes or &&; wrap those in a script) and try again."], written: [] };
  const written = await recordChecks(dirs.top, validation.accepted);
  const { existsSync } = await import("node:fs");
  const { MAP_PATH } = await import("../domain/constants.js");
  if (existsSync(join(dirs.top, MAP_PATH))) {
    const { writeMap } = await import("../map/map.js");
    if ((await writeMap(dirs.top)).written) written.push(MAP_PATH);
  }
  return { accepted: true, lines, written };
}

/** One line per accepted or rejected candidate, for the human. */
export function describeValidation(validation: Validation): string[] {
  const lines: string[] = [];
  for (const entry of validation.accepted) {
    const run = entry.run;
    const state = run.status === "passed" ? "passes" : run.status === "timed-out" ? "ran past the validation timeout (kept as slow; its line base is unknown)" : `already fails${run.failures.length > 0 ? ` (${run.failures.length}: ${run.failures.slice(0, 3).map((failure) => failure.id).join(", ")}${run.failures.length > 3 ? ", …" : ""})` : ""}; recorded as the line base`;
    lines.push(`  ✓ ${entry.name}: ${entry.command.join(" ")} — ${state}, ${(run.durationMs / 1000).toFixed(1)} s${entry.slow ? ", slow" : ""}`);
  }
  for (const entry of validation.rejected) lines.push(`  ✗ ${entry.name}: ${entry.command.join(" ")} — rejected: ${entry.reason}`);
  return lines;
}
