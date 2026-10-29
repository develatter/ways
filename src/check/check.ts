import { loadConfig } from "../config/config.js";
import { CHECK_NAMES, type CheckName, type EnvironmentResult, type IntegrityIssue, type NamedCheckResult, type NamedChecksConfig } from "../domain/types.js";
import { checkIntegrity } from "../integrity/integrity.js";
import { startEnvironment, type Environment } from "./environment.js";
import { execute, type CapturedResult } from "./process.js";

export { treeKillArgs } from "./process.js";

export interface CheckResult {
  issues: IntegrityIssue[];
  /** One result per named check; the plain `testCommand` reports as `test`. Empty with `integrityOnly`. */
  checks: NamedCheckResult[];
  /** Setup and service results, present only when they were started. */
  environment?: EnvironmentResult[];
  passed: boolean;
}

export interface RunChecksOptions {
  integrityOnly?: boolean;
  /** Run the configured setup and services around the checks. */
  services?: boolean;
  /** Record duration, output sha256 and tail instead of streaming the output. */
  capture?: boolean;
  /** Contract to run instead of the configured one. */
  contract?: NamedChecksConfig;
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
    if (command !== undefined && invalidArgv(command)) throw new Error(`Invalid ${name} command`);
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

function resultFor(name: CheckName, command: string[] | undefined, result: Omit<Partial<CapturedResult>, "status"> & { status: NamedCheckResult["status"] }): NamedCheckResult {
  return {
    name,
    status: result.status,
    ...(command ? { command: [...command] } : {}),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.detail ? { detail: result.detail } : {}),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result.outputSha256 === undefined ? {} : { outputSha256: result.outputSha256 }),
    ...(result.tail === undefined ? {} : { tail: result.tail }),
  };
}

async function runNamedChecks(cwd: string, issues: IntegrityIssue[], contract: NamedChecksConfig, options: RunChecksOptions): Promise<CheckResult> {
  validContract(contract);
  const timeoutMs = contract.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const environment: Environment | undefined = options.services && issues.length === 0 && (contract.setup || contract.services?.length)
    ? await startEnvironment(cwd, contract, timeoutMs)
    : undefined;
  try {
    const required = new Set(contract.required);
    const checks: NamedCheckResult[] = [];
    for (const name of CHECK_NAMES) {
      const command = contract[name];
      if (!required.has(name)) {
        checks.push(resultFor(name, command, { status: "skipped", detail: "Check is not required" }));
      } else if (!command) {
        checks.push(resultFor(name, undefined, { status: "unavailable", detail: "No command configured for required check" }));
      } else if (issues.length > 0) {
        checks.push(resultFor(name, command, { status: "skipped", detail: "Skipped because integrity checks failed" }));
      } else if (environment && !environment.healthy) {
        checks.push(resultFor(name, command, { status: "skipped", detail: "Skipped because the environment is not healthy" }));
      } else {
        checks.push(resultFor(name, command, await execute(command, cwd, timeoutMs, true, options.capture ? "capture" : "inherit")));
      }
    }
    if (environment) await environment.stop();
    const results = environment?.results.map((result) => ({ ...result }));
    const passed = issues.length === 0 && !checks.some((check) => unhealthy(check.status)) && !(results ?? []).some((result) => unhealthy(result.status));
    return { issues, checks, ...(results ? { environment: results } : {}), passed };
  } finally {
    await environment?.stop();
  }
}

/**
 * Integrity, then the configured checks. Setup and services start only with
 * `services: true` (`ways done`, `ways check --with-services`).
 */
export async function runChecks(cwd: string, options: RunChecksOptions = {}): Promise<CheckResult> {
  const issues = await checkIntegrity(cwd);
  if (options.integrityOnly) return { issues, checks: [], passed: issues.length === 0 };
  const config = await loadConfig(cwd);
  const named = options.contract ?? config.commands;
  if (named) return runNamedChecks(cwd, issues, named, options);
  if (issues.length > 0) return { issues, checks: [resultFor("test", config.testCommand, { status: "skipped", detail: "Skipped because integrity checks failed" })], passed: false };
  const result = await execute(config.testCommand, cwd, undefined, false, options.capture ? "capture" : "inherit");
  return { issues, checks: [resultFor("test", config.testCommand, result)], passed: result.status === "passed" };
}

export function failedCheckDetails(result: Pick<CheckResult, "checks" | "environment">): string[] {
  const environment = (result.environment ?? [])
    .filter((entry) => unhealthy(entry.status))
    .map((entry) => `${entry.kind === "setup" ? "setup" : `service ${entry.name}`}: ${entry.status}${entry.detail ? ` (${entry.detail})` : ""}${entry.log ? ` [log: ${entry.log}]` : ""}`);
  return [...environment, ...result.checks
    .filter((check) => unhealthy(check.status))
    .map((check) => `${check.name}: ${check.status}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}${check.detail ? ` (${check.detail})` : ""}`)];
}
