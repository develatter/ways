import type { IntegrityIssue } from "../domain/types.js";
import type { CheckResult } from "./check.js";

/**
 * `ways check` in a few lines: one per area of integrity (the files ways
 * installed, the configuration, the memory, the agent adapters) and one per
 * check, with detail only for what fails. The check lines are `ways run`'s
 * summaries; the whole output of each is in its log.
 */
const AREAS: Array<{ id: string; label: string; ok: string; match: (issue: IntegrityIssue) => boolean }> = [
  { id: "harness", label: "harness files", ok: "hooks, scripts and agent files are as ways installed them", match: (issue) => /^(managed-file|adapter-file)-/.test(issue.code) },
  { id: "config", label: "config", ok: "the configuration and the manifest are valid", match: (issue) => /config|manifest/.test(issue.code) },
  { id: "agents", label: "agents", ok: "CLAUDE.md imports AGENTS.md and the agent hooks are installed", match: (issue) => /claude-md|^adapter-/.test(issue.code) },
  { id: "memory", label: "memory", ok: "the memory under .ways/knowledge is well formed", match: () => true },
];

export function renderCheckReport(result: CheckResult): string {
  const lines: string[] = [];
  const left = [...result.issues];
  for (const area of AREAS) {
    const mine = left.filter(area.match);
    for (const issue of mine) left.splice(left.indexOf(issue), 1);
    if (mine.length === 0) {
      lines.push(`✓ ${area.label}: ${area.ok}`);
      continue;
    }
    lines.push(`✗ ${area.label}: ${mine.length} problem(s)`);
    for (const issue of mine.slice(0, 8)) lines.push(`    ${issue.path}: ${issue.message}`);
    if (mine.length > 8) lines.push(`    … ${mine.length - 8} more`);
  }
  for (const entry of result.environment ?? []) {
    if (entry.status === "passed") continue;
    lines.push(`✗ ${entry.kind === "setup" ? "setup" : `service ${entry.name}`}: ${entry.status}${entry.detail ? ` — ${entry.detail}` : ""}${entry.log ? ` [log: ${entry.log}]` : ""}`);
  }
  for (const check of result.checks) {
    if (check.status === "skipped") {
      if (check.detail !== "Check is not required") lines.push(`- ${check.name}: skipped (${check.detail ?? "not run"})`);
      continue;
    }
    if (check.summary) {
      lines.push(...check.summary.split("\n"));
      if (check.status !== "passed" && check.run) lines.push(`    full log: ways run --show ${check.run}${check.log ? `  (${check.log})` : ""}`);
      continue;
    }
    lines.push(`${check.status === "passed" ? "✓" : "✗"} ${check.name}: ${check.status}${check.exitCode === undefined || check.status === "passed" ? "" : ` (exit ${check.exitCode})`}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  lines.push(result.passed ? "Checks passed." : "Checks failed: fix what is marked ✗ above.");
  return lines.join("\n");
}
