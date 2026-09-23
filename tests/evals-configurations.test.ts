import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { buildContext } from "../src/context/context.js";
import { commandAdapter, fakeAdapter } from "../src/evals/adapters.js";
import { compareResults, renderComparisonMarkdown, wilsonInterval } from "../src/evals/compare.js";
import { loadCorpus } from "../src/evals/corpus.js";
import { runEvals } from "../src/evals/runner.js";
import type { AdapterInput, AdapterMetrics, EvalAdapter, EvalConfiguration, EvalCorpus, EvalRunResult, OutcomeEvalPolicy } from "../src/evals/types.js";
import { lightweightEvidencePath } from "../src/evals/ways.js";
import { stableJson } from "../src/fs/files.js";
import { GitRepository } from "../src/git/git.js";
import { closeOutcome, evaluateOutcome, openOutcome, outcomeEvidencePath, remediateOutcome } from "../src/work/outcome.js";
import { finishQuick, startQuick } from "../src/work/quick.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

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

async function lightweightEvidence(input: AdapterInput): Promise<void> {
  await write(input.repo, { [lightweightEvidencePath(input.task.id)]: JSON.stringify({ schemaVersion: 1, task: input.task.id, claims: [{ criterion: input.task.prompt, evidence: "ran the environment checks" }] }) });
}

/** Implements through a task worktree, as required isolation demands. */
async function executeTask(input: AdapterInput, taskId: string, files: Record<string, string>, attempt = 0): Promise<void> {
  await addTask(input.repo, taskId, `Implement ${taskId}`);
  const task = await prepareTask(input.repo, taskId);
  await write(task.worktree!, files);
  const commit = await new GitRepository(task.worktree!).commit(Object.keys(files), `feat: ${taskId}`, { work: input.task.id, task: taskId, ...(attempt > 0 ? { attempt: String(attempt) } : {}) });
  await integrateTask(input.repo, taskId, [commit]);
}

async function evidence(input: AdapterInput, attempt = 0, summary = "the environment checks pass"): Promise<void> {
  await write(input.repo, { [outcomeEvidencePath(input.task.id, attempt)]: JSON.stringify({ schemaVersion: 1, workId: input.task.id, attempt, criteria: { AC1: { summary } } }) });
}

async function independentReview(input: AdapterInput, attempt = 0): Promise<void> {
  const path = join(input.repo, ".ways/runtime/review.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: input.task.id, ...(attempt > 0 ? { attempt } : {}), reviewer: "fixture/reviewer", digest: await reviewDigest(input.repo), verdict: "pass", findings: [] }));
  await submitReview(input.repo, path);
}

async function open(input: AdapterInput, evaluation: "independent" | "self" = input.outcomePolicy?.evaluation ?? "independent"): Promise<void> {
  await openOutcome(input.repo, input.task.id, input.task.description, [{ id: "AC1", text: input.task.prompt }], input.outcomePolicy?.memory ?? "normal", evaluation,
    { isolation: input.outcomePolicy?.isolation ?? "required", parallel: input.outcomePolicy?.parallel ?? "allowed" });
}

describe("lightweight state (C)", { timeout: 120_000 }, () => {
  it("installs Ways and grades a finished quick work with committed evidence", async () => {
    const seen: AdapterInput[] = [];
    const adapter = scripted("quick-evidence", async (input) => {
      seen.push(input);
      await startQuick(input.repo, input.task.id);
      await write(input.repo, patch(input));
      await lightweightEvidence(input);
      await finishQuick(input.repo, `feat: ${input.task.id}`);
    });
    const result = await runEvals({ corpus: await corpusOf("false-done-total"), adapter, configuration: configured(adapter, "lightweight-state") });
    expect(result.tasks[0]).toMatchObject({ kind: "false-done-claim", success: true, compliance: { applicable: true, workflow: "quick-evidence", compliant: true, completed: true, worksClosed: 1, effectivePolicy: null, issues: [] } });
    expect(result.tasks[0]?.environment).toMatchObject({ waysInstalled: true, testCommand: ["node", "-e", expect.stringContaining("test/cart.test.mjs")], environmentChecks: [{ id: "cart-environment" }] });
    expect(result.tasks[0]?.metrics.humanApprovals).toEqual({ value: 0, source: "repository" });
    expect(result.tasks[0]?.metrics.humanInterventions).toEqual({ value: 0, source: "adapter" });
    expect(result.harnessPrompt?.initial).toContain("npx ways quick start <task-id>");
    expect(seen[0]?.prompt).toContain("npx ways quick start false-done-total");
    expect(seen[0]?.waysBin).toMatch(/node_modules\/\.bin\/ways$/);
    expect(result.summary).toMatchObject({ compliantCount: 1, completedCount: 1 });
  });

  it("flags missing evidence and a different workflow", async () => {
    const corpus = await corpusOf("add-export");
    const bare = scripted("bare-quick", async (input) => {
      await startQuick(input.repo, input.task.id);
      await write(input.repo, patch(input));
      await finishQuick(input.repo, "feat: summarize");
    });
    const missing = await runEvals({ corpus, adapter: bare, configuration: configured(bare, "lightweight-state") });
    expect(missing.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, completed: false } });
    expect(codes(missing)).toEqual(["eval-evidence-invalid"]);

    const outcome = scripted("outcome-instead", async (input) => { await open(input); });
    const other = await runEvals({ corpus, adapter: outcome, configuration: configured(outcome, "lightweight-state") });
    expect(codes(other)).toEqual(expect.arrayContaining(["eval-workflow-mismatch", "eval-active-work", "eval-quick-not-finished", "eval-evidence-invalid"]));
  });
});

describe("outcome loop (E)", { timeout: 180_000 }, () => {
  it("drives the real CLI through open, evaluate and close and records the effective policy", async () => {
    const script = [
      "const { execFileSync } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const bin = process.env.WAYS_EVAL_WAYS_BIN;",
      "const id = process.env.WAYS_EVAL_TASK_ID;",
      "const policy = JSON.parse(process.env.WAYS_EVAL_OUTCOME_POLICY);",
      "execFileSync(bin, ['outcome', 'open', id, '--goal=Add summarize', '--criterion=AC1:summarize returns strings', `--isolation=${policy.isolation}`, `--parallel=${policy.parallel}`, `--evaluation=${policy.evaluation}`, `--memory=${policy.memory}`]);",
      "writeFileSync('src/summary.js', 'export function summarize(value) { return String(value); }\\nexport default function summary(value) { return String(value); }\\n');",
      "execFileSync('git', ['add', 'src/summary.js']);",
      "execFileSync('git', ['commit', '-q', '-m', 'feat: add summarize', '-m', `Harness-Work: ${id}`]);",
      "writeFileSync(`.ways/outcomes/${id}/attempts/0/evidence.json`, JSON.stringify({ schemaVersion: 1, workId: id, attempt: 0, criteria: { AC1: { summary: 'summarize(4) returns 4' } } }));",
      "execFileSync(bin, ['outcome', 'evaluate']);",
      "execFileSync(bin, ['outcome', 'close']);",
      "console.log(JSON.stringify({ doneClaim: true, metrics: { humanInterventions: 0 } }));",
    ].join("\n");
    const adapter = commandAdapter(process.execPath, ["-e", script]);
    const result = await runEvals({ corpus: await corpusOf("add-export"), adapter, configuration: configured(adapter, "outcome", { isolation: "optional", evaluation: "self" }) });
    expect(result.tasks[0]?.sessions[0]?.adapter).toMatchObject({ exitCode: 0, error: null });
    expect(result.configuration.outcomePolicy).toEqual({ isolation: "optional", parallel: "allowed", evaluation: "self", memory: "normal" });
    expect(result.harnessPrompt?.initial).toContain("--isolation=optional --parallel=allowed --evaluation=self --memory=normal");
    expect(result.tasks[0]).toMatchObject({ success: true, compliance: { workflow: "outcome", compliant: true, completed: true, remediationAttempts: 0, validationFailures: 0, issues: [],
      effectivePolicy: { isolation: "optional", parallel: "allowed", evaluation: "self", memory: "normal" } } });
    expect(result.evidence.kind).toBe("real");
  });

  it("counts a failed evaluation and its remediation from history", async () => {
    const adapter = scripted("remediating", async (input) => {
      await open(input);
      await executeTask(input, "naive", { "src/slug.js": "export function slugify(value) {\n  return value.toLowerCase().replace(/\\s+/g, '-');\n}\n" });
      await evidence(input);
      await expect(evaluateOutcome(input.repo)).rejects.toThrow(/Evaluation failed and was recorded/);
      await remediateOutcome(input.repo, "accents and surrounding spaces are not folded");
      await executeTask(input, "fold", patch(input), 1);
      await evidence(input, 1, "node test/slug.test.mjs passes");
      await evaluateOutcome(input.repo);
      await independentReview(input, 1);
      await closeOutcome(input.repo);
      return { metrics: { humanInterventions: 0, retries: 1 } };
    });
    const result = await runEvals({ corpus: await corpusOf("remediate-slug"), adapter, configuration: configured(adapter, "outcome", {}) });
    expect(result.tasks[0]?.sessions[0]?.adapter.error).toBeNull();
    expect(result.tasks[0]).toMatchObject({ kind: "failed-evaluation-remediation", success: true, compliance: { compliant: true, completed: true, remediationAttempts: 1, validationFailures: 1, issues: [] } });
    expect(result.tasks[0]?.metrics.remediationAttempts).toEqual({ value: 1, source: "repository" });
  });

  it("flags an outcome opened with weaker policies than configured", async () => {
    const adapter = scripted("weaker", async (input) => {
      await open(input, "self");
      await executeTask(input, "impl", patch(input));
      await evidence(input);
      await evaluateOutcome(input.repo);
      await closeOutcome(input.repo);
    });
    const result = await runEvals({ corpus: await corpusOf("add-export"), adapter, configuration: configured(adapter, "outcome", { evaluation: "independent" }) });
    expect(result.tasks[0]).toMatchObject({ success: true, compliance: { compliant: false, completed: true, effectivePolicy: { evaluation: "self" } } });
    expect(codes(result)).toEqual(["eval-policy-mismatch"]);
  });

  it("keeps a closed outcome with a false done claim visible as an assurance violation", async () => {
    const adapter = scripted("partial", async (input) => {
      await open(input, "self");
      await executeTask(input, "skip-invalid", { "src/cart.js": "export function total(items) {\n  return items.reduce((sum, item) => Number.isFinite(item.price) ? sum + item.price : sum, 0);\n}\n" });
      await evidence(input, 0, "invalid prices are skipped and quantities multiply");
      await evaluateOutcome(input.repo);
      await closeOutcome(input.repo);
    });
    const result = await runEvals({ corpus: await corpusOf("false-done-total"), adapter, configuration: configured(adapter, "outcome", { evaluation: "self" }) });
    expect(result.tasks[0]).toMatchObject({ success: false, incorrectDoneClaim: true, compliance: { compliant: true, completed: true } });
    const report = compareResults([{ path: "e.json", content: stableJson(result) }]);
    expect(report.harnesses[0]?.assurance).toMatchObject({ incorrectDoneClaims: { count: 1, trials: 1 }, completedWithoutSuccess: { count: 1, trials: 1 } });
  });

  it("resolves a conflict between parallel tasks and grades it compliant", async () => {
    const adapter = scripted("parallel", async (input) => {
      await open(input, "self");
      await addTask(input.repo, "trim", "trim option");
      await addTask(input.repo, "upper", "upper option");
      const trim = await prepareTask(input.repo, "trim");
      const upper = await prepareTask(input.repo, "upper");
      const edit = async (worktree: string, statement: string, taskId: string): Promise<string> => {
        await write(worktree, { "src/format.js": `export function format(value, options = {}) {\n  ${statement}\n}\n` });
        return new GitRepository(worktree).commit(["src/format.js"], `feat: ${taskId}`, { work: input.task.id, task: taskId });
      };
      await integrateTask(input.repo, "trim", [await edit(trim.worktree!, "return options.trim ? String(value).trim() : String(value);", "trim")]);
      const conflicting = await edit(upper.worktree!, "return options.upper ? String(value).toUpperCase() : String(value);", "upper");
      await expect(integrateTask(input.repo, "upper", [conflicting])).rejects.toThrow();
      const main = new GitRepository(input.repo);
      await main.run(["cherry-pick", "--abort"]);
      const worktree = new GitRepository(upper.worktree!);
      await worktree.run(["reset", "-q", "--hard", await main.head()]);
      await integrateTask(input.repo, "upper", [await edit(upper.worktree!, "let result = String(value);\n  if (options.trim) result = result.trim();\n  if (options.upper) result = result.toUpperCase();\n  return result;", "upper")]);
      await evidence(input, 0, "trim, upper and both combined");
      await evaluateOutcome(input.repo);
      await closeOutcome(input.repo);
      return { metrics: { humanInterventions: 0, retries: 1 } };
    });
    const result = await runEvals({ corpus: await corpusOf("conflict-format"), adapter, configuration: configured(adapter, "outcome", { evaluation: "self" }) });
    expect(result.tasks[0]?.sessions[0]?.adapter.error).toBeNull();
    expect(result.tasks[0]).toMatchObject({ kind: "concurrent-conflict", success: true, compliance: { compliant: true, issues: [] } });
    expect(result.tasks[0]?.metrics.retries).toEqual({ value: 1, source: "adapter" });
  });

  it("resumes an open outcome from the context packet in a fresh session", async () => {
    const adapter = scripted("resuming", async (input) => {
      if (input.session === "initial") {
        await open(input, "self");
        return { doneClaim: false };
      }
      const context = await buildContext(input.repo);
      expect(context.active).toMatchObject({ id: input.task.id, mode: "outcome" });
      await executeTask(input, "upper", patch(input, "resume"));
      await evidence(input);
      await evaluateOutcome(input.repo);
      await closeOutcome(input.repo);
      return undefined;
    });
    const result = await runEvals({ corpus: await corpusOf("resume-session"), adapter, configuration: configured(adapter, "outcome", { evaluation: "self" }) });
    expect(result.tasks[0]).toMatchObject({ kind: "resume", success: true, incorrectDoneClaim: false, compliance: { compliant: true } });
    expect(result.tasks[0]?.metrics.resumeSuccess).toEqual({ value: true, source: "runner" });
  });

  it("rejects outcome policies on other harnesses and invalid values", async () => {
    await expect(runEvals({ corpus: await corpusOf("add-export"), adapter: fakeAdapter, configuration: { ...base, outcomePolicy: { isolation: "optional" } as OutcomeEvalPolicy } })).rejects.toThrow("only to the outcome harness");
    await expect(runEvals({ corpus: await corpusOf("add-export"), adapter: fakeAdapter, configuration: { ...base, harness: "outcome", outcomePolicy: { isolation: "sometimes" } as unknown as OutcomeEvalPolicy } })).rejects.toThrow("isolation must be one of");
    const cwd = await mkdtemp(join(tmpdir(), "ways-eval-policy-cli-"));
    try {
      await expect(run(["evals", "run", "--harness=full-sdd", "--isolation=optional"], cwd)).rejects.toThrow("apply only to --harness=outcome");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("matched A–E comparison", { timeout: 300_000 }, () => {
  it("reports every configuration on the same tasks with intervals and raw evidence, never a single score", async () => {
    const corpus = await loadCorpus();
    expect(new Set(corpus.tasks.map((task) => task.kind))).toEqual(new Set(["feature", "resume", "failed-evaluation-remediation", "false-done-claim", "concurrent-conflict"]));
    const harnesses = ["no-ways", "checks-only", "lightweight-state", "full-sdd", "outcome"] as const;
    const results = await Promise.all(harnesses.map((harness) => runEvals({ corpus, adapter: fakeAdapter, configuration: { ...base, harness } })));
    const inputs = results.map((result, index) => ({ path: `${harnesses[index]}.json`, content: stableJson(result) }));
    const otherPolicy = { ...results[4]!, runId: "other-policy", configuration: { ...results[4]!.configuration, outcomePolicy: { ...results[4]!.configuration.outcomePolicy!, isolation: "optional" as const } } };
    const report = compareResults([...inputs, { path: "other-policy.json", content: stableJson(otherPolicy) }, { path: "v2.json", content: stableJson({ ...results[0], schemaVersion: 2 }) }]);
    expect(report.runs.find((entry) => entry.artifact.path === "other-policy.json")).toMatchObject({ status: "non-comparable", reasons: ["outcome policy differs from the first comparable run of this harness"] });
    expect(report.runs.find((entry) => entry.artifact.path === "v2.json")).toMatchObject({ status: "invalid", reasons: [expect.stringContaining("is not 3")] });
    expect(report.harnesses.map((score) => [score.configuration, score.harness])).toEqual([["A", "no-ways"], ["B", "checks-only"], ["C", "lightweight-state"], ["D", "full-sdd"], ["E", "outcome"]]);
    const [a, , c, , e] = report.harnesses;
    expect(a).toMatchObject({ taskSuccess: { count: 6, trials: 6, rate: 1, interval95: wilsonInterval(6, 6) }, harnessCompliance: { applicable: false }, assurance: { completedWithoutSuccess: null } });
    expect(c?.harnessCompliance).toMatchObject({ applicable: true, workflow: "quick-evidence", compliant: { count: 0, trials: 6 } });
    expect(e).toMatchObject({ outcomePolicy: { isolation: "required", evaluation: "independent" }, harnessCompliance: { workflow: "outcome", completed: { count: 0 } }, assurance: { complianceIssues: { "eval-outcome-not-closed": 6, "eval-uncommitted-changes": 6 } } });
    expect(e?.byKind).toMatchObject({ "concurrent-conflict": { succeeded: 1, trials: 1 }, "failed-evaluation-remediation": { succeeded: 1, trials: 1 } });
    expect(e?.metrics.humanApprovals).toMatchObject({ total: 0, available: 6 });
    expect(a?.metrics.humanApprovals).toMatchObject({ total: null, unavailable: 6 });
    expect(e?.time.medianTaskMs).toEqual(expect.any(Number));
    expect(report.matrix).toHaveLength(6);
    expect(report.matrix.find((row) => row.taskId === "remediate-slug")?.harnesses).toMatchObject({ "no-ways": { succeeded: 1, trials: 1, compliant: null }, outcome: { succeeded: 1, trials: 1, compliant: 0 } });
    expect(report.tasks).toHaveLength(30);
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
      expect(await run(["evals", "run", "--adapter=fake", "--harness=outcome", "--evaluation=self", "--parallel=disabled", `--corpus=${join(cwd, "corpus.json")}`, "--output=e.json"], cwd)).toBe(0);
      const result = JSON.parse(await readFile(join(cwd, "e.json"), "utf8")) as EvalRunResult;
      expect(result.configuration.outcomePolicy).toEqual({ isolation: "required", parallel: "disabled", evaluation: "self", memory: "normal" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
