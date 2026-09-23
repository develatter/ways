import { failedCheckDetails, runChecks, type CheckResult } from "../check/check.js";
import { committedContract, effectiveContract, sameContract } from "../check/contract.js";
import { loadConfig } from "../config/config.js";
import type { CheckContract, OutcomeEvaluation } from "../domain/types.js";
import { sha256, stableJson } from "../fs/files.js";
import type { GitRepository } from "../git/git.js";
import { canonicalChecks } from "./validation-failure.js";

/**
 * Evaluation of an outcome increment against the environment check contract.
 * Evaluate, close, the commit hook and the history audit share these rules:
 * the contract is the evaluated input tree's configuration, every required
 * check must have passed under exactly that contract, and the certified
 * criterion evidence is bound by digest.
 */

export function evidenceDigest(evidence: unknown): string {
  return sha256(stableJson(evidence));
}

/** Runs the contract through the same runner SDD validation and failure replay use. */
export async function runContract(cwd: string): Promise<{ contract: CheckContract; result: CheckResult; checks: OutcomeEvaluation["checks"]; failures: string[] }> {
  const contract = effectiveContract(await loadConfig(cwd));
  const result = await runChecks(cwd, false, contract.commands, { services: true });
  const failures = [
    ...result.issues.map((issue) => `${issue.code}: ${issue.path}: ${issue.message}`),
    ...failedCheckDetails(result),
    ...(!result.checks && result.testExitCode !== 0 ? [`test: exit code ${result.testExitCode}`] : []),
  ];
  return { contract, result, checks: canonicalChecks(result), failures };
}

/** One line per named result (or the legacy test command), for CLI output. */
export function formatCheckResults(checks: OutcomeEvaluation["checks"]): string[] {
  const environment = (checks.environment ?? []).map((entry) => `  ${entry.kind === "setup" ? "setup" : `service ${entry.name}`}: ${entry.status}`);
  const named = checks.named
    ? checks.named.map((check) => `  ${check.name}: ${check.status}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}${check.command ? ` [${check.command.join(" ")}]` : ""}`)
    : checks.testExitCode === undefined ? [] : [`  test: ${checks.testExitCode === 0 ? "passed" : "failed"} (exit ${checks.testExitCode})`];
  return [...environment, ...named];
}

/** Every required check of the contract passed, with the contract's own command, and nothing else failed. */
export function contractResultsFailure(contract: CheckContract, checks: OutcomeEvaluation["checks"]): string | undefined {
  if (checks.integrity.length > 0) return `evaluation recorded integrity issues: ${checks.integrity.map((issue) => issue.code).join(", ")}`;
  const environment = (checks.environment ?? []).find((entry) => entry.status !== "passed");
  if (environment) return `evaluation environment ${environment.name} did not pass (${environment.status})`;
  if (!contract.commands) {
    if (checks.named !== undefined || checks.testExitCode !== 0) return "evaluation does not record a passing test command";
    return undefined;
  }
  for (const name of contract.commands.required) {
    const result = checks.named?.find((check) => check.name === name);
    if (!result) return `required check ${name} is missing from the evaluation`;
    if (result.status !== "passed") return `required check ${name} did not pass (${result.status})`;
    if (stableJson(result.command) !== stableJson(contract.commands[name])) return `required check ${name} did not run the contract's command`;
  }
  return undefined;
}

/**
 * The evaluation still certifies its input: the recorded contract is the
 * input tree's configuration, its results satisfy that contract, and the
 * criterion evidence is the one evaluated. Changing any of them needs a new evaluation.
 */
export async function evaluationBindingFailure(git: GitRepository, evaluation: OutcomeEvaluation, evidence: unknown): Promise<string | undefined> {
  if (typeof evaluation.contract !== "object" || evaluation.contract === null || !Array.isArray(evaluation.contract.testCommand)) {
    return "evaluation does not record its check contract";
  }
  const configured = await committedContract(git, evaluation.inputCommit);
  if (!configured) return "evaluated input configuration is unreadable";
  if (!sameContract(configured, evaluation.contract)) return "check commands changed after evaluation; run a new evaluation";
  const results = contractResultsFailure(evaluation.contract, evaluation.checks);
  if (results) return results;
  if (evaluation.evidenceDigest !== evidenceDigest(evidence)) return "criterion evidence changed after evaluation; run a new evaluation";
  return undefined;
}

/** Close re-runs the evaluated contract; a configuration that drifted from it cannot be re-run in its place. */
export async function evaluatedChecksFailure(cwd: string, evaluation: OutcomeEvaluation): Promise<string | undefined> {
  if (!sameContract(effectiveContract(await loadConfig(cwd)), evaluation.contract)) return "check commands changed after evaluation; run a new evaluation";
  const { failures } = await runContract(cwd);
  return failures.length > 0 ? `checks fail on the evaluated input:\n${failures.join("\n")}` : undefined;
}
