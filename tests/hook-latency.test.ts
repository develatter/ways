import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { done, openOutcome } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

/*
 * `ways hook` runs once per agent event, so it must stay close to Node's own
 * start-up cost. The suite runs files in parallel, which inflates wall times,
 * so the default bound only catches regressions such as loading ajv or yaml;
 * WAYS_LATENCY_STRICT=1 asserts the 100 ms p95 target (run it alone).
 */
const RUNS = 200;
const CLI = process.env.WAYS_CLI!;

function percentile(samples: number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

async function busyOutcome(): Promise<string> {
  const { cwd, git } = await installed({ agents: ["claude"] });
  await openOutcome(cwd, "latency", { goal: "Measure", criteria: ["AC1:works"], verify: ["AC1:true"], strength: [], review: "required" });
  await commitFile(git, cwd, "a.txt", "a\n", "feat: a");
  await done(cwd);
  return cwd;
}

describe("agent hook latency", () => {
  it(`PreToolUse answers within budget over ${RUNS} runs`, async () => {
    const cwd = await busyOutcome();
    const payload = JSON.stringify({ session_id: "latency", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test 2>&1 | tail -5" } });
    const samples: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const started = performance.now();
      const result = spawnSync(process.execPath, [CLI, "hook", "PreToolUse", "--agent=claude"], { cwd, input: payload, encoding: "utf8" });
      samples.push(performance.now() - started);
      expect(result.status).toBe(0);
    }
    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.log(`ways hook PreToolUse: n=${RUNS} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(process.env.WAYS_LATENCY_STRICT === "1" ? 100 : 400);
  }, 240_000);

  it("loads neither ajv, yaml, node:crypto nor node:child_process on a warm hook", async () => {
    const cwd = await busyOutcome();
    const prompt = JSON.stringify({ session_id: "modules", cwd, prompt: "go on" });
    // First run builds the memory and git caches; the second is the common case.
    spawnSync(process.execPath, [CLI, "hook", "UserPromptSubmit"], { cwd, input: prompt });
    const script = `
      import * as nodeModule from "node:module";
      const registerHooks = nodeModule.registerHooks;
      const loaded = [];
      // Node < 22.15 has no registerHooks: only the built-in check runs there.
      registerHooks?.({ load(url, context, next) { loaded.push(url); return next(url, context); } });
      const { run } = await import(${JSON.stringify(pathToFileURL(CLI).href)});
      for (const event of ["PreToolUse", "UserPromptSubmit", "Stop"]) await run(["hook", event], ${JSON.stringify(cwd)});
      process.stderr.write(JSON.stringify({ hooks: typeof registerHooks === "function", loaded, builtins: process.moduleLoadList.filter((name) => /crypto|child_process/.test(name)) }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, input: prompt, encoding: "utf8" });
    const report = JSON.parse(result.stderr) as { hooks: boolean; loaded: string[]; builtins: string[] };
    expect(report.builtins).toEqual([]);
    if (report.hooks) {
      expect(report.loaded.filter((url) => /node_modules\/(ajv|yaml)\//.test(url))).toEqual([]);
      expect(report.loaded.some((url) => url.endsWith(join("hooks", "agent.js")))).toBe(true);
    }
  }, 60_000);
});
