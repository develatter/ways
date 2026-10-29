import { runChecks } from "../check/check.js";
import { effectiveContract } from "../check/contract.js";
import { execute } from "../check/process.js";
import { loadConfig, verifierPaths } from "../config/config.js";
import { WORK_DIR } from "../domain/constants.js";
import type { Criterion, CriterionEvidence, Evidence } from "../domain/types.js";
import type { GitRepository } from "../git/git.js";
import { matchesAny } from "../memory/glob.js";

const DEFAULT_VERIFIER_TIMEOUT_MS = 120_000;

/**
 * Existing verifier-surface files (tests, check configuration, CI) that the
 * increment modified or deleted. Added files are free: adding tests never
 * needs approval.
 */
export async function verifierChanges(git: GitRepository, base: string, input: string, globs: readonly string[]): Promise<string[]> {
  const output = await git.run(["diff", "--name-status", "--no-renames", "-z", base, input, "--"]);
  const fields = output.split("\0").filter(Boolean);
  const changed: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const path = fields[index + 1]!;
    if ((status.startsWith("M") || status.startsWith("D") || status.startsWith("T")) && !path.startsWith(`${WORK_DIR}/`) && matchesAny(path, globs)) changed.push(path);
  }
  return changed.sort();
}

export interface EvaluationInput {
  cwd: string;
  git: GitRepository;
  base: string;
  criteria: readonly Criterion[];
}

/**
 * Runs, once, everything `done` relies on against the committed HEAD of a
 * clean working tree: integrity, the configured checks (with setup and
 * services) and every criterion's verifier. The result is the evidence; the
 * agent never writes it.
 */
export async function evaluate({ cwd, git, base, criteria }: EvaluationInput): Promise<Evidence> {
  const config = await loadConfig(cwd);
  const input = await git.head();
  const tree = await git.treeId(input);
  const result = await runChecks(cwd, { services: true, capture: true });
  const timeoutMs = config.commands?.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const evidence: Record<string, CriterionEvidence> = {};
  for (const criterion of criteria) {
    if (!criterion.verify) {
      evidence[criterion.id] = { strength: criterion.strength, status: "review-only" };
      continue;
    }
    if (result.issues.length > 0) {
      evidence[criterion.id] = { strength: criterion.strength, status: "failed", command: [...criterion.verify], detail: "Skipped because integrity checks failed" };
      continue;
    }
    const run = await execute(criterion.verify, cwd, timeoutMs, true, "capture");
    evidence[criterion.id] = {
      strength: criterion.strength,
      status: run.status === "passed" ? "passed" : "failed",
      command: [...criterion.verify],
      ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
      ...(run.detail ? { detail: run.detail } : {}),
      ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
      ...(run.outputSha256 ? { outputSha256: run.outputSha256 } : {}),
      ...(run.tail !== undefined ? { tail: run.tail } : {}),
    };
  }
  const changes = await verifierChanges(git, base, input, verifierPaths(config));
  const passed = result.passed && Object.values(evidence).every((entry) => entry.status !== "failed");
  return {
    base,
    input: { commit: input, tree },
    contract: effectiveContract(config),
    integrity: result.issues,
    checks: result.checks,
    ...(result.environment ? { environment: result.environment } : {}),
    criteria: evidence,
    verifierChanges: changes,
    passed,
    ranAt: new Date().toISOString(),
    earlierRuns: [],
  };
}

/** One line per failure, with the tail of its output, for the agent to act on. */
export function evidenceFailures(evidence: Evidence): string[] {
  const lines: string[] = [];
  for (const issue of evidence.integrity) lines.push(`integrity ${issue.code}: ${issue.path}: ${issue.message}`);
  for (const entry of evidence.environment ?? []) {
    if (entry.status !== "passed") lines.push(`${entry.kind === "setup" ? "setup" : `service ${entry.name}`}: ${entry.status}${entry.detail ? ` — ${entry.detail}` : ""}${entry.log ? ` [log: ${entry.log}]` : ""}`);
  }
  for (const check of evidence.checks) {
    if (check.status === "passed" || check.status === "skipped") continue;
    lines.push(`check ${check.name}: ${check.status}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}${check.detail ? ` — ${check.detail}` : ""}`);
    if (check.tail) lines.push(...indent(check.tail));
  }
  for (const [id, entry] of Object.entries(evidence.criteria)) {
    if (entry.status !== "failed") continue;
    lines.push(`criterion ${id} (${entry.strength}): failed${entry.exitCode === undefined ? "" : ` (exit ${entry.exitCode})`}${entry.detail ? ` — ${entry.detail}` : ""}`);
    if (entry.tail) lines.push(...indent(entry.tail));
  }
  return lines;
}

function indent(text: string): string[] {
  return text.split("\n").slice(-10).map((line) => `    ${line}`);
}
