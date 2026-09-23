import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { run } from "../src/cli.js";
import type { NamedChecksConfig, OutcomeEvaluation } from "../src/domain/types.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import { loadState } from "../src/state/store.js";
import { closeOutcome, evaluateOutcome, openOutcome, outcomeCheckFailurePath, outcomeEvaluationPath, outcomeEvidencePath, remediateOutcome } from "../src/work/outcome.js";
import { contractResultsFailure } from "../src/work/outcome-evaluation.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const node = (script: string): string[] => [process.execPath, "-e", script];
const HELLO = "process.exit(require('node:fs').existsSync('feature.txt') && require('node:fs').readFileSync('feature.txt','utf8') === 'hello\\n' ? 0 : 1)";
const COMMANDS: NamedChecksConfig = { test: node("process.exit(0)"), lint: node(HELLO), typecheck: node("process.exit(0)"), required: ["test", "lint", "typecheck"] };
const CRITERIA = [{ id: "AC1", text: "feature.txt says hello" }, { id: "AC2", text: "lint passes" }];
const EVIDENCE = { AC1: { summary: "feature.txt contains hello" }, AC2: { summary: "lint", checks: ["lint"] } };

async function repository(commands: NamedChecksConfig = COMMANDS): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-outcome-checks-"));
  created.push(cwd);
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: node("process.exit(0)"), commands });
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "bootstrap"]);
  return { cwd, git };
}

async function executeTask(cwd: string, content: string, id = "feature", attempt = 0): Promise<void> {
  await addTask(cwd, id, "Write the feature");
  const task = await prepareTask(cwd, id);
  await writeFile(join(task.worktree!, "feature.txt"), content);
  const commit = await new GitRepository(task.worktree!).commit(["feature.txt"], `feat: ${id}`, { work: "hello", task: id, ...(attempt > 0 ? { attempt: String(attempt) } : {}) });
  await integrateTask(cwd, id, [commit]);
}

async function writeEvidence(cwd: string, attempt = 0, criteria: Record<string, unknown> = EVIDENCE): Promise<void> {
  await writeFile(join(cwd, outcomeEvidencePath("hello", attempt)), JSON.stringify({ schemaVersion: 1, workId: "hello", attempt, criteria }));
}

async function review(cwd: string, attempt = 0): Promise<void> {
  const path = join(cwd, ".ways", "runtime", "review.json");
  await mkdir(join(cwd, ".ways", "runtime"), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer: "independent", digest: await reviewDigest(cwd), verdict: "pass", findings: [], ...(attempt > 0 ? { attempt } : {}) }));
  await submitReview(cwd, path);
}

async function output(action: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  const code = await action();
  vi.restoreAllMocks();
  return { code, text: lines.join("\n") };
}

/** Rewrites a file of the certified execution behind the harness, keeping its trailers. */
async function forgeExecution(git: GitRepository, cwd: string, path: string, edit: (value: Record<string, unknown>) => void): Promise<void> {
  const value = JSON.parse(await readFile(join(cwd, path), "utf8")) as Record<string, unknown>;
  edit(value);
  await writeFile(join(cwd, path), JSON.stringify(value));
  await git.run(["add", path]);
  await git.run(["commit", "-q", "--amend", "--no-verify", "-C", "HEAD"]);
}

describe("outcome evaluation against the environment check contract", () => {
  it("passes an increment with multiple named checks, persisting the contract and reporting each result", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd, "hello\n");
    await writeEvidence(cwd);
    const evaluated = await output(() => run(["outcome", "evaluate"], cwd));
    expect(evaluated.code).toBe(0);
    expect(evaluated.text).toMatch(/test: passed \(exit 0\)/);
    expect(evaluated.text).toMatch(/lint: passed \(exit 0\)/);
    expect(evaluated.text).toMatch(/typecheck: passed \(exit 0\)/);
    expect(evaluated.text).toMatch(/build: skipped/);

    const evaluation = JSON.parse(await readFile(join(cwd, outcomeEvaluationPath("hello")), "utf8")) as OutcomeEvaluation;
    const config = JSON.parse(await git.run(["show", `${evaluation.inputCommit}:.ways/config.json`])) as { testCommand: string[]; commands: NamedChecksConfig };
    expect(evaluation.contract).toEqual({ testCommand: config.testCommand, commands: config.commands });
    expect(evaluation.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluation.checks.named?.map(({ name, status }) => [name, status])).toEqual([
      ["test", "passed"], ["lint", "passed"], ["typecheck", "passed"], ["build", "skipped"], ["e2e", "skipped"],
    ]);
    await review(cwd);
    await closeOutcome(cwd);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("blocks a failing required check although the evidence claims every criterion, then passes after remediation", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd, "bye\n");
    // The agent claims all criteria without citing the failing check.
    await writeEvidence(cwd, 0, { AC1: { summary: "done" }, AC2: { summary: "done" } });
    const failed = await run(["outcome", "evaluate"], cwd).then(() => "", (error: Error) => error.message);
    expect(failed).toMatch(/Evaluation failed and was recorded/);
    expect(failed).toMatch(/lint: failed \(exit 1\)/);
    expect(failed).toMatch(/test: passed \(exit 0\)/);
    expect(failed).toMatch(/typecheck: passed \(exit 0\)/);
    const record = JSON.parse(await readFile(join(cwd, outcomeCheckFailurePath("hello", 0)), "utf8"));
    expect(record.commands).toEqual(COMMANDS);
    expect(record.checks.named.find((check: { name: string }) => check.name === "lint")).toMatchObject({ status: "failed", exitCode: 1 });
    expect((await loadState(cwd))?.stage).toBe("execute");
    await expect(closeOutcome(cwd)).rejects.toThrow(/is in execute/);

    await remediateOutcome(cwd, "lint wants hello");
    await executeTask(cwd, "hello\n", "fix", 1);
    const { evaluation } = await evaluateOutcome(cwd);
    expect(evaluation).toMatchObject({ attempt: 1, passed: true, contract: { commands: COMMANDS } });
    await review(cwd, 1);
    await closeOutcome(cwd);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("blocks a required check that has no command", async () => {
    const { cwd } = await repository({ test: node("process.exit(0)"), required: ["test", "e2e"] });
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd, "hello\n");
    await writeEvidence(cwd, 0, { AC1: { summary: "done" }, AC2: { summary: "done" } });
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/e2e: unavailable/);
  });

  it("invalidates the evaluation when its results, commands or evidence no longer match", async () => {
    for (const [forge, expected] of [
      [(value: Record<string, unknown>) => {
        const checks = value.checks as OutcomeEvaluation["checks"];
        checks.named = checks.named!.map((check) => check.name === "lint" ? { ...check, status: "failed", exitCode: 1 } : check);
      }, /required check lint did not pass/],
      [(value: Record<string, unknown>) => {
        (value.contract as { commands: NamedChecksConfig }).commands.required = ["test"];
      }, /check commands changed after evaluation/],
      [(value: Record<string, unknown>) => { delete value.contract; }, /does not record its check contract/],
    ] as const) {
      const { cwd, git } = await repository();
      await openOutcome(cwd, "hello", "Say hello", CRITERIA);
      await executeTask(cwd, "hello\n");
      await writeEvidence(cwd);
      await evaluateOutcome(cwd);
      await forgeExecution(git, cwd, outcomeEvaluationPath("hello"), forge);
      await review(cwd);
      await expect(closeOutcome(cwd)).rejects.toThrow(expected);
    }

    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd, "hello\n");
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await forgeExecution(git, cwd, outcomeEvidencePath("hello"), (value) => {
      (value.criteria as Record<string, { summary: string }>).AC1!.summary = "rewritten after evaluation";
    });
    await review(cwd);
    await expect(closeOutcome(cwd)).rejects.toThrow(/criterion evidence changed after evaluation/);
    // A forced close is caught by the history audit with the same binding rules.
    await git.run(["add", "-A"]);
    await git.run(["rm", "-q", "--cached", ".ways/state/current.json"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged close", "-m", "Harness-Work: hello\nHarness-Phase: outcome-close\nHarness-State: completed"]);
    const issues = await checkHistory(cwd);
    expect(issues.find((issue) => issue.code === "history-invalid-outcome-evidence")?.message).toMatch(/criterion evidence changed after evaluation/);
  });

  it("refuses close when the configured commands change after evaluation", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd, "hello\n");
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await review(cwd);
    const configPath = join(cwd, ".ways", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { commands: NamedChecksConfig };
    config.commands.required = ["test"];
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await expect(closeOutcome(cwd)).rejects.toThrow(/need a new evaluation: \.ways\/config\.json/);
    // Committing the change behind the harness does not help: the evaluation no longer certifies HEAD.
    await git.run(["add", ".ways/config.json"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "relax checks", "-m", "Harness-Work: hello"]);
    await expect(closeOutcome(cwd)).rejects.toThrow();
    expect((await loadState(cwd))?.stage).toBe("evaluate");
  });

  it("requires every required check of the contract to pass with the contract's command", () => {
    const contract = { testCommand: node("process.exit(0)"), commands: COMMANDS };
    const passed = (name: "test" | "lint" | "typecheck") => ({ name, status: "passed" as const, command: COMMANDS[name]!, exitCode: 0 });
    expect(contractResultsFailure(contract, { integrity: [], named: [passed("test"), passed("lint"), passed("typecheck")] })).toBeUndefined();
    expect(contractResultsFailure(contract, { integrity: [], named: [passed("test"), passed("lint")] })).toMatch(/typecheck is missing/);
    expect(contractResultsFailure(contract, { integrity: [], named: [passed("test"), { ...passed("lint"), command: node("process.exit(0)") }, passed("typecheck")] }))
      .toMatch(/lint did not run the contract's command/);
    expect(contractResultsFailure({ testCommand: node("process.exit(0)") }, { integrity: [], testExitCode: 0 })).toBeUndefined();
    expect(contractResultsFailure({ testCommand: node("process.exit(0)") }, { integrity: [], testExitCode: 1 })).toMatch(/passing test command/);
  });
});
