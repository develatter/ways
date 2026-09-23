import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { run } from "../src/cli.js";
import type { OutcomeSpec } from "../src/domain/types.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import { independentEvaluationRequired, reviewerProvenanceFailure } from "../src/work/outcome-evaluation-policy.js";
import { closeOutcome, evaluateOutcome, openOutcome, outcomeEvidencePath, outcomeReviewPath, outcomeSpecPath, remediateOutcome } from "../src/work/outcome.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

const IMPLEMENTER = "Ways Test";
const IMPLEMENTER_EMAIL = "ways@example.test";
const CRITERIA = [{ id: "AC1", text: "feature.txt says hello" }];
const CLOSE_TRAILERS = "Harness-Work: hello\nHarness-Phase: outcome-close\nHarness-State: completed";

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-evaluation-policy-"));
  created.push(cwd);
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", IMPLEMENTER]);
  await git.run(["config", "user.email", IMPLEMENTER_EMAIL]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "bootstrap"]);
  return { cwd, git };
}

async function executeTask(cwd: string, id = "feature", attempt = 0, files: Record<string, string> = { "feature.txt": "hello\n" }): Promise<void> {
  await addTask(cwd, id, "Write the feature");
  const task = await prepareTask(cwd, id);
  const worktree = new GitRepository(task.worktree!);
  for (const [path, content] of Object.entries(files)) await writeFile(join(task.worktree!, path), content);
  const commit = await worktree.commit(Object.keys(files), `feat: ${id}`, { work: "hello", task: id, ...(attempt > 0 ? { attempt: String(attempt) } : {}) });
  await integrateTask(cwd, id, [commit]);
}

async function writeEvidence(cwd: string, attempt = 0): Promise<void> {
  await writeFile(join(cwd, outcomeEvidencePath("hello", attempt)), JSON.stringify({ schemaVersion: 1, workId: "hello", attempt, criteria: { AC1: { summary: "feature.txt contains hello" } } }));
}

async function evaluated(evaluation: "independent" | "self" = "independent"): Promise<{ cwd: string; git: GitRepository }> {
  const repo = await repository();
  await openOutcome(repo.cwd, "hello", "Say hello", CRITERIA, "normal", evaluation);
  await executeTask(repo.cwd);
  await writeEvidence(repo.cwd);
  await evaluateOutcome(repo.cwd);
  return repo;
}

async function reviewFile(cwd: string, fields: Record<string, unknown> = {}): Promise<string> {
  const path = join(cwd, ".ways", "runtime", "review.json");
  await mkdir(join(cwd, ".ways", "runtime"), { recursive: true });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer: "independent", digest: await reviewDigest(cwd), verdict: "pass", findings: [], ...fields }));
  return path;
}

/** Writes a review straight to the recorded path, as an agent bypassing `ways review submit` would. */
async function plantReview(cwd: string, review: unknown, attempt = 0): Promise<void> {
  await mkdir(join(cwd, outcomeReviewPath("hello", attempt), ".."), { recursive: true });
  await writeFile(join(cwd, outcomeReviewPath("hello", attempt)), JSON.stringify(review));
}

async function forgeClose(git: GitRepository): Promise<string> {
  await git.run(["add", "-A"]);
  await git.run(["rm", "-q", ".ways/state/current.json"]);
  const hook = await git.run(["commit", "-q", "-m", "close", "-m", CLOSE_TRAILERS]).then(() => "accepted", (error: unknown) => String(error));
  if (hook === "accepted") throw new Error("the hook accepted a close it should refuse");
  await git.run(["commit", "-q", "--no-verify", "-m", "forged", "-m", CLOSE_TRAILERS]);
  return hook;
}

async function historyMessages(cwd: string): Promise<string> {
  return (await checkHistory(cwd)).map((issue) => issue.message).join("\n");
}

describe("evaluation policy selection", () => {
  it("defaults to independent and reads specs without the field as required", async () => {
    const { cwd } = await repository();
    expect(await run(["outcome", "open", "hello", "--goal=Say hello", "--criterion=AC1:hello", "--evaluation=peer"], cwd).catch((error: Error) => error.message)).toMatch(/independent or self/);
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    const spec = JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")) as OutcomeSpec;
    expect(spec.policy.independentEvaluation).toBe("required");
    expect(independentEvaluationRequired({ ...spec, policy: { isolation: "required", checks: "configured" } })).toBe(true);
    expect(independentEvaluationRequired({ ...spec, policy: { ...spec.policy, independentEvaluation: "optional" } })).toBe(false);
  });

  it("self: closes without a review, still after passing checks and complete evidence", async () => {
    const { cwd, git } = await repository();
    expect(await run(["outcome", "open", "hello", "--goal=Say hello", "--criterion=AC1:hello", "--evaluation=self"], cwd)).toBe(0);
    expect((JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")) as OutcomeSpec).policy.independentEvaluation).toBe("optional");
    await executeTask(cwd);
    await expect(evaluateOutcome(cwd)).rejects.toThrow(/AC1 has no evidence summary/);
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await closeOutcome(cwd);
    expect(await git.status()).toEqual([]);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("self: accepts a review by the implementer but a recorded blocking review still blocks", async () => {
    const { cwd } = await evaluated("self");
    await submitReview(cwd, await reviewFile(cwd, { reviewer: IMPLEMENTER, verdict: "fail", findings: [{ id: "F1", severity: "high", summary: "wrong", disposition: "open" }] }));
    await expect(closeOutcome(cwd)).rejects.toThrow(/review blocked by: F1/);
    await submitReview(cwd, await reviewFile(cwd, { reviewer: IMPLEMENTER }));
    await closeOutcome(cwd);
    expect(await checkHistory(cwd)).toEqual([]);
  });
});

describe("independent evaluation provenance", () => {
  it("matches names and emails case-insensitively, including Name <email>", () => {
    const identities = new Set(["ways test", "ways@example.test"]);
    expect(reviewerProvenanceFailure("independent", identities)).toBeUndefined();
    expect(reviewerProvenanceFailure(" WAYS TEST ", identities)).toMatch(/matches an implementer/);
    expect(reviewerProvenanceFailure("Someone <Ways@Example.test>", identities)).toMatch(/matches an implementer/);
  });

  it("submit, close, hook and history all reject a review by a known implementer", async () => {
    const { cwd, git } = await evaluated();
    await expect(submitReview(cwd, await reviewFile(cwd, { reviewer: IMPLEMENTER }))).rejects.toThrow(/matches an implementer/);
    await expect(submitReview(cwd, await reviewFile(cwd, { reviewer: `Alias <${IMPLEMENTER_EMAIL}>` }))).rejects.toThrow(/matches an implementer/);

    await plantReview(cwd, JSON.parse(await readFile(await reviewFile(cwd, { reviewer: IMPLEMENTER }), "utf8")));
    await expect(closeOutcome(cwd)).rejects.toThrow(/matches an implementer/);
    await rm(join(cwd, ".ways", "runtime"), { recursive: true, force: true });
    expect(await forgeClose(git)).toMatch(/matches an implementer/);
    expect(await historyMessages(cwd)).toMatch(/matches an implementer/);
  });

  it("criteria rewritten after open block close even with a submitted review", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    // A task commit rewrites the committed criteria; close refuses the drift before any review.
    const spec = JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")) as OutcomeSpec;
    await executeTask(cwd, "feature", 0, { "feature.txt": "hello\n", [outcomeSpecPath("hello")]: JSON.stringify({ ...spec, criteria: [{ id: "AC1", text: "anything" }] }) });
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await submitReview(cwd, await reviewFile(cwd));
    await expect(closeOutcome(cwd)).rejects.toThrow(/changed after opening/);
  });
});

describe("replay and policy tampering", () => {
  it("rejects a review replayed from another attempt or another input", async () => {
    const { cwd, git } = await evaluated();
    const blocking = JSON.parse(await readFile(await reviewFile(cwd, { verdict: "fail", findings: [{ id: "F1", severity: "high", summary: "wrong", disposition: "open" }] }), "utf8")) as Record<string, unknown>;
    await submitReview(cwd, join(cwd, ".ways", "runtime", "review.json"));
    await remediateOutcome(cwd, "reviewer found F1");
    await executeTask(cwd, "fix", 1, { "feature.txt": "hello again\n" });
    await writeEvidence(cwd, 1);
    await evaluateOutcome(cwd);

    // The attempt-0 review, relabelled as a pass, still names attempt 0 or binds attempt 0's digest.
    const replayed = { ...blocking, verdict: "pass", findings: [] };
    await expect(submitReview(cwd, await reviewFileFrom(cwd, replayed))).rejects.toThrow(/attempt does not match/);
    await expect(submitReview(cwd, await reviewFileFrom(cwd, { ...replayed, attempt: 1 }))).rejects.toThrow(/does not match the current diff/);
    await plantReview(cwd, replayed, 1);
    await expect(closeOutcome(cwd)).rejects.toThrow(/does not belong to this work and attempt/);
    await plantReview(cwd, { ...replayed, attempt: 1 }, 1);
    await expect(closeOutcome(cwd)).rejects.toThrow(/review is stale/);
    await rm(join(cwd, ".ways", "runtime"), { recursive: true, force: true });
    await git.run(["add", "-A"]);
    await git.run(["rm", "-q", ".ways/state/current.json"]);
    await expect(git.run(["commit", "-q", "-m", "close", "-m", `${CLOSE_TRAILERS}\nHarness-Attempt: 1`])).rejects.toThrow(/review is stale/);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged", "-m", `${CLOSE_TRAILERS}\nHarness-Attempt: 1`]);
    expect(await historyMessages(cwd)).toMatch(/review is stale/);
  });

  it("rejects a review whose digest binds another input", async () => {
    // A passing review of a different increment of the same work id.
    const other = await repository();
    await openOutcome(other.cwd, "hello", "Say hello", CRITERIA);
    await executeTask(other.cwd, "feature", 0, { "feature.txt": "hello there\n" });
    await writeEvidence(other.cwd);
    await evaluateOutcome(other.cwd);
    const foreign = await reviewDigest(other.cwd);
    const { cwd } = await evaluated();
    expect(foreign).not.toBe(await reviewDigest(cwd));
    await expect(submitReview(cwd, await reviewFile(cwd, { digest: foreign }))).rejects.toThrow(/does not match the current diff/);
    await plantReview(cwd, { schemaVersion: 1, workId: "hello", reviewer: "independent", digest: foreign, verdict: "pass", findings: [] });
    await expect(closeOutcome(cwd)).rejects.toThrow(/review is stale/);
  });

  it("editing the spec or the state after open cannot weaken a required policy", async () => {
    const { cwd, git } = await evaluated();
    const specPath = join(cwd, outcomeSpecPath("hello"));
    const spec = JSON.parse(await readFile(specPath, "utf8")) as OutcomeSpec;
    await writeFile(specPath, JSON.stringify({ ...spec, policy: { ...spec.policy, independentEvaluation: "optional" } }));
    await expect(closeOutcome(cwd)).rejects.toThrow(/need a new evaluation/);
    expect(await forgeClose(git)).toMatch(/may only record its review/);
    expect(await historyMessages(cwd)).toMatch(/close changed more than its review/);
  });

  it("a state edit carries no policy: close still demands the independent review", async () => {
    const { cwd } = await evaluated();
    const statePath = join(cwd, ".ways", "state", "current.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
    await expect(closeOutcome(cwd)).rejects.toThrow(/independent review is required/);
  });

  it("a spec rewritten to self in a task commit is rejected at close and in history", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "hello", "Say hello", CRITERIA);
    const spec = JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")) as OutcomeSpec;
    await executeTask(cwd, "feature", 0, { "feature.txt": "hello\n", [outcomeSpecPath("hello")]: JSON.stringify({ ...spec, policy: { ...spec.policy, independentEvaluation: "optional" } }) });
    await writeEvidence(cwd);
    await evaluateOutcome(cwd);
    await expect(closeOutcome(cwd)).rejects.toThrow(/changed after opening/);
    expect(await forgeClose(git)).toMatch(/changed after opening/);
    expect(await historyMessages(cwd)).toMatch(/changed after opening/);
  });
});

async function reviewFileFrom(cwd: string, review: unknown): Promise<string> {
  const path = join(cwd, ".ways", "runtime", "replayed.json");
  await mkdir(join(cwd, ".ways", "runtime"), { recursive: true });
  await writeFile(path, JSON.stringify(review));
  return path;
}
