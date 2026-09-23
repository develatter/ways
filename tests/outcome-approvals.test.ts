import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { buildContext } from "../src/context/context.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import { loadState } from "../src/state/store.js";
import type { Terminal } from "../src/work/approve.js";
import { closeWork } from "../src/work/close.js";
import { approvalPolicyFailure, approveOutcomeInteractively, committedApprovalPolicy, outcomeApprovalPath, outcomeApprovalStatus, parseApprovalPolicy } from "../src/work/outcome-approvals.js";
import { closeOutcome, evaluateOutcome, openOutcome, outcomeEvidencePath, outcomeSpecPath, remediateOutcome } from "../src/work/outcome.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

const HELLO_TEST = "process.exit(require('node:fs').existsSync('feature.txt') && require('node:fs').readFileSync('feature.txt','utf8') === 'hello\\n' ? 0 : 1)";
const CRITERIA = [{ id: "AC1", text: "feature.txt says hello" }];

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-outcome-approvals-"));
  created.push(cwd);
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: [process.execPath, "-e", HELLO_TEST] });
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "bootstrap"]);
  return { cwd, git };
}

function terminal(interactive: boolean, answer: string): Terminal {
  return { interactive, ask: async () => answer, say: () => undefined };
}

async function execute(cwd: string, content: string, id: string, attempt = 0): Promise<void> {
  await addTask(cwd, id, "Write the feature");
  const task = await prepareTask(cwd, id);
  await writeFile(join(task.worktree!, "feature.txt"), content);
  const commit = await new GitRepository(task.worktree!).commit(["feature.txt"], `feat: ${id}`, { work: "hello", task: id, ...(attempt > 0 ? { attempt: String(attempt) } : {}) });
  await integrateTask(cwd, id, [commit]);
  await writeFile(join(cwd, outcomeEvidencePath("hello", attempt)), JSON.stringify({ schemaVersion: 1, workId: "hello", attempt, criteria: { AC1: { summary: "feature.txt" } } }));
}

async function review(cwd: string, verdict: "pass" | "fail", attempt = 0, reviewer = "independent"): Promise<void> {
  const path = join(cwd, ".ways", "runtime", "review.json");
  await mkdir(dirname(path), { recursive: true });
  const findings = verdict === "fail" ? [{ id: "F1", severity: "high", summary: "wrong greeting", disposition: "open" }] : [];
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer, digest: await reviewDigest(cwd), verdict, findings, ...(attempt > 0 ? { attempt } : {}) }));
  await submitReview(cwd, path);
}

describe("outcome approval policy", () => {
  it("parses and validates none, close and custom checkpoint lists", () => {
    expect(parseApprovalPolicy("none")).toEqual([]);
    expect(parseApprovalPolicy("close")).toEqual(["close"]);
    expect(parseApprovalPolicy("remediate, close")).toEqual(["close", "remediate"]);
    for (const invalid of ["", "evaluate", "close,close", "none,close", "close,"]) expect(() => parseApprovalPolicy(invalid)).toThrow(/--approvals must be/);
    expect(approvalPolicyFailure(undefined)).toBeUndefined();
    expect(approvalPolicyFailure([])).toMatch(/non-empty/);
    expect(approvalPolicyFailure(["remediate", "close"])).toMatch(/canonical/);
    expect(approvalPolicyFailure(["open"])).toMatch(/among close, remediate/);
  });

  it("persists the policy at open, defaults to none and rejects unsupported checkpoints", async () => {
    const { cwd, git } = await repository();
    await expect(openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", ["evaluate" as never])).rejects.toThrow(/unsupported policy/);
    await expect(execFileAsync(process.execPath, [process.env.WAYS_CLI!, "outcome", "open", "hello", "--goal=x", "--criterion=AC1:x", "--approvals=plan"], { cwd })).rejects.toThrow(/--approvals must be/);
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    expect(JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")).policy.approvals).toBeUndefined();
    expect(await committedApprovalPolicy(git, "hello")).toEqual([]);
    expect(await outcomeApprovalStatus(cwd, (await loadState(cwd))!)).toEqual({ policy: "none", checkpoints: [] });
  });
});

describe("outcome close approval", () => {
  it("blocks close until a human approves the exact reviewed input in a terminal", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", ["close"]);
    expect(JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")).policy.approvals).toEqual(["close"]);
    await expect(approveOutcomeInteractively(cwd, "close", terminal(true, "close"))).rejects.toThrow(/cannot take close from execute/);
    await execute(cwd, "hello\n", "feature");
    await evaluateOutcome(cwd);
    await review(cwd, "pass");

    await expect(closeOutcome(cwd)).rejects.toThrow(/close requires human approval .*`ways approve close` in their own terminal/);
    const status = await outcomeApprovalStatus(cwd, (await loadState(cwd))!);
    expect(status).toMatchObject({ policy: ["close"], checkpoints: [{ checkpoint: "close", status: "required", action: "ways approve close" }] });
    expect((await buildContext(cwd)).active?.outcome?.blockers).toContain("human approval of close required: ways approve close");
    const { stdout } = await execFileAsync(process.execPath, [process.env.WAYS_CLI!, "status"], { cwd });
    expect(stdout).toMatch(/Human action required: close requires human approval/);

    // Non-interactive calls, wrong answers and checkpoints outside the policy never approve.
    await expect(approveOutcomeInteractively(cwd, undefined, terminal(false, "close"))).rejects.toThrow(/interactive terminal/);
    await expect(execFileAsync(process.execPath, [process.env.WAYS_CLI!, "approve", "close"], { cwd })).rejects.toThrow(/interactive terminal/);
    await expect(approveOutcomeInteractively(cwd, undefined, terminal(true, "yes"))).rejects.toThrow(/cancelled/);
    await expect(approveOutcomeInteractively(cwd, "remediate", terminal(true, "remediate"))).rejects.toThrow(/does not require approval of remediate/);

    const record = await approveOutcomeInteractively(cwd, undefined, terminal(true, "close"));
    expect(record).toMatchObject({ workId: "hello", checkpoint: "close", attempt: 0, inputCommit: await git.head(), approvedBy: "Ways Test <ways@example.test>" });
    expect((await outcomeApprovalStatus(cwd, (await loadState(cwd))!)).checkpoints).toEqual([{ checkpoint: "close", status: "approved" }]);

    // Editing what close records after approval invalidates it.
    await review(cwd, "pass", 0, "someone else");
    await expect(closeOutcome(cwd)).rejects.toThrow(/content changed after approval of close/);
    await approveOutcomeInteractively(cwd, "close", terminal(true, "close"));
    const close = await closeOutcome(cwd);
    expect(await git.run(["show", "--name-only", "--format=", close])).toContain(outcomeApprovalPath("hello", 0, "close"));
    expect(await git.status()).toEqual([]);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("rejects closing commits without approval in the hook and the history audit, whatever the edited spec says", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", ["close"]);
    await execute(cwd, "hello\n", "feature");
    await evaluateOutcome(cwd);
    await review(cwd, "pass");

    // A downgrade edited into the working spec does not change the committed policy.
    const specPath = join(cwd, outcomeSpecPath("hello"));
    const spec = JSON.parse(await readFile(specPath, "utf8"));
    delete spec.policy.approvals;
    await writeFile(specPath, JSON.stringify(spec));
    expect(await committedApprovalPolicy(git, "hello")).toEqual(["close"]);
    await git.run(["checkout", "--", outcomeSpecPath("hello")]);

    // Bypassing the CLI still meets the commit hook.
    await expect(closeWork(cwd, "outcome(close): complete hello", { work: "hello", phase: "outcome-close", state: "completed" })).rejects.toThrow(/close requires human approval/);
    expect(await loadState(cwd)).toMatchObject({ stage: "evaluate" });

    // A forged approval or a no-verify close fails the history audit.
    await rm(join(cwd, ".ways", "state"), { recursive: true, force: true });
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged close", "-m", "Harness-Work: hello\nHarness-Phase: outcome-close\nHarness-State: completed"]);
    const issues = await checkHistory(cwd);
    expect(issues.map((issue) => issue.message).join("\n")).toMatch(/closed without valid human approval: close requires human approval/);
  });
});

describe("outcome remediate approval", () => {
  it("gates remediation per attempt and refuses reused approvals", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", ["close", "remediate"]);
    await execute(cwd, "bye\n", "feature");
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Evaluation failed and was recorded/);
    await expect(remediateOutcome(cwd, "says bye")).rejects.toThrow(/remediate requires human approval .*`ways approve remediate`/);
    expect((await buildContext(cwd)).active?.outcome?.blockers).toContain("human approval of remediate required: ways approve remediate");
    // Only remediate is reachable after a recorded failure, so it is chosen without naming it.
    const first = await approveOutcomeInteractively(cwd, undefined, terminal(true, "remediate"));
    expect(first).toMatchObject({ checkpoint: "remediate", attempt: 0 });
    const transition = await remediateOutcome(cwd, "says bye");
    expect(await git.run(["show", "--name-only", "--format=", transition])).toContain(outcomeApprovalPath("hello", 0, "remediate"));
    expect(await checkHistory(cwd)).toEqual([]);

    // Attempt 1 fails again; the attempt-0 approval cannot be reused for it.
    await execute(cwd, "still bye\n", "fix", 1);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Evaluation failed and was recorded/);
    await mkdir(dirname(join(cwd, outcomeApprovalPath("hello", 1, "remediate"))), { recursive: true });
    await copyFile(join(cwd, outcomeApprovalPath("hello", 0, "remediate")), join(cwd, outcomeApprovalPath("hello", 1, "remediate")));
    await expect(remediateOutcome(cwd, "still bye")).rejects.toThrow(/belongs to another work, checkpoint or attempt/);
    const forged = { ...first, attempt: 1 };
    await writeFile(join(cwd, outcomeApprovalPath("hello", 1, "remediate")), JSON.stringify(forged));
    await expect(remediateOutcome(cwd, "still bye")).rejects.toThrow(/given on another commit/);

    await approveOutcomeInteractively(cwd, "remediate", terminal(true, "remediate"));
    await remediateOutcome(cwd, "still bye");
    await execute(cwd, "hello\n", "final", 2);
    await evaluateOutcome(cwd);
    await review(cwd, "pass", 2);
    // With both checkpoints reachable in evaluate, the human names one.
    await expect(approveOutcomeInteractively(cwd, undefined, terminal(true, "close"))).rejects.toThrow(/ways approve close or ways approve remediate/);
    await approveOutcomeInteractively(cwd, "close", terminal(true, "close"));
    await closeOutcome(cwd);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("detects a no-verify remediation that skipped approval", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", ["remediate"]);
    await execute(cwd, "hello\n", "feature");
    await evaluateOutcome(cwd);
    await review(cwd, "fail");
    await approveOutcomeInteractively(cwd, undefined, terminal(true, "remediate"));
    // Editing the blocking review after approval invalidates it.
    await review(cwd, "fail", 0, "someone else");
    await expect(remediateOutcome(cwd, "wrong")).rejects.toThrow(/content changed after approval of remediate/);
    await approveOutcomeInteractively(cwd, undefined, terminal(true, "remediate"));
    await remediateOutcome(cwd, "wrong");

    // Replay the transition without its approval: the hook refuses it, the audit catches a no-verify one.
    const approval = outcomeApprovalPath("hello", 0, "remediate");
    await git.run(["reset", "-q", "--soft", "HEAD~1"]);
    await git.run(["rm", "-q", "--cached", approval]);
    await rm(join(cwd, approval));
    await expect(remediateOutcome(cwd, "wrong")).rejects.toThrow(/remediate requires human approval/);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged remediation", "-m", "Harness-Work: hello\nHarness-Phase: outcome-evaluate\nHarness-State: outcome-remediated\nHarness-Attempt: 1"]);
    const issues = await checkHistory(cwd);
    expect(issues.map((issue) => issue.message).join("\n")).toMatch(/remediated without valid human approval: remediate requires human approval/);
  });
});
