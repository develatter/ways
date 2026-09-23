import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import type { MemoryTier } from "../src/domain/types.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import {
  closeOutcome,
  evaluateOutcome,
  openOutcome,
  outcomeEvidencePath,
  outcomeMemoryReviewDigest,
  outcomeMemoryReviewPath,
  outcomeSpecPath,
  submitOutcomeMemoryReview,
} from "../src/work/outcome.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

const CONCEPT = ".ways/knowledge/faq/greeting.md";
const DRAFT = "---\ntype: faq\nstatus: draft\ngenerated: { by: explorer/v1, at: 2026-01-01T00:00:00Z }\nsources:\n  - resource: /feature.txt\n---\n\n# Greeting\nThe feature greets with hello.\n";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-outcome-memory-"));
  directories.push(cwd);
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

/** Opens, executes one task (optionally authoring knowledge) and evaluates. */
async function evaluated(tier: MemoryTier, knowledge?: string): Promise<{ cwd: string; git: GitRepository }> {
  const repo = await repository();
  const { cwd } = repo;
  await openOutcome(cwd, "hello", "Say hello", [{ id: "AC1", text: "feature.txt says hello" }], tier);
  await addTask(cwd, "feature", "Write the feature");
  const task = await prepareTask(cwd, "feature");
  const paths = ["feature.txt"];
  await writeFile(join(task.worktree!, "feature.txt"), "hello\n");
  if (knowledge !== undefined) {
    await mkdir(join(task.worktree!, ".ways/knowledge/faq"), { recursive: true });
    await writeFile(join(task.worktree!, CONCEPT), knowledge);
    paths.push(CONCEPT);
  }
  const commit = await new GitRepository(task.worktree!).commit(paths, "feat: hello", { work: "hello", task: "feature" });
  await integrateTask(cwd, "feature", [commit]);
  await writeFile(join(cwd, outcomeEvidencePath("hello")), JSON.stringify({ schemaVersion: 1, workId: "hello", attempt: 0, criteria: { AC1: { summary: "feature.txt contains hello" } } }));
  if (tier !== "none" || knowledge === undefined) await evaluateOutcome(cwd);
  return repo;
}

async function reviewFile(cwd: string, digest: string, verdict: "pass" | "fail" = "pass"): Promise<string> {
  await mkdir(join(cwd, ".ways", "runtime"), { recursive: true });
  const path = join(cwd, ".ways", "runtime", `review-${digest.slice(0, 8)}-${verdict}.json`);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer: "independent", digest, verdict, findings: [] }));
  return path;
}

async function review(cwd: string): Promise<void> {
  await submitReview(cwd, await reviewFile(cwd, await reviewDigest(cwd)));
}

describe("outcome memory assurance tiers", () => {
  it("persists the selected tier at open and defaults to normal", async () => {
    const { cwd } = await repository();
    await openOutcome(cwd, "hello", "Say hello", [{ id: "AC1", text: "x" }]);
    expect(JSON.parse(await readFile(join(cwd, outcomeSpecPath("hello")), "utf8")).policy.memory).toBe("normal");
  });

  it("none: refuses knowledge changes in the increment and closes without memory action otherwise", async () => {
    const refused = await evaluated("none", DRAFT);
    await expect(evaluateOutcome(refused.cwd)).rejects.toThrow(/Memory policy none forbids knowledge changes: \.ways\/knowledge\/faq\/greeting\.md/);

    const { cwd } = await evaluated("none");
    await review(cwd);
    await expect(outcomeMemoryReviewDigest(cwd)).rejects.toThrow(/no memory review is needed/);
    await closeOutcome(cwd);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("normal: sourced knowledge travels with the task without a memory review", async () => {
    const { cwd, git } = await evaluated("normal", DRAFT);
    await review(cwd);
    await closeOutcome(cwd);
    expect(await readFile(join(cwd, CONCEPT), "utf8")).toContain("greets with hello");
    expect((await git.run(["log", "--format=%s", "-4"])).split("\n")).toEqual(["outcome(close): complete hello", "outcome(execute): complete hello", "feat: hello", "outcome(open): hello"]);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("normal: existing OKF validity is still enforced on knowledge in the increment", async () => {
    await expect(evaluated("normal", "---\ntype: faq\nstatus: stable\n---\n\n# Unsourced\n")).rejects.toThrow(/Evaluation failed:\n.*greeting\.md/);
  });

  it("high: close requires a fresh, passing, digest-bound memory review", async () => {
    const { cwd, git } = await evaluated("high", DRAFT);
    await review(cwd);
    await expect(closeOutcome(cwd)).rejects.toThrow(/requires a memory review/);

    const digest = await outcomeMemoryReviewDigest(cwd);
    await expect(submitOutcomeMemoryReview(cwd, await reviewFile(cwd, "0".repeat(64)))).rejects.toThrow(/does not match/);
    await submitOutcomeMemoryReview(cwd, await reviewFile(cwd, digest, "fail"));
    await expect(closeOutcome(cwd)).rejects.toThrow(/memory review blocked by: verdict/);

    // A review recorded for different knowledge is stale.
    const path = join(cwd, outcomeMemoryReviewPath("hello"));
    await writeFile(path, JSON.stringify({ schemaVersion: 1, workId: "hello", reviewer: "independent", digest: "f".repeat(64), verdict: "pass", findings: [] }));
    await expect(closeOutcome(cwd)).rejects.toThrow(/memory review is stale/);

    await submitOutcomeMemoryReview(cwd, await reviewFile(cwd, digest));
    await closeOutcome(cwd);
    expect(await git.run(["show", "--name-only", "--format=", "HEAD"])).toContain(outcomeMemoryReviewPath("hello"));
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("high: a forged no-verify close without the memory review fails the history audit", async () => {
    const { cwd, git } = await evaluated("high", DRAFT);
    await review(cwd);
    await git.run(["add", "-A"]);
    await git.run(["rm", "-q", ".ways/state/current.json"]);
    const trailers = "Harness-Work: hello\nHarness-Phase: outcome-close\nHarness-State: completed";
    await expect(git.run(["commit", "-q", "-m", "close", "-m", trailers])).rejects.toThrow(/memory review/);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged", "-m", trailers]);
    expect((await checkHistory(cwd)).map((issue) => issue.message).join("\n")).toMatch(/requires a memory review/);
  });
});
