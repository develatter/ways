import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandAdapter, fakeAdapter } from "../src/evals/adapters.js";
import { loadCorpus } from "../src/evals/corpus.js";
import { runEvals } from "../src/evals/runner.js";
import { run } from "../src/cli.js";
import type { EvalAdapter, EvalConfiguration, EvalTask } from "../src/evals/types.js";

const configuration: EvalConfiguration = { adapter: { id: "fake", argv: ["fake"] }, harness: "checks-only", model: "test-model", startingRevision: "corpus-v3", budgets: { maxMilliseconds: 1000, maxOutputBytes: 1024 }, seed: 11 };

describe("reproducible eval runner", () => {
  it("runs functional corpus and fresh resume with unavailable usage", async () => {
    const result = await runEvals({ corpus: await loadCorpus(), configuration, adapter: fakeAdapter, now: () => new Date("2026-01-01T00:00:00Z") });
    expect(result.summary).toMatchObject({ taskCount: 6, successCount: 6, regressionCount: 0, incorrectDoneClaimCount: 0 });
    expect(result.tasks.find((task) => task.taskId === "resume-session")?.sessions).toHaveLength(2);
    expect(result.tasks[0]?.usage).toMatchObject({ available: false, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
    expect(result.tasks[0]?.startingRevision).toMatch(/^[a-f0-9]{40}$/);
  });

  it("grades functional behavior independently and cleans disposable repositories", async () => {
    let repository: string | undefined;
    const lyingAdapter: EvalAdapter = { id: "lying", argv: ["lying"], async run(input) { repository = input.repo; return { doneClaim: true, exitCode: 0, stdout: "", stderr: "", overflow: false }; } };
    const corpus = { schemaVersion: 1 as const, id: "one", revision: "fixture", tasks: [{ id: "truth", description: "truth", setup: [{ path: "src/value.js", content: "export const value = 1;\n" }], prompt: "change", success: [{ id: "behavior", command: ["node", "--input-type=module", "-e", "const m=await import('./src/value.js'); if(m.value!==2) process.exit(1)"], expectedExitCode: 0 }], regressions: [{ id: "loads", command: ["node", "--input-type=module", "-e", "await import('./src/value.js')"], expectedExitCode: 0 }] }] };
    const result = await runEvals({ corpus, configuration: { ...configuration, adapter: { id: "lying", argv: ["lying"] }, startingRevision: "fixture" }, adapter: lyingAdapter });
    expect(result.tasks[0]).toMatchObject({ success: false, incorrectDoneClaim: true });
    await expect(access(repository as string)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("normalizes unavailable adapter usage to null metrics", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ways-eval-adapter-"));
    try {
      const adapter = commandAdapter(process.execPath, ["-e", "process.stdout.write(JSON.stringify({doneClaim:true,usage:{available:false,inputTokens:100,outputTokens:2,totalTokens:102,costUsd:1,reason:'not measured'}})+'\\n')"]);
      const task: EvalTask = { id: "usage", description: "usage", setup: [], prompt: "run", success: [], regressions: [] };
      const result = await adapter.run({ task, repo, prompt: task.prompt, session: "initial", harness: "checks-only", model: "test", startingRevision: "fixture", seed: 0, maxOutputBytes: 1024, signal: new AbortController().signal });
      expect(result.usage).toEqual({ available: false, inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, reason: "not measured" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("parses observable adapter metrics and rejects invalid values", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ways-eval-metrics-"));
    const execute = (metrics: string) => commandAdapter(process.execPath, ["-e", `process.stdout.write(JSON.stringify({doneClaim:true,metrics:${metrics}})+'\\n')`]).run({ task: { id: "m", description: "m", setup: [], prompt: "run", success: [], regressions: [] }, repo, prompt: "run", session: "initial", harness: "full-sdd", model: "test", startingRevision: "fixture", seed: 0, maxOutputBytes: 1024, signal: new AbortController().signal });
    try {
      expect((await execute("{toolCalls:4,contextCompactions:null,humanInterventions:0}")).metrics).toEqual({ toolCalls: 4, contextCompactions: null, humanInterventions: 0 });
      expect((await execute("{toolCalls:-1}")).error).toBe("adapter JSON metrics are invalid");
      expect((await execute("{tokens:3}")).error).toBe("adapter JSON metrics are invalid");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("emits machine-readable CLI output and rejects labels outside A–E", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-eval-cli-"));
    expect(await run(["evals", "run", "--adapter=fake", "--output=result.json"], cwd)).toBe(0);
    expect(JSON.parse(await readFile(join(cwd, "result.json"), "utf8"))).toMatchObject({ schemaVersion: 3, evidence: { kind: "fixture", architecturalBenchmark: false } });
    await expect(run(["evals", "run", "--harness=unknown"], cwd)).rejects.toThrow("no-ways, checks-only, lightweight-state, full-sdd, outcome");
  });
});
