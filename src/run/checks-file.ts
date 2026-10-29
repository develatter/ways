import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKS_PATH } from "../domain/constants.js";
import { CHECK_NAMES, type CheckName } from "../domain/types.js";
import { writeFileAtomic } from "../runtime/runtime.js";
import type { Counts } from "./parsers.js";

/**
 * `.ways/checks.json`: what ways learned about the project's checks by
 * running them, committed so every clone and CI start from it. It is not the
 * contract: what `ways done` and `ways verify` run is `commands` in
 * `.ways/config.json` (on the verifier surface, so changing it needs the
 * human). This file holds observations that decide no verdict: where each
 * command came from, how long it takes (slow checks are left out of a bare
 * `ways run`), the line base (passing, or already failing with these
 * failures) and what the onboarder proposed and ways has not run yet.
 */
export interface Baseline {
  commit: string;
  status: "passed" | "failed" | "timed-out";
  at: string;
  counts?: Counts;
  /** Ids of what already failed there: `ways run` reports them as known, not new. */
  failures?: string[];
}

export interface CheckEntry {
  command: string[];
  /** Where the command came from: `package.json scripts.test`, `.github/workflows/ci.yml`, `ways check add`, `onboarder`. */
  source: string;
  durationMs?: number;
  /** Over the slow threshold: `ways run` without a name skips it; `--all` includes it. */
  slow?: boolean;
  baseline?: Baseline;
}

export interface Proposal {
  command: string[];
  why?: string;
}

export interface ChecksFile {
  schemaVersion: 1;
  /** How much a summary may say, in total, for all the checks of one `ways run`. */
  output?: { maxLines?: number; maxChars?: number };
  /** A check whose validation run took longer than this is slow. */
  slowMs?: number;
  checks: Partial<Record<CheckName, CheckEntry>>;
  /** The onboarder's proposals; ways runs each and moves it to `checks` or drops it. */
  proposed?: Partial<Record<CheckName, Proposal>>;
}

export const DEFAULT_MAX_LINES = 40;
export const DEFAULT_MAX_CHARS = 2000;
export const DEFAULT_SLOW_MS = 60_000;

function argv(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0) ? value as string[] : undefined;
}

function isName(value: string): value is CheckName {
  return (CHECK_NAMES as readonly string[]).includes(value);
}

/** Tolerant: an unreadable or hand-broken file reads as empty (it decides nothing). */
export function readChecksFile(top: string): ChecksFile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(top, CHECKS_PATH), "utf8"));
  } catch {
    return { schemaVersion: 1, checks: {} };
  }
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const file: ChecksFile = { schemaVersion: 1, checks: {} };
  const output = input.output && typeof input.output === "object" ? input.output as Record<string, unknown> : undefined;
  if (output) {
    file.output = {};
    if (Number.isInteger(output.maxLines) && (output.maxLines as number) > 0) file.output.maxLines = output.maxLines as number;
    if (Number.isInteger(output.maxChars) && (output.maxChars as number) > 0) file.output.maxChars = output.maxChars as number;
  }
  if (Number.isInteger(input.slowMs) && (input.slowMs as number) > 0) file.slowMs = input.slowMs as number;
  const checks = input.checks && typeof input.checks === "object" ? input.checks as Record<string, unknown> : {};
  for (const [name, raw] of Object.entries(checks)) {
    if (!isName(name) || !raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const command = argv(entry.command);
    if (!command) continue;
    file.checks[name] = {
      command,
      source: typeof entry.source === "string" ? entry.source : "unknown",
      ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
      ...(entry.slow === true ? { slow: true } : {}),
      ...(entry.baseline && typeof entry.baseline === "object" && typeof (entry.baseline as Baseline).commit === "string" ? { baseline: entry.baseline as Baseline } : {}),
    };
  }
  const proposed = input.proposed && typeof input.proposed === "object" ? input.proposed as Record<string, unknown> : {};
  for (const [name, raw] of Object.entries(proposed)) {
    if (!isName(name) || !raw || typeof raw !== "object") continue;
    const command = argv((raw as Record<string, unknown>).command);
    const why = (raw as Record<string, unknown>).why;
    if (command) (file.proposed ??= {})[name] = { command, ...(typeof why === "string" ? { why } : {}) };
  }
  return file;
}

export function writeChecksFile(top: string, file: ChecksFile): void {
  const ordered: ChecksFile = { schemaVersion: 1, ...(file.output ? { output: file.output } : {}), ...(file.slowMs ? { slowMs: file.slowMs } : {}), checks: {} };
  for (const name of CHECK_NAMES) if (file.checks[name]) ordered.checks[name] = file.checks[name];
  const proposed = Object.entries(file.proposed ?? {});
  if (proposed.length > 0) ordered.proposed = Object.fromEntries(proposed) as NonNullable<ChecksFile["proposed"]>;
  writeFileAtomic(join(top, CHECKS_PATH), `${JSON.stringify(ordered, null, 2)}\n`);
}

export function sameCommand(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return left !== undefined && right !== undefined && left.length === right.length && left.every((part, index) => part === right[index]);
}
