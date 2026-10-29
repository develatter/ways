import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { commandAdapter, fakeAdapter } from "../src/evals/adapters.js";
import { compareResults, renderComparisonMarkdown, wilsonInterval } from "../src/evals/compare.js";
import { loadCorpus } from "../src/evals/corpus.js";
import { runEvals } from "../src/evals/runner.js";
import type { AdapterInput, AdapterMetrics, EvalAdapter, EvalConfiguration, EvalCorpus, EvalRunResult, OutcomeEvalPolicy } from "../src/evals/types.js";
import { stableJson } from "../src/fs/files.js";
import { GitRepository } from "../src/git/git.js";
import { buildStatus } from "../src/work/status.js";
import { approve, done, openOutcome, startChange, type Terminal } from "../src/work/work.js";

const base: EvalConfiguration = { adapter: { id: "fake", argv: ["fake"] }, harness: "no-ways", model: "test-model", startingRevision: "corpus-v3", budgets: { maxMilliseconds: 90_000, maxOutputBytes: 4096 }, seed: 5 };

async function corpusOf(...ids: string[]): Promise<EvalCorpus> {
  const corpus = await loadCorpus();
  return { ...corpus, tasks: corpus.tasks.filter((task) => ids.includes(task.id)) };
}

function configured(adapter: EvalAdapter, harness: EvalConfiguration["harness"], outcomePolicy?: Partial<OutcomeEvalPolicy>): EvalConfiguration {
  return { ...base, harness, adapter: { id: adapter.id, argv: adapter.argv }, ...(outcomePolicy ? { outcomePolicy: outcomePolicy as OutcomeEvalPolicy } : {}) };
}

/** A deterministic fixture adapter: it drives shipped Ways primitives in the disposable repository. */
function scripted(id: string, script: (input: AdapterInput) => Promise<{ doneClaim?: boolean; metrics?: AdapterMetrics } | void>): EvalAdapter {
  return { id, argv: [id], synthetic: true, async run(input) {
    const outcome = await script(input) ?? {};
    return { doneClaim: outcome.doneClaim ?? true, exitCode: 0, stdout: "", stderr: "", overflow: false, metrics: outcome.metrics ?? { humanInterventions: 0 } };
  } };
}

function codes(result: EvalRunResult, index = 0): string[] {
  const compliance = result.tasks[index]?.compliance;
  return compliance?.applicable ? compliance.issues.map((issue) => issue.code) : [];
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

function patch(input: AdapterInput, session: "initial" | "resume" = "initial"): Record<string, string> {
  const files = session === "resume" ? input.task.freshSessionResume?.fakePatch ?? [] : input.task.fakePatch ?? [];
  return Object.fromEntries(files.map((file) => [file.path, file.content]));
}

/** Commits like an agent would: through the repository's hooks, which add the trailer. */
async function commit(repo: string, files: Record<string, string>, message: string): Promise<string> {
  await write(repo, files);
  const git = new GitRepository(repo);
  await git.run(["add", "-A"]);
  await git.run(["commit", "-q", "-m", message]);
  return git.head();
}

async function open(input: AdapterInput, policy: Partial<OutcomeEvalPolicy> = input.outcomePolicy ?? {}): Promise<void> {
  await openOutcome(input.repo, input.task.id, { goal: input.task.description, criteria: [`AC1:${input.task.prompt.split("\n")[0]!.slice(0, 120)}`], verify: [], strength: [], review: policy.review ?? "required", approval: policy.approval ?? "none" });
}

/** Opens without a review requirement and with an executable verifier, so `done` alone can close. */
async function openVerified(input: AdapterInput, approval: "required" | "none" = "none"): Promise<void> {
  await openOutcome(input.repo, input.task.id, { goal: input.task.description, criteria: ["AC1:the environment checks pass"], verify: [`AC1:${JSON.stringify(input.task.success[0]!.command)}`], strength: [], review: "none", approval });
}

/** Stands in for the human at the terminal; the eval counts the approval it leaves in the record. */
function human(id: string): Terminal {
  return { interactive: true, ask: async () => id, say: () => undefined };
}

describe("a change finished with ways done (C)", { timeout: 120_000 }, () => {
  it("installs Ways and grades a change traced by the hook and closed by one done", async () => {
    const seen: AdapterInput[] = [];
    const adapter = scripted("change", async (input) => {
      seen.push(input);
      await startChange(input.repo, input.task.id);
      await commit(input.repo, patch(input), `fix: ${input.task.id}`);
      expect((await done(input.repo)).status).toBe("closed");
    });
    const result = await runEvals({ corpus: await corpusOf("false-done-total"), adapter, configuration: configured(adapter, "lightweight-state") });
    expect(result.tasks[0]).toMatchObject({ kind: "false-done-claim", success: true, compliance: { applicable: true, workflow: "change", compliant: true, completed: true, worksClosed: 1, effectivePolicy: null, issues: [] } });
    expect(result.tasks[0]?.environment).toMatchObject({ waysInstalled: true, testCommand: ["node", "-e", expect.stringContaining("test/cart.test.mjs")], environmentChecks: [{ id: "cart-environment" }] });
    expect(result.tasks[0]?.metrics.humanApprovals).toEqual({ value: 0, source: "repository" });
    expect(result.harnessPrompt?.initial).toContain("npx ways done");
    expect(seen[0]?.prompt).toContain("npx ways start false-done-total");
    expect(seen[0]?.waysBin).toMatch(/node_modules\/\.bin\/ways$/);
    expect(result.summary).toMatchObject({ compliantCount: 1, completedCount: 1 });
  });

  it("flags a change never finished, and an outcome where a change was asked for", async () => {
    const corpus = await corpusOf("add-export");
    const unfinished = scripted("unfinished", async (input) => {
      await startChange(input.repo, input.task.id);
      await commit(input.repo, patch(input), "feat: summarize");
    });
    const missing = await runEvals({ corpus, adapter: unfinished, configuration: configured(unfinished, "lightweight-state") });
    expect(missing.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, completed: false } });
    expect(codes(missing).sort()).toEqual(["eval-active-work", "eval-change-not-done"]);

    const outcome = scripted("outcome-instead", async (input) => { await open(input); });
    const other = await runEvals({ corpus, adapter: outcome, configuration: configured(outcome, "lightweight-state") });
    expect(codes(other)).toEqual(expect.arrayContaining(["eval-workflow-mismatch", "eval-active-work", "eval-change-not-done"]));
  });
});

describe("an outcome (E)", { timeout: 180_000 }, () => {
  it("drives the real CLI through open and done and records the effective policy", async () => {
    const script = [
      "const { execFileSync } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const bin = process.env.WAYS_EVAL_WAYS_BIN;",
      "const id = process.env.WAYS_EVAL_TASK_ID;",
      "const policy = JSON.parse(process.env.WAYS_EVAL_OUTCOME_POLICY);",
      "execFileSync(bin, ['outcome', 'open', id, '--goal=Add summarize', '--criterion=AC1:summarize returns strings', '--verify=AC1:grep -q summarize src/summary.js', `--review=${policy.review}`, `--approval=${policy.approval}`]);",
      "writeFileSync('src/summary.js', 'export function summarize(value) { return String(value); }\\nexport default function summary(value) { return String(value); }\\n');",
      "execFileSync('git', ['add', 'src/summary.js']);",
      "execFileSync('git', ['commit', '-q', '-m', 'feat: add summarize']);",
      "execFileSync(bin, ['done']);",
      "console.log(JSON.stringify({ doneClaim: true, metrics: { humanInterventions: 0 } }));",
    ].join("\n");
    const adapter = commandAdapter(process.execPath, ["-e", script]);
    const result = await runEvals({ corpus: await corpusOf("add-export"), adapter, configuration: configured(adapter, "outcome", { review: "none" }) });
    expect(result.tasks[0]?.sessions[0]?.adapter).toMatchObject({ exitCode: 0, error: null });
    expect(result.configuration.outcomePolicy).toEqual({ review: "none", approval: "none" });
    expect(result.harnessPrompt?.initial).toContain("--review=none --approval=none");
    expect(result.tasks[0]).toMatchObject({ success: true, compliance: { workflow: "outcome", compliant: true, completed: true, remediationAttempts: 0, validationFailures: 0, issues: [], effectivePolicy: { review: "none", approval: "none" } } });
    expect(result.evidence.kind).toBe("real");
  });

  it("counts a failing done and the fix that followed from the evidence", async () => {
    const adapter = scripted("fixing", async (input) => {
      await openVerified(input);
      await commit(input.repo, { "src/slug.js": "export function slugify(value) {\n  return value.toLowerCase().replace(/\\s+/g, '-');\n}\n" }, "feat: naive slugify");
      expect((await done(input.repo)).status).toBe("failed");
      await commit(input.repo, patch(input), "fix: fold accents and trim");
      expect((await done(input.repo)).status).toBe("closed");
      return { metrics: { humanInterventions: 0, retries: 1 } };
    });
    const result = await runEvals({ corpus: await corpusOf("remediate-slug"), adapter, configuration: configured(adapter, "outcome", { review: "none" }) });
    expect(result.tasks[0]?.sessions[0]?.adapter.error).toBeNull();
    expect(result.tasks[0]).toMatchObject({ kind: "failed-evaluation-remediation", success: true, compliance: { compliant: true, completed: true, remediationAttempts: 1, validationFailures: 1, issues: [] } });
    expect(result.tasks[0]?.metrics.remediationAttempts).toEqual({ value: 1, source: "repository" });
  });

  it("flags an outcome opened with a weaker policy than configured", async () => {
    const adapter = scripted("weaker", async (input) => {
      await openVerified(input);
      await commit(input.repo, patch(input), "feat: export");
      await done(input.repo);
    });
    const result = await runEvals({ corpus: await corpusOf("add-export"), adapter, configuration: configured(adapter, "outcome", { review: "required" }) });
    expect(result.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, completed: true, effectivePolicy: { review: "none" } } });
    expect(codes(result)).toEqual(["eval-policy-mismatch"]);
  });

  it("counts the human approval recorded in the work record", async () => {
    const adapter = scripted("approved", async (input) => {
      await openVerified(input, "required");
      await commit(input.repo, patch(input), "feat: export");
      expect((await done(input.repo)).status).toBe("verifying");
      expect((await approve(input.repo, human(input.task.id))).status).toBe("closed");
      return { metrics: { humanInterventions: 1 } };
    });
    const result = await runEvals({ corpus: await corpusOf("add-export"), adapter, configuration: configured(adapter, "outcome", { review: "none", approval: "required" }) });
    expect(result.tasks[0]).toMatchObject({ success: true, compliance: { compliant: true, humanApprovals: 1, effectivePolicy: { approval: "required" }, issues: [] } });
    expect(result.tasks[0]?.metrics).toMatchObject({ humanApprovals: { value: 1, source: "repository" }, humanInterventions: { value: 1, source: "adapter" } });
  });

  it("keeps a closed outcome with a false done claim visible as an assurance violation", async () => {
    const adapter = scripted("partial", async (input) => {
      await openVerified(input);
      await commit(input.repo, { "src/cart.js": "export function total(items) {\n  return items.reduce((sum, item) => Number.isFinite(item.price) ? sum + item.price : sum, 0);\n}\n" }, "feat: skip invalid prices");
      await done(input.repo);
    });
    const result = await runEvals({ corpus: await corpusOf("false-done-total"), adapter, configuration: configured(adapter, "outcome", { review: "none" }) });
    expect(result.tasks[0]).toMatchObject({ success: false, incorrectDoneClaim: true, compliance: { compliant: true, completed: true } });
    const report = compareResults([{ path: "e.json", content: stableJson(result) }]);
    expect(report.harnesses[0]?.assurance).toMatchObject({ incorrectDoneClaims: { count: 1, trials: 1 }, completedWithoutSuccess: { count: 1, trials: 1 } });
  });

  it("parallelises with plain git worktrees whose commits the hook attributes to the outcome", async () => {
    const adapter = scripted("parallel", async (input) => {
      await openVerified(input);
      const main = new GitRepository(input.repo);
      const trees = await mkdtemp(join(tmpdir(), "ways-eval-worktrees-"));
      const edit = async (name: string, statement: string): Promise<string> => {
        const path = join(trees, name);
        await main.run(["worktree", "add", "-q", "-b", name, path]);
        return commit(path, { "src/format.js": `export function format(value, options = {}) {\n  ${statement}\n}\n` }, `feat: ${name}`);
      };
      const trim = await edit("trim", "return options.trim ? String(value).trim() : String(value);");
      const upper = await edit("upper", "return options.upper ? String(value).toUpperCase() : String(value);");
      for (const hash of [trim, upper]) expect((await main.commitInfo(hash)).trailers.work).toBe(input.task.id);
      await main.run(["cherry-pick", trim]);
      await expect(main.run(["cherry-pick", upper])).rejects.toThrow();
      await write(input.repo, { "src/format.js": "export function format(value, options = {}) {\n  let result = String(value);\n  if (options.trim) result = result.trim();\n  if (options.upper) result = result.toUpperCase();\n  return result;\n}\n" });
      await main.run(["add", "src/format.js"]);
      await main.run(["-c", "core.editor=true", "cherry-pick", "--continue"]);
      for (const name of ["trim", "upper"]) await main.run(["worktree", "remove", "--force", join(trees, name)]);
      expect((await done(input.repo)).status).toBe("closed");
      return { metrics: { humanInterventions: 0, retries: 1 } };
    });
    const result = await runEvals({ corpus: await corpusOf("conflict-format"), adapter, configuration: configured(adapter, "outcome", { review: "none" }) });
    expect(result.tasks[0]?.sessions[0]?.adapter.error).toBeNull();
    expect(result.tasks[0]).toMatchObject({ kind: "concurrent-conflict", success: true, compliance: { compliant: true, issues: [] } });
  });

  it("resumes an open outcome from `ways status` in a fresh session", async () => {
    const adapter = scripted("resuming", async (input) => {
      if (input.session === "initial") {
        await openVerified(input);
        return { doneClaim: false };
      }
      expect((await buildStatus(input.repo)).active).toMatchObject({ id: input.task.id, kind: "outcome" });
      await commit(input.repo, patch(input, "resume"), "feat: resume");
      await done(input.repo);
      return undefined;
    });
    const result = await runEvals({ corpus: await corpusOf("resume-session"), adapter, configuration: configured(adapter, "outcome", { review: "none" }) });
    expect(result.tasks[0]).toMatchObject({ kind: "resume", success: true, incorrectDoneClaim: false, compliance: { compliant: true } });
    expect(result.tasks[0]?.metrics.resumeSuccess).toEqual({ value: true, source: "runner" });
  });

  it("rejects outcome policies on other harnesses, invalid values and the retired SDD harness", async () => {
    await expect(runEvals({ corpus: await corpusOf("add-export"), adapter: fakeAdapter, configuration: { ...base, outcomePolicy: { review: "none" } as OutcomeEvalPolicy } })).rejects.toThrow("only to the outcome harness");
    await expect(runEvals({ corpus: await corpusOf("add-export"), adapter: fakeAdapter, configuration: { ...base, harness: "outcome", outcomePolicy: { review: "sometimes" } as unknown as OutcomeEvalPolicy } })).rejects.toThrow("review must be one of");
    const cwd = await mkdtemp(join(tmpdir(), "ways-eval-policy-cli-"));
    try {
      await expect(run(["evals", "run", "--harness=lightweight-state", "--review=none"], cwd)).rejects.toThrow("apply only to --harness=outcome");
      await expect(run(["evals", "run", "--harness=full-sdd"], cwd)).rejects.toThrow("--harness must be one of");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("matched comparison", { timeout: 300_000 }, () => {
  it("reports every configuration on the same tasks with intervals and raw evidence, never a single score", async () => {
    const corpus = await loadCorpus();
    expect(new Set(corpus.tasks.map((task) => task.kind))).toEqual(new Set(["feature", "resume", "failed-evaluation-remediation", "false-done-claim", "concurrent-conflict"]));
    const harnesses = ["no-ways", "checks-only", "lightweight-state", "outcome"] as const;
    const results = await Promise.all(harnesses.map((harness) => runEvals({ corpus, adapter: fakeAdapter, configuration: { ...base, harness } })));
    const inputs = results.map((result, index) => ({ path: `${harnesses[index]}.json`, content: stableJson(result) }));
    const otherPolicy = { ...results[3]!, runId: "other-policy", configuration: { ...results[3]!.configuration, outcomePolicy: { ...results[3]!.configuration.outcomePolicy!, review: "none" as const } } };
    const report = compareResults([...inputs, { path: "other-policy.json", content: stableJson(otherPolicy) }, { path: "v2.json", content: stableJson({ ...results[0], schemaVersion: 2 }) }]);
    expect(report.runs.find((entry) => entry.artifact.path === "other-policy.json")).toMatchObject({ status: "non-comparable", reasons: ["outcome policy differs from the first comparable run of this harness"] });
    expect(report.runs.find((entry) => entry.artifact.path === "v2.json")).toMatchObject({ status: "invalid", reasons: [expect.stringContaining("is not 3")] });
    expect(report.harnesses.map((score) => [score.configuration, score.harness])).toEqual([["A", "no-ways"], ["B", "checks-only"], ["C", "lightweight-state"], ["E", "outcome"]]);
    const [a, , c, e] = report.harnesses;
    expect(a).toMatchObject({ taskSuccess: { count: 6, trials: 6, rate: 1, interval95: wilsonInterval(6, 6) }, harnessCompliance: { applicable: false }, assurance: { completedWithoutSuccess: null } });
    expect(c?.harnessCompliance).toMatchObject({ applicable: true, workflow: "change", compliant: { count: 0, trials: 6 } });
    expect(e).toMatchObject({ outcomePolicy: { review: "required", approval: "none" }, harnessCompliance: { workflow: "outcome", completed: { count: 0 } }, assurance: { complianceIssues: { "eval-outcome-not-closed": 6, "eval-uncommitted-changes": 6 } } });
    expect(e?.byKind).toMatchObject({ "concurrent-conflict": { succeeded: 1, trials: 1 }, "failed-evaluation-remediation": { succeeded: 1, trials: 1 } });
    expect(e?.metrics.humanApprovals).toMatchObject({ total: 0, available: 6 });
    expect(a?.metrics.humanApprovals).toMatchObject({ total: null, unavailable: 6 });
    expect(report.matrix).toHaveLength(6);
    expect(report.tasks).toHaveLength(24);
    expect(report.tasks.find((task) => task.harness === "outcome" && task.taskId === "conflict-format")).toMatchObject({ kind: "concurrent-conflict", completed: false, complianceIssues: ["eval-outcome-not-closed", "eval-uncommitted-changes"], artifact: "outcome.json", pointer: "/tasks/5" });
    expect(JSON.stringify(report)).not.toMatch(/"(overall|score)"/);
    const markdown = renderComparisonMarkdown(report);
    for (const heading of ["## Assurance violations", "## Cost and time", "## Matched tasks", "## Raw task evidence", "95% CI"]) expect(markdown).toContain(heading);
  });

  it("computes Wilson intervals that stay inside [0, 1]", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(0, 5)).toEqual([0, 0.4345]);
    expect(wilsonInterval(5, 5)).toEqual([0.5655, 1]);
    expect(wilsonInterval(5, 10)).toEqual([0.2366, 0.7634]);
  });

  it("records outcome policy flags from the CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-eval-outcome-cli-"));
    try {
      await writeFile(join(cwd, "corpus.json"), JSON.stringify(await corpusOf("add-export")));
      expect(await run(["evals", "run", "--adapter=fake", "--harness=outcome", "--review=none", `--corpus=${join(cwd, "corpus.json")}`, "--output=e.json"], cwd)).toBe(0);
      const result = JSON.parse(await readFile(join(cwd, "e.json"), "utf8")) as EvalRunResult;
      expect(result.configuration.outcomePolicy).toEqual({ review: "none", approval: "none" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
