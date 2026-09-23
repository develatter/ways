import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { diagnose } from "../src/repair/repair.js";
import { readStatus } from "../src/state/status.js";
import { loadState } from "../src/state/store.js";
import { cancelOutcome, closeOutcome, evaluateOutcome, openOutcome, outcomeEvidencePath, outcomeReviewPath } from "../src/work/outcome.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

async function repository(test = "process.exit(0)"): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-outcome-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: [process.execPath, "-e", test] });
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "bootstrap"]);
  return { cwd, git };
}

const CRITERIA = [{ id: "AC1", text: "feature.txt says hello" }, { id: "AC2", text: "checks pass" }];

async function executeTask(cwd: string, content = "hello\n"): Promise<void> {
  await addTask(cwd, "feature", "Write the feature");
  const task = await prepareTask(cwd, "feature");
  const worktree = new GitRepository(task.worktree!);
  await writeFile(join(task.worktree!, "feature.txt"), content);
  const commit = await worktree.commit(["feature.txt"], "feat: hello", { work: "hello", task: "feature" });
  await integrateTask(cwd, "feature", [commit]);
}

async function writeEvidence(cwd: string, criteria: Record<string, unknown> = { AC1: { summary: "feature.txt contains hello" }, AC2: { summary: "test check", checks: ["test"] } }): Promise<void> {
  await writeFile(join(cwd, outcomeEvidencePath("hello")), JSON.stringify({ schemaVersion: 1, workId: "hello", attempt: 0, criteria }));
}

async function review(cwd: string, verdict: "pass" | "fail" = "pass"): Promise<void> {
  const path = join(cwd, ".ways", "runtime", "review.json");
  await mkdir(join(cwd, ".ways", "runtime"), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer: "independent", digest: await reviewDigest(cwd), verdict, findings: [] }));
  await submitReview(cwd, path);
}

describe("outcome workflow", () => {
  it("opens, executes in isolation, evaluates and closes one increment", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    expect(await readStatus(cwd)).toMatchObject({ mode: "outcome", id: "hello", stage: "execute" });
    expect((await diagnose(cwd)).consistent).toBe(true);
    await executeTask(cwd);
    await writeEvidence(cwd);
    const { evaluation } = await evaluateOutcome(cwd);
    expect(evaluation).toMatchObject({ passed: true, checks: { testExitCode: 0 } });
    expect(await readStatus(cwd)).toMatchObject({ stage: "evaluate" });
    expect(await checkIntegrity(cwd)).toEqual([]);
    await review(cwd);
    await closeOutcome(cwd);

    expect(await loadState(cwd)).toBeUndefined();
    expect(await readStatus(cwd)).toMatchObject({ active: false });
    expect(await git.status()).toEqual([]);
    expect((await git.run(["log", "--format=%s", "-4"])).split("\n")).toEqual(["outcome(close): complete hello", "outcome(execute): complete hello", "feat: hello", "outcome(open): hello"]);
    expect(await checkHistory(cwd)).toEqual([]);
    expect(await readFile(join(cwd, outcomeReviewPath("hello")), "utf8")).toContain("independent");
  });

  it("refuses a premature done claim: missing evidence, failing checks, missing or stale review", async () => {
    const { cwd } = await repository("process.exit(require('node:fs').existsSync('feature.txt') && require('node:fs').readFileSync('feature.txt','utf8') === 'hello\\n' ? 0 : 1)");
    await expect(openOutcome(cwd, "hello", "Say hello", [])).rejects.toThrow(/acceptance criteria/);
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Isolation is required/);
    await expect(closeOutcome(cwd)).rejects.toThrow(/is in execute/);
    await executeTask(cwd, "bye\n");
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Map every acceptance criterion.*AC1 has no evidence summary/);
    await writeEvidence(cwd, { AC1: { summary: "done" } });
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/missing criteria: AC2/);
    await writeEvidence(cwd);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Evaluation failed/);
    expect((await loadState(cwd))?.stage).toBe("execute");
  });

  it("blocks close on a failing or stale review and freezes the evaluated increment", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd);
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await expect(closeOutcome(cwd)).rejects.toThrow(/independent review is required/);
    await review(cwd, "fail");
    await expect(closeOutcome(cwd)).rejects.toThrow(/review blocked by: verdict/);
    await writeFile(join(cwd, "feature.txt"), "changed\n");
    await expect(closeOutcome(cwd)).rejects.toThrow(/need a new evaluation/);
    await git.run(["checkout", "--", "feature.txt"]);
    await expect(git.commit(["feature.txt"], "sneak", { work: "hello", task: "feature" })).rejects.toThrow();
  });

  it("rejects direct production commits, skipped transitions and tampered evidence", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await writeFile(join(cwd, "direct.txt"), "direct\n");
    await expect(git.commit(["direct.txt"], "direct", { work: "hello" })).rejects.toThrow(/isolation is required/);
    await expect(git.commit(["direct.txt"], "skip", { work: "hello", phase: "outcome-close", state: "completed" })).rejects.toThrow();

    // A --no-verify direct commit and a forged close are caught by the history audit.
    await git.run(["add", "direct.txt"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "direct", "-m", "Harness-Work: hello"]);
    expect((await checkHistory(cwd)).map((issue) => issue.code)).toContain("history-outcome-broken-chain");
    await git.run(["rm", "-q", "--cached", ".ways/state/current.json"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged close", "-m", "Harness-Work: hello\nHarness-Phase: outcome-close\nHarness-State: completed"]);
    expect((await checkHistory(cwd)).map((issue) => issue.code)).toContain("history-outcome-broken-chain");
  });

  it("detects a forged no-verify close whose evidence does not cover the criteria", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd);
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await review(cwd);
    // Forge: rewrite the committed evidence and criteria behind the harness, then close with --no-verify.
    await writeFile(join(cwd, ".ways/outcomes/hello/outcome.json"), JSON.stringify({ schemaVersion: 1, workId: "hello", goal: "Say hello", criteria: [CRITERIA[0]], policy: { isolation: "required", independentEvaluation: "required", checks: "configured" } }));
    await git.run(["add", "-A"]);
    await git.run(["rm", "-q", "--cached", ".ways/state/current.json"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged", "-m", "Harness-Work: hello\nHarness-Phase: outcome-close\nHarness-State: completed"]);
    expect((await checkHistory(cwd)).map((issue) => issue.code)).toContain("history-invalid-outcome-evidence");
  });

  it("cancels an outcome with a traced commit", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await cancelOutcome(cwd);
    expect(await loadState(cwd)).toBeUndefined();
    expect(await git.status()).toEqual([]);
    expect(await checkHistory(cwd)).toEqual([]);
  });
});
