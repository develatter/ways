import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { EnvironmentResult, NamedChecksConfig, ServiceConfig, ServiceReadiness } from "../domain/types.js";
import { execute, killTree } from "./process.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_000;
const POLL_MS = 100;
const STOP_GRACE_MS = 2_000;

interface RunningService {
  config: ServiceConfig;
  child: ChildProcess;
  result: EnvironmentResult;
  exited: Promise<void>;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}

export interface Environment {
  results: EnvironmentResult[];
  healthy: boolean;
  /** Stops every owned service group and records services that died while checks ran. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tcpReady(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ready: boolean): void => { socket.destroy(); resolve(ready); };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function httpReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.status < 400;
  } catch {
    return false;
  }
}

async function probe(ready: ServiceReadiness, cwd: string, remainingMs: number): Promise<boolean> {
  if ("command" in ready) return (await execute(ready.command, cwd, Math.max(1, Math.min(remainingMs, 5_000)), true, "ignore")).status === "passed";
  if ("tcp" in ready) return tcpReady(ready.tcp.port, ready.tcp.host ?? "127.0.0.1");
  return httpReady(ready.http);
}

function exitDetail(exit: NonNullable<RunningService["exit"]>, when: string): Pick<EnvironmentResult, "exitCode" | "detail"> {
  return {
    ...(exit.code === null ? {} : { exitCode: exit.code }),
    detail: `Service exited ${exit.signal ? `by ${exit.signal}` : `with code ${exit.code}`} ${when}`,
  };
}

function startService(config: ServiceConfig, cwd: string): RunningService {
  const log = join(".ways", "runtime", "services", `${config.name}.log`);
  const result: EnvironmentResult = { kind: "service", name: config.name, status: "passed", command: [...config.command], log };
  mkdirSync(join(cwd, ".ways", "runtime", "services"), { recursive: true });
  const fd = openSync(join(cwd, log), "w");
  const [program, ...args] = config.command;
  let child: ChildProcess;
  try {
    child = spawn(program!, args, { cwd, stdio: ["ignore", fd, fd], shell: false, detached: process.platform !== "win32" });
  } finally {
    closeSync(fd);
  }
  const service: RunningService = {
    config,
    child,
    result,
    exited: new Promise((resolve) => {
      child.once("error", (error) => {
        service.exit ??= { code: null, signal: null };
        Object.assign(result, { status: "unavailable", detail: `Unable to spawn service: ${error.message}` });
        resolve();
      });
      child.once("exit", (code, signal) => { service.exit ??= { code, signal }; resolve(); });
    }),
  };
  return service;
}

async function waitReady(service: RunningService, cwd: string): Promise<void> {
  const timeoutMs = service.config.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (service.exit) {
      if (service.result.status === "passed") Object.assign(service.result, { status: "failed", ...exitDetail(service.exit, "before becoming ready") });
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (await probe(service.config.ready, cwd, remaining)) {
      if (!service.exit) return;
      continue;
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  Object.assign(service.result, { status: "timed-out", detail: `Service did not become ready within ${timeoutMs}ms` });
}

async function stopService(service: RunningService): Promise<void> {
  if (service.result.status === "passed" && service.exit) {
    Object.assign(service.result, { status: "failed", ...exitDetail(service.exit, "while checks ran") });
  }
  // Signal only the process group this harness created; the group outlives a
  // crashed leader, so descendants are still reaped.
  killTree(service.child, "SIGTERM");
  await Promise.race([service.exited, sleep(STOP_GRACE_MS)]);
  killTree(service.child, "SIGKILL");
  await Promise.race([service.exited, sleep(STOP_GRACE_MS)]);
}

/**
 * Run setup and start services for an execution boundary.  Services run in
 * their own process groups with logs under `.ways/runtime/services/`, and are
 * stopped on interruption as well as through `stop()`.
 */
export async function startEnvironment(cwd: string, contract: NamedChecksConfig, timeoutMs: number): Promise<Environment> {
  const results: EnvironmentResult[] = [];
  const running: RunningService[] = [];
  const killAll = (): void => { for (const service of running) killTree(service.child, "SIGKILL"); };
  const onSignal = (signal: NodeJS.Signals): void => {
    killAll();
    detach();
    process.kill(process.pid, signal);
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  const detach = (): void => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("exit", killAll);
  };
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const service of running) await stopService(service);
    detach();
  };

  if (contract.setup) {
    const setup = await execute(contract.setup, cwd, timeoutMs, true);
    results.push({
      kind: "setup",
      name: "setup",
      status: setup.status === "passed" ? "passed" : setup.status,
      command: [...contract.setup],
      ...(setup.exitCode === undefined ? {} : { exitCode: setup.exitCode }),
      ...(setup.detail ? { detail: setup.detail } : {}),
    });
    if (setup.status !== "passed") return { results, healthy: false, stop };
  }

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("exit", killAll);
  for (const config of contract.services ?? []) {
    const service = startService(config, cwd);
    running.push(service);
    results.push(service.result);
    await waitReady(service, cwd);
    if (service.result.status !== "passed") break;
  }
  return { results, healthy: results.every((result) => result.status === "passed"), stop };
}
