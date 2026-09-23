import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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
export function execute(command: string[], cwd: string, timeoutMs?: number, strict = false, stdio: "inherit" | "ignore" = "inherit"): Promise<ExecutionResult> {
  const [program, ...args] = command;
  if (!program || (strict && command.some((part) => part.trim() === "" || part.includes("\0")))) {
    return Promise.resolve({ status: "unavailable", detail: "Configured command must contain non-empty arguments without NUL bytes" });
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd,
        stdio,
        shell: false,
        detached: process.platform !== "win32",
      });
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
      resolve(result);
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
