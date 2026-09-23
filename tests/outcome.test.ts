import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { diagnose } from "../src/repair/repair.js";
import { readStatus } from "../src/state/status.js";
import { loadState } from "../src/state/store.js";
import { cancelOutcome, closeOutcome, evaluateOutcome, openOutcome, outcomeCheckFailurePath, outcomeEvidencePath, outcomeRemediationPath, outcomeReviewPath, remediateOutcome } from "../src/work/outcome.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(test = "process.exit(0)"): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-outcome-"));
  created.push(cwd);
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

async function executeTask(cwd: string, content = "hello\n", id = "feature", attempt = 0): Promise<void> {
  await addTask(cwd, id, "Write the feature");
  const task = await prepareTask(cwd, id);
  const worktree = new GitRepository(task.worktree!);
  await writeFile(join(task.worktree!, "feature.txt"), content);
  const commit = await worktree.commit(["feature.txt"], `feat: ${id}`, { work: "hello", task: id, ...(attempt > 0 ? { attempt: String(attempt) } : {}) });
  await integrateTask(cwd, id, [commit]);
}

async function writeEvidence(cwd: string, criteria: Record<string, unknown> = { AC1: { summary: "feature.txt contains hello" }, AC2: { summary: "test check", checks: ["test"] } }): Promise<void> {
  await writeFile(join(cwd, outcomeEvidencePath("hello")), JSON.stringify({ schemaVersion: 1, workId: "hello", attempt: 0, criteria }));
}

async function review(cwd: string, verdict: "pass" | "fail" = "pass", attempt = 0): Promise<void> {
  const path = join(cwd, ".ways", "runtime", "review.json");
  await mkdir(join(cwd, ".ways", "runtime"), { recursive: true });
  const findings = verdict === "fail" ? [{ id: "F1", severity: "high", summary: "wrong greeting", disposition: "open" }] : [];
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer: "independent", digest: await reviewDigest(cwd), verdict, findings, ...(attempt > 0 ? { attempt } : {}) }));
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
    expect((await git.run(["log", "--format=%s", "-4"])).split("\n")).toEqual(["outcome(close): complete hello", "outcome(execute): complete hello", "feat: feature", "outcome(open): hello"]);
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
    await expect(closeOutcome(cwd)).rejects.toThrow(/review blocked by: F1/);
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

describe("outcome review fixes", () => {
  it("rejects a forged task trailer that was never integrated", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd);
    await writeFile(join(cwd, "bogus.txt"), "direct\n");
    await git.commit(["bogus.txt"], "bogus", { work: "hello", task: "bogus" });
    await writeEvidence(cwd);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/not integrated from an isolated task/);
  });

  it("re-runs checks at close and refuses a re-opening transition", async () => {
    const { cwd, git } = await repository("process.exit(require('node:fs').existsSync('fail') ? 1 : 0)");
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await expect(git.run(["commit", "-q", "--allow-empty", "-m", "reopen", "-m", "Harness-Work: hello\nHarness-Phase: outcome-open\nHarness-State: opened"])).rejects.toThrow(/already open/);
    await executeTask(cwd);
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await review(cwd);
    // An ignored file flips the configured check without changing the evaluated tree.
    await writeFile(join(cwd, ".git", "info", "exclude"), "fail\n");
    await writeFile(join(cwd, "fail"), "");
    await expect(closeOutcome(cwd)).rejects.toThrow(/checks fail on the evaluated input/);
  });
});

describe("outcome remediation", () => {
  const HELLO_TEST = "process.exit(require('node:fs').existsSync('feature.txt') && require('node:fs').readFileSync('feature.txt','utf8') === 'hello\\n' ? 0 : 1)";

  it("records failed checks and remediates them additively in a new attempt", async () => {
    const { cwd, git } = await repository(HELLO_TEST);
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await expect(remediateOutcome(cwd, "nothing failed")).rejects.toThrow(/recorded evaluation failure at HEAD/);
    await executeTask(cwd, "bye\n");
    await writeEvidence(cwd);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Evaluation failed and was recorded/);
    expect((await git.run(["log", "-1", "--format=%(trailers:key=Harness-State,valueonly)"])).trim()).toBe("outcome-evaluation-failed");
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/recorded evaluation failure/);
    await expect(remediateOutcome(cwd, " ")).rejects.toThrow(/reason is required/);
    await remediateOutcome(cwd, "feature.txt says bye");
    expect(await loadState(cwd)).toMatchObject({ attempt: 1, stage: "execute" });
    expect(await checkIntegrity(cwd)).toEqual([]);
    expect((await diagnose(cwd)).consistent).toBe(true);

    await executeTask(cwd, "hello\n", "fix", 1);
    const { evaluation } = await evaluateOutcome(cwd);
    expect(evaluation).toMatchObject({ attempt: 1, passed: true });
    await review(cwd, "pass", 1);
    await closeOutcome(cwd);
    expect(await git.status()).toEqual([]);
    expect(await checkHistory(cwd)).toEqual([]);
    expect(JSON.parse(await readFile(join(cwd, outcomeCheckFailurePath("hello", 0)), "utf8"))).toMatchObject({ attempt: 0 });
    expect(JSON.parse(await readFile(join(cwd, outcomeRemediationPath("hello", 1)), "utf8"))).toMatchObject({ evidence: { kind: "validate" } });
  });

  it("remediates a blocking review and needs a fresh review of the new attempt", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd, "bye\n");
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await review(cwd, "pass");
    await expect(remediateOutcome(cwd, "looks fine")).rejects.toThrow(/review passes/);
    await review(cwd, "fail");
    await remediateOutcome(cwd, "reviewer wants hello");
    expect(await loadState(cwd)).toMatchObject({ attempt: 1, stage: "execute" });

    await executeTask(cwd, "hello\n", "fix", 1);
    await evaluateOutcome(cwd);
    // The attempt-0 review cannot be reused for attempt 1.
    await expect(review(cwd, "pass")).rejects.toThrow(/attempt/);
    await expect(closeOutcome(cwd)).rejects.toThrow(/independent review is required/);
    await review(cwd, "pass", 1);
    await closeOutcome(cwd);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("keeps earlier attempts immutable and detects forged transitions", async () => {
    const { cwd, git } = await repository(HELLO_TEST);
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await executeTask(cwd, "bye\n");
    await writeEvidence(cwd);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/recorded/);
    await remediateOutcome(cwd, "feature.txt says bye");

    // The hook refuses rewriting attempt 0; a no-verify rewrite fails the audit.
    await writeFile(join(cwd, outcomeCheckFailurePath("hello", 0)), "{}");
    await expect(git.commit([outcomeCheckFailurePath("hello", 0)], "rewrite", { work: "hello", task: "fix", attempt: "1" })).rejects.toThrow(/immutable/);
    await git.run(["add", outcomeCheckFailurePath("hello", 0)]);
    await git.run(["commit", "-q", "--no-verify", "-m", "rewrite", "-m", "Harness-Work: hello\nHarness-Task: fix\nHarness-Attempt: 1"]);
    expect((await checkHistory(cwd)).map((issue) => issue.code)).toContain("history-invalid-outcome-evidence");
  });

  it("detects a forged no-verify remediation without a recorded failure", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    await git.run(["commit", "-q", "--allow-empty", "--no-verify", "-m", "forged", "-m", "Harness-Work: hello\nHarness-Phase: outcome-evaluate\nHarness-State: outcome-remediated\nHarness-Attempt: 1"]);
    const codes = (await checkHistory(cwd)).map((issue) => issue.code);
    expect(codes).toContain("history-outcome-broken-chain");
  });
});
