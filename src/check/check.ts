import { loadConfig } from "../config/config.js";
import { CHECK_NAMES, type CheckName, type EnvironmentResult, type NamedCheckResult, type NamedChecksConfig } from "../domain/types.js";
import { checkIntegrity, type IntegrityIssue } from "../integrity/integrity.js";
import { startEnvironment, type Environment } from "./environment.js";
import { execute } from "./process.js";

export { treeKillArgs } from "./process.js";

export interface CheckResult {
  issues: IntegrityIssue[];
  testExitCode?: number;
  checks?: NamedCheckResult[];
  /** Setup and service results, present only when an execution boundary started them. */
  environment?: EnvironmentResult[];
}

export interface RunChecksOptions {
  /** Execution boundary: run configured setup and services around the checks. */
  services?: boolean;
}

const unhealthy = (status: string): boolean => status === "failed" || status === "timed-out" || status === "unavailable";
const invalidArgv = (command: unknown): boolean => !Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === "");

const DEFAULT_TIMEOUT_MS = 120_000;

function validContract(contract: NamedChecksConfig): void {
  if (!Array.isArray(contract.required) || contract.required.length === 0) throw new Error("Named checks require at least one required check");
  const seen = new Set<string>();
  for (const name of contract.required) {
    if (!CHECK_NAMES.includes(name) || seen.has(name)) throw new Error(`Invalid required check: ${name}`);
    seen.add(name);
  }
  for (const name of CHECK_NAMES) {
    const command = contract[name];
    if (command !== undefined && (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === ""))) {
      throw new Error(`Invalid ${name} command`);
    }
  }
  if (contract.timeoutMs !== undefined && (!Number.isInteger(contract.timeoutMs) || contract.timeoutMs < 1 || contract.timeoutMs > 3_600_000)) {
    throw new Error("Named check timeoutMs must be between 1 and 3600000");
  }
  if (contract.setup !== undefined && invalidArgv(contract.setup)) throw new Error("Invalid setup command");
  const services = new Set<string>();
  for (const service of contract.services ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(service.name) || services.has(service.name)) throw new Error(`Invalid service name: ${service.name}`);
    services.add(service.name);
    if (invalidArgv(service.command)) throw new Error(`Invalid ${service.name} service command`);
    if (!service.ready || Object.keys(service.ready).length !== 1 || ("command" in service.ready && invalidArgv(service.ready.command))) {
      throw new Error(`Service ${service.name} requires exactly one readiness probe`);
    }
  }
}

function resultFor(name: CheckName, command: string[] | undefined, result: Pick<NamedCheckResult, "status" | "exitCode" | "detail">): NamedCheckResult {
  return {
    name,
    status: result.status,
    ...(command ? { command: [...command] } : {}),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

async function runNamedChecks(cwd: string, issues: IntegrityIssue[], contract: NamedChecksConfig, options: RunChecksOptions): Promise<CheckResult> {
  validContract(contract);
  const timeoutMs = contract.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const environment: Environment | undefined = options.services && issues.length === 0 && (contract.setup || contract.services?.length)
    ? await startEnvironment(cwd, contract, timeoutMs)
    : undefined;
  try {
    const checks = await runRequired(cwd, issues, contract, timeoutMs, environment);
    if (environment) await environment.stop();
    return summarize(issues, checks, environment?.results);
  } finally {
    await environment?.stop();
  }
}

async function runRequired(cwd: string, issues: IntegrityIssue[], contract: NamedChecksConfig, timeoutMs: number, environment?: Environment): Promise<NamedCheckResult[]> {
  const required = new Set(contract.required);
  const checks: NamedCheckResult[] = [];
  for (const name of CHECK_NAMES) {
    const command = contract[name];
    if (!required.has(name)) {
      checks.push(resultFor(name, command, { status: "skipped", detail: "Check is not required" }));
      continue;
    }
    if (!command) {
      checks.push(resultFor(name, undefined, { status: "unavailable", detail: "No command configured for required check" }));
      continue;
    }
    if (issues.length > 0) {
      checks.push(resultFor(name, command, { status: "skipped", detail: "Skipped because integrity checks failed" }));
      continue;
    }
    if (environment && !environment.healthy) {
      checks.push(resultFor(name, command, { status: "skipped", detail: "Skipped because the environment is not healthy" }));
      continue;
    }
    checks.push(resultFor(name, command, await execute(command, cwd, timeoutMs, true)));
  }
  return checks;
}

function summarize(issues: IntegrityIssue[], checks: NamedCheckResult[], environment?: EnvironmentResult[]): CheckResult {
  const test = checks.find((check) => check.name === "test");
  const failed = checks.some((check) => unhealthy(check.status)) || (environment ?? []).some((result) => unhealthy(result.status));
  return {
    issues,
    checks,
    ...(environment ? { environment: environment.map((result) => ({ ...result })) } : {}),
    testExitCode: failed ? (test?.exitCode && test.exitCode > 0 ? test.exitCode : 1) : (test?.exitCode ?? 0),
  };
}

/**
 * Plain calls never run setup or start services; only execution boundaries
 * (quick/plan finish, SDD validate and close, `ways check --with-services`)
 * pass `services: true`.
 */
export async function runChecks(cwd: string, integrityOnly = false, contract?: NamedChecksConfig, options: RunChecksOptions = {}): Promise<CheckResult> {
  const issues = await checkIntegrity(cwd);
  if (integrityOnly) return { issues };
  const config = await loadConfig(cwd);
  const named = contract ?? config.commands;
  if (named) return runNamedChecks(cwd, issues, named, options);
  if (issues.length > 0) return { issues };
  const result = await execute(config.testCommand, cwd);
  return { issues, testExitCode: result.exitCode ?? 1 };
}

export function failedCheckDetails(result: CheckResult): string[] {
  const environment = (result.environment ?? [])
    .filter((entry) => unhealthy(entry.status))
    .map((entry) => `${entry.kind === "setup" ? "setup" : `service ${entry.name}`}: ${entry.status}${entry.detail ? ` (${entry.detail})` : ""}${entry.log ? ` [log: ${entry.log}]` : ""}`);
  return [...environment, ...(result.checks ?? [])
    .filter((check) => unhealthy(check.status))
    .map((check) => `${check.name}: ${check.status}${check.detail ? ` (${check.detail})` : ""}`)];
}
