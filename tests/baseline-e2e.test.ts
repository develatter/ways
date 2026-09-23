import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";
import { checkHistory } from "../src/integrity/history.js";
import { discoveryReviewDigest, completeDiscovery, commitMemory, memoryCommitReviewDigest, MEMORY_STATE_PATH } from "../src/memory/workflow.js";
import { inspectReconciliationCandidate, reconciliationReviewDigest, validateBackSyncMerge, validatePublicationMerge, type ReconciliationRequest } from "../src/memory/reconciliation.js";
import { queryKnowledgeResult } from "../src/query/query.js";
import { cancelQuick, finishQuick, startQuick } from "../src/work/quick.js";

const MEMORY_CONFIG = {
  releaseBranch: "main",
  integrationBranch: "development",
  reconciliationBranchPattern: "reconcile/*",
  relevantPaths: ["src/**"],
  excludedPaths: [],
};

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-baseline-e2e-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q", "-b", "main"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/runtime.ts"), "export const runtime = 1;\n");
  await git.run(["add", "src/runtime.ts"]);
  await git.run(["commit", "-q", "-m", "initial runtime"]);
  await git.run(["switch", "-q", "-c", "development"]);
  await bootstrap({
    cwd,
    testCommand: [process.execPath, "-e", "process.exit(0)"],
    adapters: false,
    memory: MEMORY_CONFIG,
  });
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "bootstrap"]);
  await startQuick(cwd, "baseline-e2e");
  await mkdir(join(cwd, ".ways/knowledge/components"), { recursive: true });
  await mkdir(join(cwd, ".ways/knowledge/coverage"), { recursive: true });
  await writeFile(join(cwd, ".ways/knowledge/components/runtime.md"), `---\ntype: component\nstatus: stable\nverified: { by: process:baseline-review, at: 2026-09-03T00:00:00Z }\nsources:\n  - { resource: /src/runtime.ts, revision: ${await git.head()} }\n---\n\n# Runtime\nThe runtime export is reviewed against the baseline source tree.\n`);
  await writeFile(join(cwd, ".ways/knowledge/coverage/runtime.json"), JSON.stringify({
    schemaVersion: 1,
    id: "runtime",
    globs: ["src/**"],
    classification: "concept-backed",
    concepts: ["components/runtime"],
  }));
  return { cwd, git };
}

async function reviewFile(cwd: string, workId: string, digest: string): Promise<string> {
  const path = join(cwd, `${workId}.review.json`);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, workId, reviewer: "baseline/reviewer", digest, verdict: "pass", findings: [] }));
  return path;
}

describe("baseline end-to-end coverage", () => {
  it("walks discovery, incremental memory, cache repair, reconciliation, publication, and back-sync", async () => {
    const { cwd, git } = await repository();
    const runtimeDoc = join(cwd, ".ways/knowledge/components/runtime.md");
    const searchCache = join(cwd, ".ways/indexes/search.json");

    const incomplete = await queryKnowledgeResult(cwd, "runtime");
    expect(incomplete.hits[0]?.path).toBe(".ways/knowledge/components/runtime.md");
    expect(incomplete.warnings).toEqual(["Memory baseline is incomplete: reviewed discovery and coverage are still required."]);
    expect(JSON.parse(await readFile(searchCache, "utf8"))).toHaveProperty("terms.runtime");

    const discoveryDigest = await discoveryReviewDigest(cwd);
    const discoveryReview = await reviewFile(cwd, "memory-discovery", discoveryDigest);
    await completeDiscovery(cwd, discoveryReview);

    const reviewed = await queryKnowledgeResult(cwd, "runtime");
    expect(reviewed.warnings).toEqual([]);

    await finishQuick(cwd, "docs(memory): baseline discovery and coverage");

    await startQuick(cwd, "runtime-change");
    const from = await git.head();
    await writeFile(join(cwd, "src/runtime.ts"), "export const runtime = 2;\n");
    await git.commit(["src/runtime.ts"], "feat: update runtime", { work: "runtime-change" });
    const to = await git.head();
    expect(await checkHistory(cwd)).toEqual([]);

    await writeFile(runtimeDoc, `---\ntype: component\nstatus: stable\nverified: { by: process:baseline-review, at: 2026-09-03T00:00:00Z }\nsources:\n  - { resource: /src/runtime.ts, revision: ${to} }\n---\n\n# Runtime\nThe runtime export now reflects the implemented change.\n`);
    const memoryDigest = await memoryCommitReviewDigest(cwd, `${from}..${to}`);
    const memoryReview = await reviewFile(cwd, "runtime-change", memoryDigest);
    await writeFile(runtimeDoc, `${await readFile(runtimeDoc, "utf8")}\nStale after review.\n`);
    await expect(commitMemory(cwd, `${from}..${to}`, memoryReview, "docs(memory): describe runtime")).rejects.toThrow("stale");
    await writeFile(runtimeDoc, `---\ntype: component\nstatus: stable\nverified: { by: process:baseline-review, at: 2026-09-03T00:00:00Z }\nsources:\n  - { resource: /src/runtime.ts, revision: ${to} }\n---\n\n# Runtime\nThe runtime export now reflects the implemented change.\n`);
    const memoryCommit = await commitMemory(cwd, `${from}..${to}`, memoryReview, "docs(memory): describe runtime");
    const memoryInfo = await git.commitInfo(memoryCommit);
    expect(memoryInfo.trailers.work).toBe("runtime-change");
    expect(memoryInfo.trailers.implementation).toBe(`${from}..${to}`);
    expect(memoryInfo.trailers.memoryReviewDigest).toBe(memoryDigest);
    await rm(memoryReview, { force: true });
    expect(await checkHistory(cwd)).toEqual([]);

    const stale = await queryKnowledgeResult(cwd, "runtime");
    expect(stale.warnings[0]).toContain("Memory may be stale");
    expect(stale.warnings[0]).toContain("runtime");

    await writeFile(searchCache, "{}\n");
    const repaired = await queryKnowledgeResult(cwd, "runtime");
    expect(repaired.hits[0]?.path).toBe(".ways/knowledge/components/runtime.md");
    expect(JSON.parse(await readFile(searchCache, "utf8"))).toHaveProperty("terms.runtime");

    const candidate = await git.head();
    await git.run(["switch", "-q", "-c", "reconcile/1", candidate]);
    await writeFile(runtimeDoc, `---\ntype: component\nstatus: stable\nverified: { by: process:baseline-review, at: 2026-09-03T00:00:00Z }\nsources:\n  - { resource: /src/runtime.ts, revision: ${to} }\n---\n\n# Runtime\nThe runtime export is reconciled against the exact reviewed tree.\n`);
    await git.commit([".ways/knowledge/components/runtime.md"], "reconcile runtime", { work: "runtime-change" });
    const reconcile = await git.head();

    const request: ReconciliationRequest = {
      state: JSON.parse(await readFile(join(cwd, MEMORY_STATE_PATH), "utf8")),
      candidateRef: candidate,
      reconcileRef: reconcile,
      targetRef: "main",
      candidateBranch: "reconcile/1",
      dispositions: [{ path: "src/runtime.ts", outcome: "updated", concepts: ["components/runtime"] }],
      unresolvedClaims: [],
    };
    const draft = await inspectReconciliationCandidate(cwd, MEMORY_CONFIG, request);
    expect(draft.issues.map((issue) => issue.code)).toContain("missing-review");
    const reviewDigest = await reconciliationReviewDigest(git, candidate, reconcile, draft.evidence);
    const result = await inspectReconciliationCandidate(cwd, MEMORY_CONFIG, { ...request, reviewDigest });
    expect(result.issues).toEqual([]);

    const integrationBefore = await git.head();
    await writeFile(join(cwd, "src/drift.ts"), "export const drift = true;\n");
    await git.commit(["src/drift.ts"], "feat: drift", { work: "runtime-change" });
    await cancelQuick(cwd);
    const target = await git.resolveRef("main");
    const publicationTree = await git.mergedTree(target, reconcile);
    const publication = await git.run(["commit-tree", publicationTree, "-p", target, "-p", reconcile, "-m", "publish"]);
    expect((await validatePublicationMerge(cwd, MEMORY_CONFIG, result.evidence, publication, reconcile)).issues).toEqual([]);
    const backSyncTree = await git.mergedTree(integrationBefore, publication);
    const backSync = await git.run(["commit-tree", backSyncTree, "-p", integrationBefore, "-p", publication, "-m", "back sync"]);
    expect(await validateBackSyncMerge(cwd, MEMORY_CONFIG, publication, integrationBefore, backSync)).toEqual({ status: "merged", issues: [] });
    expect(await validateBackSyncMerge(cwd, MEMORY_CONFIG, publication, backSync, backSync)).toEqual({ status: "already-synchronized", issues: [] });

    const warning = await queryKnowledgeResult(cwd, "runtime");
    expect(warning.warnings[0]).toContain("runtime");
    expect(warning.warnings[0]).toContain("generation 0");
  });

  it("installs and checks the package from an npm pack tarball", async () => {
    const root = process.cwd();
    const packDir = await mkdtemp(join(tmpdir(), "ways-pack-"));
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root, encoding: "utf8" })) as Array<{ filename: string }>;
    const tarball = join(packDir, packed[0]!.filename);
    const cwd = await mkdtemp(join(tmpdir(), "ways-pack-consumer-"));
    const git = new GitRepository(cwd);
    await git.run(["init", "-q"]);
    await git.run(["config", "user.name", "Ways Test"]);
    await git.run(["config", "user.email", "ways@example.test"]);
    await git.run(["commit", "--allow-empty", "-q", "-m", "initial"]);
    // CI points WAYS_HISTORY_TO at the PR head of this repository; the consumer repository has its own history.
    const consumerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WAYS_HISTORY_")));
    await execFileSync("npm", ["init", "-y"], { cwd, stdio: "ignore" });
    await execFileSync("npm", ["install", "--save-dev", tarball], { cwd, stdio: "ignore" });
    const installed = JSON.parse(await readFile(join(cwd, "node_modules", "@develatter", "ways", "package.json"), "utf8"));
    expect(installed.name).toBe("@develatter/ways");
    const help = execFileSync("npx", ["--no-install", "ways", "--help"], { cwd, encoding: "utf8" });
    expect(help).toMatch(/^ways /);
    const bin = execFileSync("npx", ["--no-install", "ways", "--version"], { cwd, encoding: "utf8" }).trim();
    expect(bin).toBeTruthy();
    await execFileSync("npx", ["--no-install", "ways", "bootstrap", `--test-command=${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}`, "--no-adapters"], { cwd, stdio: "ignore" });
    await execFileSync("sh", [join(cwd, "scripts/check.sh")], { cwd, stdio: "ignore", env: consumerEnv });

    // One complete outcome increment through the packed CLI, including a refused premature done claim.
    const ways = (...args: string[]): string => execFileSync("npx", ["--no-install", "ways", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "bootstrap ways"]);
    ways("outcome", "open", "greeting", "--goal=Greet users", "--criterion=AC1:greeting.txt says hi");
    ways("task", "add", "write", "--title=Write the greeting");
    const task = JSON.parse(ways("task", "prepare", "write")) as { worktree: string };
    await writeFile(join(task.worktree, "greeting.txt"), "hi\n");
    const taskGit = new GitRepository(task.worktree);
    const taskCommit = await taskGit.commit(["greeting.txt"], "feat: greeting", { work: "greeting", task: "write" });
    ways("task", "integrate", "write", `--commits=${taskCommit}`);
    expect(() => ways("outcome", "evaluate")).toThrow(/AC1 has no evidence summary/);
    await writeFile(join(cwd, ".ways/outcomes/greeting/attempts/0/evidence.json"), JSON.stringify({ schemaVersion: 1, workId: "greeting", attempt: 0, criteria: { AC1: { summary: "greeting.txt contains hi", checks: ["test"] } } }));
    ways("outcome", "evaluate");
    expect(() => ways("outcome", "close")).toThrow(/independent review is required/);
    const digest = ways("review", "digest").trim();
    await writeFile(join(packDir, "review.json"), JSON.stringify({ schemaVersion: 1, workId: "greeting", reviewer: "reviewer", digest, verdict: "pass", findings: [] }));
    ways("review", "submit", join(packDir, "review.json"));
    ways("outcome", "close");
    expect(ways("status")).toContain("No active mutating work.");
    await execFileSync("sh", [join(cwd, "scripts/check.sh")], { cwd, stdio: "ignore", env: consumerEnv });
  });
});
