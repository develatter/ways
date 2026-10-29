import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { RunOutput } from "../domain/types.js";

export interface ExecutionResult {
  status: "passed" | "failed" | "timed-out" | "unavailable";
  exitCode?: number;
  detail?: string;
}

export function treeKillArgs(pid: number | undefined, signal: NodeJS.Signals, platform = process.platform): string[] | undefined {
  if (pid === undefined || platform !== "win32") return undefined;
  return ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const args = treeKillArgs(child.pid, signal);
  if (args) {
    try {
      const taskkill = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
      if (!taskkill.error && taskkill.status === 0) return;
    } catch {
      // Fall through to direct child termination.
    }
    try { child.kill(signal); } catch { /* Already exited. */ }
    return;
  }
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* Already exited. */ }
  }
}
export interface ProcessOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs an argv without a shell, writes `input` to its stdin and collects its
 * output (bounded, whole). It is killed, with its process group, after
 * `timeoutMs`. `unavailable` turns a failure to start into the caller's error.
 */
export function runWithInput(command: readonly string[], cwd: string, input: string, options: { timeoutMs: number; env?: NodeJS.ProcessEnv; maxBytes?: number; unavailable: (error: Error, program: string) => Error }): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = command;
    const child = spawn(program!, args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32", ...(options.env ? { env: options.env } : {}) });
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const timer = setTimeout(() => killTree(child, "SIGKILL"), options.timeoutMs);
    const take = (target: "out" | "err") => (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) return;
      if (target === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(options.unavailable(error, program!));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

const TAIL_LINES = 20;
const TAIL_BYTES = 16 * 1024;

/** Collects combined output: its sha256 and a bounded tail, never the whole stream in memory. */
class OutputCapture {
  private readonly hash = createHash("sha256");
  private tail = Buffer.alloc(0);

  add(chunk: Buffer): void {
    this.hash.update(chunk);
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > TAIL_BYTES) this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);
  }

  result(): RunOutput & { outputSha256: string; tail: string } {
    const lines = this.tail.toString("utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    return { outputSha256: this.hash.digest("hex"), tail: lines.slice(-TAIL_LINES).join("\n") };
  }
}

export type CapturedResult = ExecutionResult & RunOutput;

export type RetriedResult = CapturedResult & { attempts: number; /** The first failing attempt, when a retry passed. */ flakyFailure?: CapturedResult };

/**
 * Runs a captured command, and again up to `retries` times while it fails or
 * times out. A pass after a failure is flaky: the result says so and keeps the
 * first failure. A command that cannot start is not retried.
 */
export async function executeWithRetries(command: string[], cwd: string, timeoutMs: number | undefined, strict: boolean, retries: number): Promise<RetriedResult> {
  let first: CapturedResult | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const result = await execute(command, cwd, timeoutMs, strict, "capture");
    const failed = result.status === "failed" || result.status === "timed-out";
    if (!failed || attempt > retries) {
      return { ...result, attempts: attempt, ...(first && result.status === "passed" ? { flakyFailure: first } : {}) };
    }
    first ??= result;
  }
}

/**
 * Runs an argv without a shell. With `stdio: "capture"` the output is not
 * shown; the result carries its duration, sha256 and last lines instead.
 */
export function execute(command: string[], cwd: string, timeoutMs?: number, strict = false, stdio: "inherit" | "ignore" | "capture" = "inherit"): Promise<CapturedResult> {
  const [program, ...args] = command;
  if (!program || (strict && command.some((part) => part.trim() === "" || part.includes("\0")))) {
    return Promise.resolve({ status: "unavailable", detail: "Configured command must contain non-empty arguments without NUL bytes" });
  }
  const started = Date.now();
  const capture = stdio === "capture" ? new OutputCapture() : undefined;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd,
        stdio: capture ? ["ignore", "pipe", "pipe"] : stdio as "inherit" | "ignore",
        shell: false,
        detached: process.platform !== "win32",
      });
      child.stdout?.on("data", (chunk: Buffer) => capture?.add(chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture?.add(chunk));
    } catch (error) {
      resolve({ status: "unavailable", detail: `Unable to spawn command: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const onSignal = (signal: NodeJS.Signals): void => {
      // Abort this harness immediately: TERM then KILL the entire detached group
      // before restoring the process's conventional signal termination.
      killTree(child, signal);
      killTree(child, "SIGKILL");
      cleanup();
      process.kill(process.pid, signal);
    };
    const onExit = (): void => killTree(child, "SIGTERM");
    const onSigint = (): void => onSignal("SIGINT");
    const onSigterm = (): void => onSignal("SIGTERM");
    const cleanup = (): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("exit", onExit);
    };
    const finish = (result: ExecutionResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(capture ? { ...result, durationMs: Date.now() - started, ...capture.result() } : result);
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("exit", onExit);
    child.once("error", (error) => {
      finish({ status: "unavailable", detail: `Unable to spawn command: ${error.message}` });
    });
    child.once("close", (code, signal) => {
      // Keep listeners and the escalation timer alive until SIGKILL has had time
      // to reach descendants of a detached process group.
      if (timedOut) return;
      if (code === 0) {
        finish({ status: "passed", exitCode: 0 });
      } else {
        finish({
          status: "failed",
          exitCode: code ?? 1,
          ...(signal ? { detail: `Command terminated by ${signal}` } : {}),
        });
      }
    });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          killTree(child, "SIGKILL");
          setTimeout(() => finish({ status: "timed-out", detail: `Command exceeded timeout of ${timeoutMs}ms` }), 250);
        }, 250);
      }, timeoutMs);
    }
  });
}
