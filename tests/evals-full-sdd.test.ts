import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { commandAdapter, fakeAdapter } from "../src/evals/adapters.js";
import { compareResultFiles, compareResults, renderComparisonMarkdown } from "../src/evals/compare.js";
import { captureWaysRevision } from "../src/evals/ways.js";
import { finishQuick } from "../src/work/quick.js";
import { loadCorpus } from "../src/evals/corpus.js";
import { runEvals } from "../src/evals/runner.js";
import type { AdapterInput, EvalAdapter, EvalConfiguration, EvalCorpus, EvalRunResult } from "../src/evals/types.js";
import { GitRepository } from "../src/git/git.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { advanceSdd, downgradeSdd, startSdd } from "../src/work/sdd.js";
import { remediateSdd } from "../src/work/remediation.js";
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

function fullSdd(adapter: EvalAdapter): EvalConfiguration {
  return { ...base, harness: "full-sdd", adapter: { id: adapter.id, argv: adapter.argv } };
}

function codes(compliance: EvalRunResult["tasks"][number]["compliance"] | undefined): string[] {
  return compliance?.applicable ? compliance.issues.map((issue) => issue.code) : [];
}

function scripted(id: string, run: (input: AdapterInput) => Promise<void>): EvalAdapter {
  return { id, argv: [id], synthetic: true, async run(input) {
    await run(input);
    return { doneClaim: true, exitCode: 0, stdout: "", stderr: "", overflow: false };
  } };
}

/** Drives the real Ways SDD lifecycle in the disposable repository, as a compliant agent would. */
interface SddScript {
  workId?: string;
  implement?: boolean;
  /** Runs after the named phase is certified. */
  after?: Partial<Record<string, (input: AdapterInput) => Promise<void>>>;
}

async function sneak(input: AdapterInput, files: Record<string, string>, message = "sneak\n\nHarness-Work: add-export"): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(input.repo, path)), { recursive: true });
    await writeFile(join(input.repo, path), content);
  }
  const git = new GitRepository(input.repo);
  await git.run(["add", "-A"], undefined, true);
  await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message], undefined, true);
}

function sddAdapter(seen: AdapterInput[] = [], script: SddScript = {}): EvalAdapter {
  return {
    id: "sdd-fixture",
    argv: ["sdd-fixture"],
    synthetic: true,
    async run(input) {
      seen.push(input);
      const work = script.workId ?? input.task.id;
      const advance = async (phase: string): Promise<void> => {
        await advanceSdd(input.repo);
        await script.after?.[phase]?.(input);
      };
      await startSdd(input.repo, work, "autonomous");
      for (const phase of ["intake", "explore", "assess", "specify", "plan", "decompose", "implement"]) {
        await fill(input.repo, work, phase);
        if (phase === "implement" && script.implement !== false) await applyPatch(input);
        await advance(phase);
      }
      await fill(input.repo, work, "review");
      const reviewPath = join(input.repo, ".ways/runtime/review.json");
      await mkdir(dirname(reviewPath), { recursive: true });
      await writeFile(reviewPath, JSON.stringify({ schemaVersion: 1, workId: work, reviewer: "fixture/reviewer", digest: await reviewDigest(input.repo), verdict: "pass", findings: [] }));
      await submitReview(input.repo, reviewPath);
      await advance("review");
      for (const phase of ["validate", "reconcile-memory", "close"]) {
        await fill(input.repo, work, phase);
        await advance(phase);
      }
      return { doneClaim: true, exitCode: 0, stdout: "", stderr: "", overflow: false, metrics: { toolCalls: 12, retries: 0 } };
    },
  };
}

describe("full SDD harness evals", () => {
  it("installs Ways, records its revision and grades a compliant SDD delivery from history", async () => {
    const seen: AdapterInput[] = [];
    const adapter = sddAdapter(seen);
    const result = await runEvals({ corpus: await singleTaskCorpus(), adapter, configuration: fullSdd(adapter) });
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

    const bypass = scripted("bypass", async (input) => {
      await applyPatch(input);
      const git = new GitRepository(input.repo);
      await git.run(["add", "."], undefined, true);
      await git.run(["commit", "-q", "--no-verify", "-m", "sneak"], undefined, true);
    });
    const bypassed = await runEvals({ corpus: await singleTaskCorpus(), adapter: bypass, configuration: fullSdd(bypass) });
    expect(bypassed.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false } });
    expect(codes(bypassed.tasks[0]?.compliance)).toContain("history-untraced");
  });

  it("never grades a run compliant without a closed SDD work for the task", async () => {
    const corpus = await singleTaskCorpus();
    const noop = scripted("noop", async () => {});
    const idle = await runEvals({ corpus, adapter: noop, configuration: fullSdd(noop) });
    expect(idle.tasks[0]).toMatchObject({ success: false, compliance: { compliant: false, fullSddCompleted: false, sddWorksStarted: 0 } });
    expect(codes(idle.tasks[0]?.compliance)).toEqual(["eval-sdd-not-closed"]);

    const foreign = sddAdapter([], { workId: "unrelated-work" });
    const elsewhere = await runEvals({ corpus, adapter: foreign, configuration: fullSdd(foreign) });
    expect(elsewhere.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false, sddWorksClosed: 1 } });
    expect(codes(elsewhere.tasks[0]?.compliance)).toEqual(expect.arrayContaining(["eval-foreign-work", "eval-sdd-not-closed"]));

    const downgrade = scripted("downgrade", async (input) => {
      await startSdd(input.repo, input.task.id, "autonomous");
      for (const phase of ["intake", "explore"]) {
        await fill(input.repo, input.task.id, phase);
        await advanceSdd(input.repo);
      }
      await fill(input.repo, input.task.id, "assess");
      await downgradeSdd(input.repo, "quick");
      await applyPatch(input);
      await finishQuick(input.repo, "feat: add summarize export");
    });
    const downgraded = await runEvals({ corpus, adapter: downgrade, configuration: fullSdd(downgrade) });
    expect(downgraded.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false, downgrades: 1 } });
    expect(codes(downgraded.tasks[0]?.compliance)).toEqual(expect.arrayContaining(["eval-downgraded", "eval-sdd-not-closed"]));
  });

  it("rejects product changes outside the implement window and anything after close", async () => {
    const corpus = await singleTaskCorpus();
    const patch = Object.fromEntries((corpus.tasks[0]!.fakePatch ?? []).map((file) => [file.path, file.content]));
    const grade = async (adapter: EvalAdapter) => (await runEvals({ corpus, adapter, configuration: fullSdd(adapter) })).tasks[0];

    const afterReview = await grade(sddAdapter([], { implement: false, after: { review: (input) => sneak(input, patch) } }));
    expect(afterReview).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false, sddWorksClosed: 1 } });
    expect(codes(afterReview?.compliance)).toEqual(["eval-change-outside-implement"]);

    const forgedState = await grade(sddAdapter([], { after: { close: async (input) => {
      await sneak(input, { ".ways/state/current.json": JSON.stringify({ id: "add-export" }), "src/extra.js": "export const extra = 1;\n" });
      await rm(join(input.repo, ".ways/state/current.json"));
      await sneak(input, {});
    } } }));
    expect(forgedState).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false } });
    expect(codes(forgedState?.compliance)).toEqual(["eval-commit-after-close", "eval-commit-after-close"]);

    const merged = await grade(sddAdapter([], { implement: false, after: { validate: async (input) => {
      const git = new GitRepository(input.repo);
      await git.run(["switch", "-q", "-c", "side"], undefined, true);
      await sneak(input, { ".ways/sdd/add-export/note.md": "note\n" });
      await git.run(["switch", "-q", "main"], undefined, true);
      await git.run(["merge", "--no-ff", "--no-commit", "side"], undefined, true);
      await sneak(input, patch, "merge side\n\nHarness-Work: add-export");
    } } }));
    expect(merged).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false } });
    expect(codes(merged?.compliance)).toEqual(expect.arrayContaining(["eval-merge-commit", "eval-change-outside-implement"]));

    const weakened = await grade(sddAdapter([], { after: { close: async (input) => {
      const config = JSON.parse(await readFile(join(input.repo, ".ways/config.json"), "utf8"));
      await sneak(input, { ".ways/config.json": JSON.stringify({ ...config, testCommand: ["true"] }) }, "weaken");
    } } }));
    expect(codes(weakened?.compliance)).toEqual(expect.arrayContaining(["history-untraced", "eval-harness-tampered"]));
    expect(weakened?.compliance).toMatchObject({ compliant: false, fullSddCompleted: false });
  });

  it("grades a legitimate remediation back to implement as compliant", async () => {
    const remediating = scripted("remediating", async (input) => {
      const work = input.task.id;
      await startSdd(input.repo, work, "autonomous");
      for (const phase of ["intake", "explore", "assess", "specify", "plan", "decompose", "implement"]) {
        await fill(input.repo, work, phase);
        await advanceSdd(input.repo);
      }
      const reviewPath = join(input.repo, ".ways/runtime/review.json");
      await mkdir(dirname(reviewPath), { recursive: true });
      await writeFile(reviewPath, JSON.stringify({ schemaVersion: 1, workId: work, reviewer: "fixture/reviewer", digest: await reviewDigest(input.repo), verdict: "fail", findings: [{ id: "missing", severity: "high", summary: "summarize is missing", disposition: "open" }] }));
      await submitReview(input.repo, reviewPath);
      await remediateSdd(input.repo, "implement", "summarize is missing");
      await fill(input.repo, work, "attempts/1/implement");
      await applyPatch(input);
      await advanceSdd(input.repo);
      for (const phase of ["review", "validate", "reconcile-memory", "close"]) {
        await fill(input.repo, work, `attempts/1/${phase}`);
        if (phase === "review") {
          await writeFile(reviewPath, JSON.stringify({ schemaVersion: 1, workId: work, attempt: 1, reviewer: "fixture/reviewer", digest: await reviewDigest(input.repo), verdict: "pass", findings: [] }));
          await submitReview(input.repo, reviewPath);
        }
        await advanceSdd(input.repo);
      }
    });
    const result = await runEvals({ corpus: await singleTaskCorpus(), adapter: remediating, configuration: fullSdd(remediating) });
    expect(result.tasks[0]?.sessions[0]?.adapter.error).toBeNull();
    expect(result.tasks[0]).toMatchObject({ success: true, compliance: { compliant: true, fullSddCompleted: true, remediationAttempts: 1, issues: [] } });
    expect(result.tasks[0]?.metrics.remediationAttempts).toEqual({ value: 1, source: "repository" });
  });

  it("keeps the functional grade when compliance cannot be graded", async () => {
    const breaker = scripted("breaker", async (input) => {
      await applyPatch(input);
      await rm(join(input.repo, ".git"), { recursive: true, force: true });
    });
    const result = await runEvals({ corpus: await singleTaskCorpus(), adapter: breaker, configuration: fullSdd(breaker) });
    expect(result.tasks[0]).toMatchObject({ success: true, compliance: { applicable: true, compliant: false } });
    expect(codes(result.tasks[0]?.compliance)).toEqual(["eval-compliance-error"]);
  });

  it("works through the installed ways bin and the managed hook without WAYS_CLI", async () => {
    const saved = process.env.WAYS_CLI;
    delete process.env.WAYS_CLI;
    try {
      const script = [
        "const { execFileSync } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const bin = process.env.WAYS_EVAL_WAYS_BIN;",
        "execFileSync(bin, ['quick', 'start', process.env.WAYS_EVAL_TASK_ID]);",
        "writeFileSync('src/summary.js', 'export function summarize(value) { return String(value); }\\nexport default function summary(value) { return String(value); }\\n');",
        "execFileSync(bin, ['quick', 'finish', '--message=feat: add summarize']);",
        "console.log(JSON.stringify({ doneClaim: true }));",
      ].join("\n");
      const adapter = commandAdapter(process.execPath, ["-e", script]);
      const result = await runEvals({ corpus: await singleTaskCorpus(), adapter, configuration: fullSdd(adapter) });
      expect(result.tasks[0]?.sessions[0]?.adapter).toMatchObject({ exitCode: 0, error: null });
      expect(result.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, fullSddCompleted: false } });
      // Quick delivery changes product code outside any SDD implement window.
      expect(codes(result.tasks[0]?.compliance)).toEqual(["eval-change-outside-implement", "eval-sdd-not-closed"]);
      expect(result.evidence.kind).toBe("real");
    } finally {
      process.env.WAYS_CLI = saved;
    }
  });

  it("keeps a fixture .gitignore intact and the package links untracked", async () => {
    const corpus = await singleTaskCorpus();
    const task = { ...corpus.tasks[0]!, setup: [...corpus.tasks[0]!.setup, { path: ".gitignore", content: "coverage" }] };
    let tracked = "unset";
    let ignore = "";
    const probe = scripted("probe", async (input) => {
      tracked = execFileSync("git", ["ls-files", "node_modules"], { cwd: input.repo, encoding: "utf8" });
      ignore = await readFile(join(input.repo, ".gitignore"), "utf8");
    });
    await runEvals({ corpus: { ...corpus, tasks: [task] }, adapter: probe, configuration: fullSdd(probe) });
    expect(tracked).toBe("");
    expect(ignore).toBe("coverage\nnode_modules/\n");
  });

  it("records a null source revision for a packed package and qualifies a checkout", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "ways-eval-consumer-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: consumer });
      const root = join(consumer, "node_modules/@develatter/ways");
      await mkdir(join(root, "dist"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "@develatter/ways", version: "9.9.9" }));
      await writeFile(join(root, "dist/cli.js"), "");
      expect(await captureWaysRevision(root)).toMatchObject({ packageVersion: "9.9.9", sourceRevision: null, sourceRevisionReason: expect.stringContaining("not a Git checkout") });
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
    expect((await captureWaysRevision()).sourceRevisionReason).toContain("dist/ is an untracked build");
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
      { path: "no-metric.json", content: content({ ...runs.a, tasks: runs.a!.tasks.map((task) => ({ ...task, metrics: { ...task.metrics, toolCalls: undefined } })) }) },
      { path: "nan.json", content: content({ ...runs.a, tasks: runs.a!.tasks.map((task) => ({ ...task, metrics: { ...task.metrics, retries: { value: "3", source: "adapter" } } })) }) },
      { path: "real.json", content: content({ ...runs.b, runId: "real-run", evidence: { ...runs.b!.evidence, kind: "real" } }) },
    ];
    const report = compareResults(inputs);
    const status = Object.fromEntries(report.runs.map((entry) => [entry.artifact.path, entry]));
    // The first real run is the reference, so fixtures become non-comparable rather than silently mixed.
    expect(status["real.json"]?.status).toBe("comparable");
    expect(status["a.json"]).toMatchObject({ status: "non-comparable", reasons: ["mixes fixture and real evidence"] });
    expect(status["legacy.json"]).toMatchObject({ status: "invalid", reasons: [expect.stringContaining("schemaVersion 1")] });
    expect(status["broken.json"]).toMatchObject({ status: "invalid", reasons: ["result is not valid JSON"] });
    expect(status["no-metric.json"]).toMatchObject({ status: "invalid", reasons: ["task add-export has malformed metrics"] });
    expect(status["nan.json"]).toMatchObject({ status: "invalid", reasons: ["task add-export has malformed metrics"] });
    expect(status["a.json"]?.artifact.sha256).toBe(sha256(inputs[0]!.content));
    const unreadable = await compareResultFiles([join(tmpdir(), "ways-eval-missing-result.json")]);
    expect(unreadable.runs[0]).toMatchObject({ status: "invalid", reasons: ["input could not be read"], artifact: { sha256: null } });

    const fixtures = compareResults(inputs.filter((input) => input.path !== "real.json"));
    expect(fixtures.reference).toMatchObject({ corpusDigest: runs.a!.corpus.digest });
    expect(fixtures).toMatchObject({ architecturalClaim: false, evidenceKind: "fixture" });
    expect(fixtures.runs.find((entry) => entry.artifact.path === "seed.json")).toMatchObject({ status: "non-comparable", reasons: ["seed differs from the reference run"] });
    expect(fixtures.harnesses.map((score) => score.harness)).toEqual(["no-ways", "checks-only", "full-sdd"]);
    const [a, , d] = fixtures.harnesses;
    expect(a).toMatchObject({ runs: 1, taskSuccess: { succeeded: 3, tasks: 3, rate: 1 }, harnessCompliance: { applicable: false } });
    expect(a?.artifacts).toEqual([{ path: "a.json", sha256: sha256(inputs[0]!.content), runId: runs.a!.runId }]);
    expect(d).toMatchObject({ taskSuccess: { succeeded: 3 }, harnessCompliance: { applicable: true, compliant: 0, fullSddCompleted: 0, tasks: 3, rate: 0 } });
    expect(d?.metrics.toolCalls).toMatchObject({ total: null, observedTotal: null, available: 0, unavailable: 3 });
    expect(d?.metrics.resumeSuccess).toMatchObject({ total: null, observedTotal: 1, available: 1, unavailable: 2 });
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
