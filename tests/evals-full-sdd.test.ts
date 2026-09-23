import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { fakeAdapter } from "../src/evals/adapters.js";
import { compareResults, renderComparisonMarkdown } from "../src/evals/compare.js";
import { loadCorpus } from "../src/evals/corpus.js";
import { runEvals } from "../src/evals/runner.js";
import type { AdapterInput, EvalAdapter, EvalConfiguration, EvalCorpus, EvalRunResult } from "../src/evals/types.js";
import { GitRepository } from "../src/git/git.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { advanceSdd, startSdd } from "../src/work/sdd.js";
import { sha256, stableJson } from "../src/fs/files.js";

const base: EvalConfiguration = { adapter: { id: "fake", argv: ["fake"] }, harness: "no-ways", model: "test-model", startingRevision: "corpus-v2", budgets: { maxMilliseconds: 20_000, maxOutputBytes: 4096 }, seed: 3 };

async function singleTaskCorpus(): Promise<EvalCorpus> {
  const corpus = await loadCorpus();
  return { ...corpus, tasks: corpus.tasks.filter((task) => task.id === "add-export") };
}

async function applyPatch(input: AdapterInput): Promise<void> {
  for (const file of input.task.fakePatch ?? []) {
    await mkdir(dirname(join(input.repo, file.path)), { recursive: true });
    await writeFile(join(input.repo, file.path), file.content);
  }
}

async function fill(repo: string, work: string, phase: string): Promise<void> {
  const path = join(repo, `.ways/sdd/${work}/${phase}.md`);
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace("Goal:", `Goal: complete ${phase}`).replace("Evidence:", "Evidence: fixture"));
}

/** Drives the real Ways SDD lifecycle in the disposable repository, as a compliant agent would. */
function sddAdapter(seen: AdapterInput[] = []): EvalAdapter {
  return {
    id: "sdd-fixture",
    argv: ["sdd-fixture"],
    synthetic: true,
    async run(input) {
      seen.push(input);
      const work = input.task.id;
      await startSdd(input.repo, work, "autonomous");
      for (const phase of ["intake", "explore", "assess", "specify", "plan", "decompose", "implement"]) {
        await fill(input.repo, work, phase);
        if (phase === "implement") await applyPatch(input);
        await advanceSdd(input.repo);
      }
      await fill(input.repo, work, "review");
      const reviewPath = join(input.repo, ".ways/runtime/review.json");
      await mkdir(dirname(reviewPath), { recursive: true });
      await writeFile(reviewPath, JSON.stringify({ schemaVersion: 1, workId: work, reviewer: "fixture/reviewer", digest: await reviewDigest(input.repo), verdict: "pass", findings: [] }));
      await submitReview(input.repo, reviewPath);
      await advanceSdd(input.repo);
      for (const phase of ["validate", "reconcile-memory", "close"]) {
        await fill(input.repo, work, phase);
        await advanceSdd(input.repo);
      }
      return { doneClaim: true, exitCode: 0, stdout: "", stderr: "", overflow: false, metrics: { toolCalls: 12, retries: 0 } };
    },
  };
}

describe("full SDD harness evals", () => {
  it("installs Ways, records its revision and grades a compliant SDD delivery from history", async () => {
    const seen: AdapterInput[] = [];
    const adapter = sddAdapter(seen);
    const result = await runEvals({ corpus: await singleTaskCorpus(), adapter, configuration: { ...base, harness: "full-sdd", adapter: { id: adapter.id, argv: adapter.argv } } });
    const task = result.tasks[0];
    expect(task).toMatchObject({ success: true, incorrectDoneClaim: false });
    expect(task?.compliance).toMatchObject({ applicable: true, compliant: true, fullSddCompleted: true, sddWorksStarted: 1, sddWorksClosed: 1, downgrades: 0, remediationAttempts: 0, activeWork: null, issues: [] });
    expect(task?.metrics.remediationAttempts).toEqual({ value: 0, source: "repository" });
    expect(task?.metrics.toolCalls).toEqual({ value: 12, source: "adapter" });
    expect(task?.metrics.contextCompactions).toMatchObject({ value: null, reason: "adapter did not report contextCompactions for the initial session" });
    expect(task?.metrics.resumeSuccess).toMatchObject({ value: null, reason: "task has no fresh-session resume" });
    expect(result.summary.compliantCount).toBe(1);
    expect(result.waysRevision).toMatchObject({ packageName: "@develatter/ways", harnessVersion: expect.any(String), contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.harnessPrompt?.initial).toContain("npx ways sdd start <task-id>");
    expect(seen[0]?.prompt).toContain("npx ways sdd start add-export");
    expect(seen[0]?.waysBin).toMatch(/node_modules\/\.bin\/ways$/);
    expect(result.evidence.kind).toBe("fixture");
  });

  it("separates functional success from harness compliance when SDD is bypassed", async () => {
    const uncommitted = await runEvals({ corpus: await singleTaskCorpus(), adapter: fakeAdapter, configuration: { ...base, harness: "full-sdd" } });
    expect(uncommitted.tasks[0]).toMatchObject({ success: true, compliance: { applicable: true, compliant: false, fullSddCompleted: false } });
    expect(uncommitted.tasks[0]?.compliance.applicable && uncommitted.tasks[0].compliance.issues.map((issue) => issue.code)).toContain("eval-uncommitted-changes");

    const bypass: EvalAdapter = {
      id: "bypass",
      argv: ["bypass"],
      synthetic: true,
      async run(input) {
        await applyPatch(input);
        const git = new GitRepository(input.repo);
        await git.run(["add", "."], undefined, true);
        await git.run(["commit", "-q", "--no-verify", "-m", "sneak"], undefined, true);
        return { doneClaim: true, exitCode: 0, stdout: "", stderr: "", overflow: false };
      },
    };
    const bypassed = await runEvals({ corpus: await singleTaskCorpus(), adapter: bypass, configuration: { ...base, harness: "full-sdd", adapter: { id: "bypass", argv: ["bypass"] } } });
    expect(bypassed.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false } });
    expect(bypassed.tasks[0]?.compliance.applicable && bypassed.tasks[0].compliance.issues.map((issue) => issue.code)).toContain("history-untraced");
  });

  it("does not install Ways or grade compliance for baseline harnesses", async () => {
    const seen: AdapterInput[] = [];
    const adapter: EvalAdapter = { id: "probe", argv: ["probe"], synthetic: true, async run(input) {
      seen.push(input);
      await expect(access(join(input.repo, ".ways"))).rejects.toMatchObject({ code: "ENOENT" });
      return fakeAdapter.run(input);
    } };
    const result = await runEvals({ corpus: await singleTaskCorpus(), adapter, configuration: { ...base, harness: "checks-only", adapter: { id: "probe", argv: ["probe"] } } });
    expect(result.tasks[0]?.compliance).toEqual({ applicable: false, reason: "harness checks-only does not run Ways SDD" });
    expect(result.tasks[0]?.metrics.remediationAttempts.value).toBeNull();
    expect(result.summary.compliantCount).toBeNull();
    expect(result.harnessPrompt).toBeNull();
    expect(seen[0]?.waysBin).toBeUndefined();
  });
});

describe("harness comparison report", () => {
  async function results(): Promise<Record<string, EvalRunResult>> {
    const corpus = await loadCorpus();
    const configuration = (harness: EvalConfiguration["harness"]): EvalConfiguration => ({ ...base, harness, budgets: { maxMilliseconds: 5000, maxOutputBytes: 4096 } });
    return {
      a: await runEvals({ corpus, adapter: fakeAdapter, configuration: configuration("no-ways") }),
      b: await runEvals({ corpus, adapter: fakeAdapter, configuration: configuration("checks-only") }),
      d: await runEvals({ corpus, adapter: fakeAdapter, configuration: configuration("full-sdd") }),
      seed: await runEvals({ corpus, adapter: fakeAdapter, configuration: { ...configuration("no-ways"), seed: 99 } }),
    };
  }

  it("scores only comparable runs, links raw artifacts and flags invalid inputs", async () => {
    const runs = await results();
    const content = (value: unknown): string => stableJson(value);
    const inputs = [
      { path: "a.json", content: content(runs.a) },
      { path: "b.json", content: content(runs.b) },
      { path: "d.json", content: content(runs.d) },
      { path: "seed.json", content: content(runs.seed) },
      { path: "legacy.json", content: content({ ...runs.a, schemaVersion: 1 }) },
      { path: "broken.json", content: "{" },
      { path: "real.json", content: content({ ...runs.b, runId: "real-run", evidence: { ...runs.b!.evidence, kind: "real" } }) },
    ];
    const report = compareResults(inputs);
    const status = Object.fromEntries(report.runs.map((entry) => [entry.artifact.path, entry]));
    // The first real run is the reference, so fixtures become non-comparable rather than silently mixed.
    expect(status["real.json"]?.status).toBe("comparable");
    expect(status["a.json"]).toMatchObject({ status: "non-comparable", reasons: ["mixes fixture and real evidence"] });
    expect(status["legacy.json"]).toMatchObject({ status: "invalid", reasons: [expect.stringContaining("schemaVersion 1")] });
    expect(status["broken.json"]).toMatchObject({ status: "invalid", reasons: ["result is not valid JSON"] });
    expect(status["a.json"]?.artifact.sha256).toBe(sha256(inputs[0]!.content));

    const fixtures = compareResults(inputs.filter((input) => input.path !== "real.json"));
    expect(fixtures).toMatchObject({ architecturalClaim: false, evidenceKind: "fixture" });
    expect(fixtures.runs.find((entry) => entry.artifact.path === "seed.json")).toMatchObject({ status: "non-comparable", reasons: ["seed differs from the reference run"] });
    expect(fixtures.harnesses.map((score) => score.harness)).toEqual(["no-ways", "checks-only", "full-sdd"]);
    const [a, , d] = fixtures.harnesses;
    expect(a).toMatchObject({ runs: 1, taskSuccess: { succeeded: 3, tasks: 3, rate: 1 }, harnessCompliance: { applicable: false } });
    expect(a?.artifacts).toEqual([{ path: "a.json", sha256: sha256(inputs[0]!.content), runId: runs.a!.runId }]);
    expect(d).toMatchObject({ taskSuccess: { succeeded: 3 }, harnessCompliance: { applicable: true, compliant: 0, fullSddCompleted: 0, tasks: 3, rate: 0 } });
    expect(d?.metrics.toolCalls).toMatchObject({ total: null, available: 0, unavailable: 3 });
    expect(d?.metrics.resumeSuccess).toMatchObject({ total: 1, available: 1, unavailable: 2 });
    expect(d?.metrics.timeouts).toMatchObject({ total: 0, available: 3 });
    expect(fixtures.tasks.find((task) => task.harness === "full-sdd" && task.taskId === "add-export")).toEqual({ taskId: "add-export", harness: "full-sdd", success: true, compliant: false, artifact: "d.json", pointer: "/tasks/0" });

    const markdown = renderComparisonMarkdown(fixtures);
    expect(markdown).toContain("## Task success (independent functional grading)");
    expect(markdown).toContain("## Harness compliance (graded from repository history)");
    expect(markdown).toContain(`\`d.json\` (run ${runs.d!.runId}, sha256 ${sha256(inputs[2]!.content)})`);
  });

  it("writes JSON and Markdown reports from the CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-eval-compare-"));
    try {
      expect(await run(["evals", "run", "--adapter=fake", "--harness=no-ways", "--output=a.json"], cwd)).toBe(0);
      expect(await run(["evals", "run", "--adapter=fake", "--harness=full-sdd", "--output=d.json"], cwd)).toBe(0);
      expect(await run(["evals", "compare", "--input=a.json", "--input=d.json", "--output=report.json", "--markdown=report.md"], cwd)).toBe(0);
      const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
      expect(report.runs.map((entry: { artifact: { path: string }; status: string }) => [entry.artifact.path, entry.status])).toEqual([["a.json", "comparable"], ["d.json", "comparable"]]);
      expect(await readFile(join(cwd, "report.md"), "utf8")).toContain("# Harness comparison");
      await writeFile(join(cwd, "broken.json"), "nope");
      expect(await run(["evals", "compare", "--input=broken.json"], cwd)).toBe(1);
      await expect(run(["evals", "compare"], cwd)).rejects.toThrow("Usage: ways evals compare");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
