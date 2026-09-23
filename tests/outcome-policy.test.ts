import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { run } from "../src/cli.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { diagnose } from "../src/repair/repair.js";
import { loadState, saveState } from "../src/state/store.js";
import { closeOutcome, evaluateOutcome, openOutcome, outcomeEvidencePath, outcomeSpecPath } from "../src/work/outcome.js";
import { effectiveExecutionPolicy, executionPolicyInvalid, parseExecutionPolicy } from "../src/work/outcome-policy.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-outcome-policy-"));
  created.push(cwd);
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "bootstrap"]);
  return { cwd, git };
}

const CRITERIA = [{ id: "AC1", text: "feature.txt says hello" }];

async function writeEvidence(cwd: string): Promise<void> {
  await writeFile(join(cwd, outcomeEvidencePath("hello")), JSON.stringify({ schemaVersion: 1, workId: "hello", attempt: 0, criteria: { AC1: { summary: "feature.txt contains hello" } } }));
}

async function review(cwd: string): Promise<void> {
  const path = join(cwd, ".ways", "runtime", "review.json");
  await mkdir(join(cwd, ".ways", "runtime"), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer: "independent", digest: await reviewDigest(cwd), verdict: "pass", findings: [] }));
  await submitReview(cwd, path);
}

async function spec(cwd: string): Promise<{ policy: Record<string, unknown> }> {
  return JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")) as { policy: Record<string, unknown> };
}

function guard(cwd: string, payload: Record<string, unknown>): number {
  try {
    execFileSync("sh", [join(cwd, ".claude/ways-guard.sh")], { cwd, input: JSON.stringify({ cwd, ...payload }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

describe("outcome execution policies", () => {
  it("defaults to required isolation and allowed parallelism", async () => {
    expect(effectiveExecutionPolicy()).toEqual({ isolation: "required", parallel: "allowed" });
    expect(executionPolicyInvalid({ isolation: "required" })).toBe(false);
    expect(executionPolicyInvalid({ isolation: "optional", parallel: "disabled" })).toBe(false);
    expect(executionPolicyInvalid({ isolation: "none" })).toBe(true);
    expect(executionPolicyInvalid({ isolation: "required", parallel: "sometimes" })).toBe(true);
    expect(parseExecutionPolicy(["--isolation=optional", "--parallel=disabled"])).toEqual({ isolation: "optional", parallel: "disabled" });
    expect(() => parseExecutionPolicy(["--isolation=maybe"])).toThrow(/--isolation/);
    expect(() => parseExecutionPolicy(["--parallel=never"])).toThrow(/--parallel/);

    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    expect((await spec(cwd)).policy).toMatchObject({ isolation: "required", parallel: "allowed" });
    // Parallel tasks are allowed by default.
    await addTask(cwd, "a", "A");
    await addTask(cwd, "b", "B");
    await prepareTask(cwd, "a");
    await prepareTask(cwd, "b");
    expect((await diagnose(cwd)).consistent).toBe(true);
    // Direct commits need a task under required isolation.
    await writeFile(join(cwd, "direct.txt"), "direct\n");
    await expect(git.commit(["direct.txt"], "direct", { work: "hello" })).rejects.toThrow(/isolation is required/);
  });

  it("reads a spec opened before parallelism policies existed as allowed", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    const legacy = await spec(cwd);
    delete legacy.policy.parallel;
    await writeFile(join(cwd, outcomeSpecPath("hello")), JSON.stringify(legacy));
    await git.run(["commit", "-q", "--amend", "--no-edit", "--no-verify", "--", outcomeSpecPath("hello")]);
    expect(JSON.parse(await git.run(["show", `HEAD:${outcomeSpecPath("hello")}`])).policy.parallel).toBeUndefined();
    await addTask(cwd, "a", "A");
    await addTask(cwd, "b", "B");
    await prepareTask(cwd, "a");
    await prepareTask(cwd, "b");
    expect((await diagnose(cwd)).consistent).toBe(true);
  });

  it("persists CLI-selected policies in the committed spec", async () => {
    const { cwd } = await repository();
    await expect(run(["outcome", "open", "hello", "--goal=Say hello", "--criterion=AC1:x", "--isolation=maybe"], cwd)).rejects.toThrow(/--isolation/);
    expect(await loadState(cwd)).toBeUndefined();
    await run(["outcome", "open", "hello", "--goal=Say hello", "--criterion=AC1:x", "--isolation=optional", "--parallel=disabled"], cwd);
    const git = new GitRepository(cwd);
    const committed = JSON.parse(await git.run(["show", `HEAD:${outcomeSpecPath("hello")}`])) as { policy: Record<string, unknown> };
    expect(committed.policy).toMatchObject({ isolation: "optional", parallel: "disabled" });
  });

  it("optional isolation accepts traced direct implementation through evaluate, close and history", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", { isolation: "optional" });
    await writeFile(join(cwd, "feature.txt"), "hello\n");
    await git.commit(["feature.txt"], "feat: direct", { work: "hello" });
    await writeEvidence(cwd);
    const { evaluation } = await evaluateOutcome(cwd);
    expect(evaluation.passed).toBe(true);
    expect(await checkIntegrity(cwd)).toEqual([]);
    await review(cwd);
    await closeOutcome(cwd);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("optional isolation still rejects a forged task trailer and untraced commits", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", { isolation: "optional" });
    await writeFile(join(cwd, "feature.txt"), "hello\n");
    await git.run(["add", "feature.txt"]);
    await expect(git.run(["commit", "-q", "-m", "untraced"])).rejects.toThrow(/Harness-Work: hello/);
    await git.commit(["feature.txt"], "claims a task", { work: "hello", task: "ghost" });
    await writeEvidence(cwd);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Isolation is optional: .*neither a traced direct commit nor an integrated task/);
  });

  it("binds the policy to the opening commit so disk or later edits cannot weaken it", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    const weakened = await spec(cwd);
    weakened.policy.isolation = "optional";
    await writeFile(join(cwd, outcomeSpecPath("hello")), JSON.stringify(weakened));
    await writeFile(join(cwd, "direct.txt"), "direct\n");
    await expect(git.commit(["direct.txt", outcomeSpecPath("hello")], "direct", { work: "hello" })).rejects.toThrow(/isolation is required/);
    // A no-verify direct commit is caught by evaluate and by the history audit.
    await git.run(["add", "direct.txt", outcomeSpecPath("hello")]);
    await git.run(["commit", "-q", "--no-verify", "-m", "direct", "-m", "Harness-Work: hello"]);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/Isolation is required/);
    expect((await checkHistory(cwd)).map((issue) => issue.message).join("\n")).toMatch(/requires isolation/);
  });

  it("disabled parallelism rejects preparing a second task until the first is integrated", async () => {
    const { cwd } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA, "normal", { parallel: "disabled" });
    await addTask(cwd, "a", "A");
    await addTask(cwd, "b", "B");
    const a = await prepareTask(cwd, "a");
    await expect(prepareTask(cwd, "b")).rejects.toThrow(/Parallelism is disabled for hello: integrate a before preparing b/);
    const worktree = new GitRepository(a.worktree!);
    await writeFile(join(a.worktree!, "a.txt"), "a\n");
    const commit = await worktree.commit(["a.txt"], "feat: a", { work: "hello", task: "a" });
    await integrateTask(cwd, "a", [commit]);
    await prepareTask(cwd, "b");
    expect((await diagnose(cwd)).consistent).toBe(true);

    // Integrity refuses a state that holds concurrent tasks anyway.
    const state = (await loadState(cwd))!;
    await saveState(cwd, { ...state, tasks: state.tasks.map((task) => task.id === "a" ? { ...task, status: "active" as const } : task) });
    expect(await diagnose(cwd)).toMatchObject({ consistent: false, message: expect.stringMatching(/Parallelism is disabled for hello but tasks run concurrently: a, b/) });
    expect(await checkIntegrity(cwd)).not.toEqual([]);
  });

  it("the provider guard follows the committed isolation policy", async () => {
    const required = await repository();
    await openOutcome(required.cwd, "hello", "Say hello", CRITERIA);
    expect(guard(required.cwd, { tool_name: "Write", tool_input: { file_path: join(required.cwd, "src.ts") } })).toBe(2);
    expect(guard(required.cwd, { tool_name: "Bash", tool_input: { command: "printf bad > src.ts" } })).toBe(2);
    expect(guard(required.cwd, { tool_name: "Write", tool_input: { file_path: join(required.cwd, outcomeEvidencePath("hello")) } })).toBe(0);
    expect(guard(required.cwd, { tool_name: "Bash", tool_input: { command: `printf x > ${outcomeEvidencePath("hello")}` } })).toBe(0);
    expect(guard(required.cwd, { tool_name: "Bash", tool_input: { command: "npx ways task add a --title=A" } })).toBe(0);
    await addTask(required.cwd, "a", "A");
    const task = await prepareTask(required.cwd, "a");
    expect(guard(task.worktree!, { tool_name: "Write", tool_input: { file_path: join(task.worktree!, "src.ts") } })).toBe(0);

    const optional = await repository();
    await openOutcome(optional.cwd, "hello", "Say hello", CRITERIA, "normal", { isolation: "optional" });
    expect(guard(optional.cwd, { tool_name: "Write", tool_input: { file_path: join(optional.cwd, "src.ts") } })).toBe(0);
    expect(guard(optional.cwd, { tool_name: "Bash", tool_input: { command: "printf ok > src.ts" } })).toBe(0);
  });
});
