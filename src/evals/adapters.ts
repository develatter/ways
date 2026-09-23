import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { ADAPTER_METRICS, type AdapterExecution, type AdapterMetrics, type EvalAdapter, type EvalFile, type UsageMetrics } from "./types.js";

export const unavailableUsage: UsageMetrics = {
  available: false,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
  reason: "adapter did not provide usage metrics",
};
function normalizeUsage(value: unknown): UsageMetrics | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Partial<UsageMetrics>;
  if (typeof usage.available !== "boolean") return undefined;
  const fields = ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const;
  if (fields.some((field) => usage[field] !== undefined && usage[field] !== null && (typeof usage[field] !== "number" || !Number.isFinite(usage[field]) || usage[field] < 0))) return undefined;
  const normalized = { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, totalTokens: usage.totalTokens ?? null, costUsd: usage.costUsd ?? null };
  if (!usage.available) return { available: false, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reason: typeof usage.reason === "string" && usage.reason.trim() ? usage.reason : "adapter reported usage unavailable" };
  if (![normalized.inputTokens, normalized.outputTokens, normalized.totalTokens, normalized.costUsd].some((field) => field !== null)) return undefined;
  return { available: true, ...normalized };
}
function normalizeMetrics(value: unknown): AdapterMetrics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const metrics: AdapterMetrics = {};
  for (const [name, metric] of Object.entries(value)) {
    if (!(ADAPTER_METRICS as readonly string[]).includes(name)) return undefined;
    if (metric !== null && (!Number.isSafeInteger(metric) || (metric as number) < 0)) return undefined;
    metrics[name as keyof AdapterMetrics] = metric as number | null;
  }
  return metrics;
}
async function waitForGroupExit(pid: number | undefined): Promise<boolean> {
  const deadline = Date.now() + 500;
  while (pid !== undefined && Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return pid === undefined;
}
async function terminateAndConfirm(child: ChildProcess): Promise<void> {
  killTree(child, "SIGTERM");
  if (!(await waitForGroupExit(child.pid))) {
    killTree(child, "SIGKILL");
    await waitForGroupExit(child.pid);
  }
}

function repositoryPath(repo: string, path: string): string {
  const target = resolve(repo, path);
  const relativePath = relative(repo, target);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.includes("/../")) throw new Error(`Eval patch path escapes repository: ${path}`);
  return target;
}

async function applyPatches(repo: string, patches: readonly EvalFile[]): Promise<void> {
  for (const patch of patches) {
    const target = repositoryPath(repo, patch.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, patch.content, "utf8");
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

export const fakeAdapter: EvalAdapter = {
  id: "fake",
  argv: ["fake"],
  synthetic: true,
  async run(input): Promise<AdapterExecution> {
    const patches = input.session === "resume" ? input.task.freshSessionResume?.fakePatch ?? [] : input.task.fakePatch ?? [];
    await applyPatches(input.repo, patches);
    const doneClaim = input.session === "resume" || input.task.freshSessionResume === undefined;
    return { doneClaim, exitCode: 0, stdout: `fake:${input.task.id}:${input.session}\n`, stderr: "", overflow: false, usage: unavailableUsage };
  },
};

export function commandAdapter(command: string, args: readonly string[] = []): EvalAdapter {
  return {
    id: "command",
    argv: [command, ...args],
    run: (input) => new Promise<AdapterExecution>((resolveExecution, reject) => {
      const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
      const child = spawn(command, [...args], {
        cwd: input.repo,
        detached: true,
        env: {
          ...cleanEnvironment,
          WAYS_EVAL_TASK_ID: input.task.id,
          WAYS_EVAL_REPOSITORY: input.repo,
          WAYS_EVAL_SESSION: input.session,
          WAYS_EVAL_HARNESS: input.harness,
          WAYS_EVAL_MODEL: input.model,
          WAYS_EVAL_STARTING_REVISION: input.startingRevision,
          WAYS_EVAL_PROMPT: input.prompt,
          WAYS_EVAL_SEED: String(input.seed),
          ...(input.waysBin ? { WAYS_EVAL_WAYS_BIN: input.waysBin } : {}),
          ...(input.outcomePolicy ? { WAYS_EVAL_OUTCOME_POLICY: JSON.stringify(input.outcomePolicy) } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let totalBytes = 0;
      let overflow = false;
      const capture = (target: "stdout" | "stderr") => (chunk: Buffer): void => {
        const remaining = Math.max(0, input.maxOutputBytes - totalBytes);
        totalBytes += chunk.byteLength;
        if (chunk.byteLength > remaining) {
          overflow = true;
          killTree(child, "SIGTERM");
          setTimeout(() => killTree(child, "SIGKILL"), 100);
        }
        const limited = chunk.subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += limited;
        else stderr += limited;
      };
      child.stdout.on("data", capture("stdout"));
      child.stderr.on("data", capture("stderr"));
      const abort = (): void => {
        killTree(child, "SIGTERM");
        setTimeout(() => killTree(child, "SIGKILL"), 100);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("close", async (exitCode) => {
        input.signal.removeEventListener("abort", abort);
        await terminateAndConfirm(child);
        let doneClaim = false;
        let usage: UsageMetrics | undefined;
        let metrics: AdapterMetrics | undefined;
        let error: string | undefined;
        try {
          const line = stdout.trim().split("\n").at(-1);
          if (!line) throw new Error("adapter did not emit a JSON result");
          const parsed = JSON.parse(line) as { doneClaim?: unknown; usage?: unknown; metrics?: unknown };
          if (typeof parsed.doneClaim !== "boolean") throw new Error("adapter JSON doneClaim must be boolean");
          doneClaim = parsed.doneClaim;
          if (parsed.usage !== undefined) {
            const normalized = normalizeUsage(parsed.usage);
            if (!normalized) throw new Error("adapter JSON usage is invalid");
            usage = normalized;
          }
          if (parsed.metrics !== undefined) {
            metrics = normalizeMetrics(parsed.metrics);
            if (!metrics) throw new Error("adapter JSON metrics are invalid");
          }
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        resolveExecution({ doneClaim, exitCode: overflow ? null : exitCode, stdout, stderr, overflow, ...(error ? { error } : {}), ...(usage ? { usage } : {}), ...(metrics ? { metrics } : {}) });
      });
    }),
  };
}
