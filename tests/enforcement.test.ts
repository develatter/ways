import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { STATUS_PATH } from "../src/domain/constants.js";
import { GitRepository, GitError } from "../src/git/git.js";
import { judgeCommitMessage } from "../src/hooks/hook.js";
import { auditCommits, checkHistory } from "../src/integrity/history.js";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { projectStatus, readStatus } from "../src/state/status.js";
import { loadState } from "../src/state/store.js";
import { cancelQuick, finishQuick, startQuick } from "../src/work/quick.js";
import { integrateTask, prepareTask } from "../src/work/tasks.js";
import { saveState } from "../src/state/store.js";
import { advanceSdd, startSdd } from "../src/work/sdd.js";
import type { WorkState } from "../src/domain/types.js";

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-enforce-"));
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

const execFileAsync = promisify(execFile);

async function fillPhase(cwd: string, id: string, phase: string): Promise<void> {
  await writeFile(join(cwd, ".ways", "sdd", id, `${phase}.md`), `# ${phase}\n\nGoal: x\nEvidence: y\nDecision: z\nGate: go\n`);
}

describe("status artifact", () => {
  it("mirrors the active state and idles after close", async () => {
    const { cwd } = await repository();
    expect((await readStatus(cwd))?.active).toBe(false);
    await startQuick(cwd, "tiny-fix");
    const active = await readStatus(cwd);
    expect(active).toMatchObject({ active: true, mode: "quick", id: "tiny-fix", status: "active" });
    expect(active).toEqual(projectStatus(await loadState(cwd)));
    await writeFile(join(cwd, "a.txt"), "a\n");
    await finishQuick(cwd, "fix: a", "unchanged");
    expect((await readStatus(cwd))?.active).toBe(false);
  });

  it("leaves no diff behind when quick work is cancelled", async () => {
    const { cwd, git } = await repository();
    await startQuick(cwd, "tiny-fix");
    await cancelQuick(cwd);
    expect(await git.status()).toEqual([]);
    await startQuick(cwd, "next-fix");
  });

  it("marks supervised human gates", async () => {
    const { cwd } = await repository();
    await startSdd(cwd, "guarded", "supervised");
    expect(await readStatus(cwd)).toMatchObject({ phase: "intake", profile: "supervised", humanGate: true });
  });

  it("adds remediation metadata only after attempt zero", () => {
    const now = new Date().toISOString();
    const state: WorkState = {
      schemaVersion: 1, harnessVersion: "test", id: "reopened", mode: "sdd", status: "active",
      profile: "autonomous", execution: "delegated", phase: "implement", baseCommit: "a".repeat(40), gateCommit: "b".repeat(40),
      createdAt: now, updatedAt: now, tasks: [], attempt: 1,
      remediation: {
        source: "review", target: "implement", reason: "address findings", priorCheckpoint: "b".repeat(40), attempt: 1, timestamp: now,
        evidence: { kind: "review", review: { schemaVersion: 1, workId: "reopened", reviewer: "reviewer", digest: "digest", verdict: "fail", findings: [] } },
      },
    };
    expect(projectStatus(state)).toMatchObject({ attempt: 1, remediation: { source: "review", target: "implement", reason: "address findings" } });
    const legacy = projectStatus({ ...state, attempt: 0, remediation: undefined });
    expect(legacy).not.toHaveProperty("attempt");
    expect(legacy).not.toHaveProperty("remediation");
  });

  it("fails integrity when the artifact diverges", async () => {
    const { cwd } = await repository();
    await startQuick(cwd, "tiny-fix");
    await writeFile(join(cwd, STATUS_PATH), `${JSON.stringify({ schemaVersion: 1, active: false, updatedAt: "x" })}\n`);
    const codes = (await checkIntegrity(cwd)).map((issue) => issue.code);
    expect(codes).toContain("status-divergence");
  });
});

describe("commit-msg hook", () => {
  it("rejects commits without an active work once bootstrapped", async () => {
    const { cwd, git } = await repository();
    await writeFile(join(cwd, "b.txt"), "b\n");
    await git.run(["add", "b.txt"]);
    await expect(git.run(["commit", "-q", "-m", "sneaky"])).rejects.toBeInstanceOf(GitError);
    expect((await judgeCommitMessage(cwd, "sneaky")).reason).toMatch(/ways quick start/);
  });

  it("requires the active work id and accepts a staged closing commit from HEAD state", async () => {
    const { cwd, git } = await repository();
    await startSdd(cwd, "traced", "autonomous");
    expect((await judgeCommitMessage(cwd, "x\n\nHarness-Work: other")).accepted).toBe(false);
    expect((await judgeCommitMessage(cwd, "x\n\nHarness-Work: traced")).accepted).toBe(true);
    await fillPhase(cwd, "traced", "intake");
    await advanceSdd(cwd);
    expect(await git.run(["show", "HEAD:.ways/state/current.json"])).toContain("\"traced\"");
    await rm(join(cwd, ".ways/state/current.json"));
    await git.run(["add", "-A", ".ways/state"]);
    const wrong = await judgeCommitMessage(cwd, "done\n\nHarness-Work: traced\nHarness-Phase: close\nHarness-State: proposed");
    expect(wrong.accepted).toBe(false);
    const cancelled = await judgeCommitMessage(cwd, "done\n\nHarness-Work: traced\nHarness-State: cancelled");
    expect(cancelled.accepted).toBe(true);
  });

  it("rejects a hand-written closing commit that keeps the state file", async () => {
    const { cwd, git } = await repository();
    await startSdd(cwd, "forged", "autonomous");
    await fillPhase(cwd, "forged", "intake");
    await advanceSdd(cwd);
    await rm(join(cwd, ".ways/state/current.json"));
    const unstaged = await judgeCommitMessage(cwd, "done\n\nHarness-Work: forged\nHarness-Phase: close\nHarness-State: completed");
    expect(unstaged.accepted).toBe(false);
    await git.run(["add", "-A", ".ways/state"]);
    const noPhase = await judgeCommitMessage(cwd, "done\n\nHarness-Work: forged\nHarness-State: completed");
    expect(noPhase.accepted).toBe(false);
    const closing = await judgeCommitMessage(cwd, "done\n\nHarness-Work: forged\nHarness-Phase: close\nHarness-State: completed");
    expect(closing.accepted).toBe(true);
  });

  it("resolves the CLI from a consumer node_modules inside a task worktree without WAYS_CLI", async () => {
    const { cwd, git } = await repository();
    await mkdir(join(cwd, "node_modules", "@develatter"), { recursive: true });
    await symlink(join(import.meta.dirname, ".."), join(cwd, "node_modules", "@develatter", "ways"));
    const head = await git.head();
    await saveState(cwd, {
      schemaVersion: 1, harnessVersion: "0.1.0", id: "wt", mode: "sdd", status: "active", profile: "autonomous",
      phase: "implement", lastCompletedPhase: "decompose", baseCommit: head, gateCommit: await git.parent(head),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      tasks: [{ id: "api", title: "Build API", status: "ready", dependsOn: [], commits: [] }],
    });
    const gate = await git.commit(await git.changedPaths(), "sdd(decompose): complete wt", { work: "wt", phase: "decompose", state: "completed" });
    const task = await prepareTask(cwd, "api");
    await writeFile(join(task.worktree!, "api.ts"), "export const api = true;\n");
    const env = { ...process.env };
    delete env.WAYS_CLI;
    await execFileAsync("git", ["add", "api.ts"], { cwd: task.worktree! });
    await expect(execFileAsync("git", ["commit", "-q", "-m", "feat: api"], { cwd: task.worktree!, env })).rejects.toThrow(/Active sdd work is wt/);
    await execFileAsync("git", ["commit", "-q", "-m", "feat: api", "-m", "Harness-Work: wt\nHarness-Task: api"], { cwd: task.worktree!, env });
    const worker = new GitRepository(task.worktree!);
    await integrateTask(cwd, "api", [await worker.head()]);
    expect(await checkHistory(cwd, { since: gate })).toEqual([]);
  });

  it("lets the harness create its own gate commits", async () => {
    const { cwd, git } = await repository();
    await startSdd(cwd, "gated", "autonomous");
    await fillPhase(cwd, "gated", "intake");
    await advanceSdd(cwd);
    expect((await git.lastCommit()).trailers).toMatchObject({ work: "gated", phase: "intake", state: "completed" });
  });
});

describe("history verification", () => {
  it("flags untraced commits after the anchor and broken SDD chains", () => {
    const commit = (subject: string, trailers: Record<string, string>) => ({ hash: "0123456789abcdef", subject, body: "", trailers });
    const issues = auditCommits([
      commit("ok", { work: "w", state: "completed", phase: "intake" }),
      commit("skip", { work: "w", state: "completed", phase: "assess" }),
      commit("manual", {}),
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(["history-broken-chain", "history-untraced"]);
  });

  it("replays remediation attempts in order and rejects duplicate, backward, skipped and forged edges", () => {
    let serial = 0;
    const commit = (state: string, phase: string, attempt?: string) => ({
      hash: `${++serial}`.padStart(40, "0"), subject: `${state} ${phase}`, body: "",
      trailers: { work: "loop", state, phase, ...(attempt ? { attempt } : {}) },
    });
    const prefix = ["intake", "explore", "assess", "specify", "plan", "decompose", "implement"]
      .map((phase) => commit("completed", phase));
    expect(auditCommits([
      ...prefix,
      commit("remediated-specify", "review", "1"),
      ...["specify", "plan", "decompose", "implement"].map((phase) => commit("completed", phase, "1")),
      commit("completed", "review", "1"),
      commit("remediated-implement", "validate", "2"),
      commit("completed", "implement", "2"),
    ])).toEqual([]);

    for (const forged of [
      commit("remediated-implement", "review", "2"),
      commit("remediated-intake", "review", "1"),
      commit("remediated-implement", "implement", "1"),
      commit("remediated-implement", "review"),
      commit("completed", "decompose"),
    ]) {
      expect(auditCommits([...prefix, forged]).map((entry) => entry.code)).toContainEqual(expect.stringMatching(/^history-(invalid-remediation|broken-chain)$/));
    }
  });

  it("requires an added, matching remediation record", async () => {
    const { cwd, git } = await repository();
    await startSdd(cwd, "forged-edge", "autonomous");
    for (const phase of ["intake", "explore", "assess", "specify", "plan", "decompose", "implement"]) {
      await fillPhase(cwd, "forged-edge", phase);
      await advanceSdd(cwd);
    }
    await writeFile(join(cwd, "forged.txt"), "not evidence\n");
    await git.run(["add", "forged.txt"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "forged remediation", "-m", "Harness-Work: forged-edge\nHarness-Phase: review\nHarness-State: remediated-implement\nHarness-Attempt: 1"]);
    expect((await checkHistory(cwd)).map((entry) => entry.code)).toContain("history-invalid-remediation-evidence");
  });

  it("exempts history up to the bootstrap commit and catches --no-verify commits", async () => {
    const { cwd, git } = await repository();
    expect(await checkHistory(cwd)).toEqual([]);
    await writeFile(join(cwd, "c.txt"), "c\n");
    await git.run(["add", "c.txt"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "bypassed"]);
    const issues = await checkHistory(cwd);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("history-untraced");
    expect(await checkHistory(cwd, { since: "HEAD" })).toEqual([]);
  });

  it("accepts clean untraced merge commits but not merges with their own changes", async () => {
    const { cwd, git } = await repository();
    await startQuick(cwd, "pull-request");
    await writeFile(join(cwd, "pr.txt"), "change\n");
    await git.commit(["pr.txt"], "feat: pull request", { work: "pull-request" });
    const pullRequestHead = await git.head();
    const base = await git.run(["rev-parse", `${pullRequestHead}^`]);
    const merge = await git.run([
      "commit-tree", `${pullRequestHead}^{tree}`,
      "-p", base,
      "-p", pullRequestHead,
      "-m", "synthetic merge",
    ]);
    await git.run(["reset", "--hard", merge]);

    expect(await checkHistory(cwd)).toEqual([]);
    expect(await checkHistory(cwd, { to: pullRequestHead })).toEqual([]);

    await writeFile(join(cwd, "evil.txt"), "sneaked in\n");
    await git.run(["add", "evil.txt"]);
    const evilTree = await git.run(["write-tree"]);
    const evil = await git.run(["commit-tree", evilTree, "-p", base, "-p", pullRequestHead, "-m", "evil merge"]);
    await git.run(["reset", "--hard", evil]);
    expect((await checkHistory(cwd)).map((issue) => issue.code)).toEqual(["history-untraced"]);
  });

  it("accepts a complete SDD certification chain", async () => {
    const { cwd } = await repository();
    await startSdd(cwd, "chain", "autonomous");
    for (const phase of ["intake", "explore", "assess"]) {
      await fillPhase(cwd, "chain", phase);
      await advanceSdd(cwd);
    }
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("fails integrity for commits inside an active work that lack its trailer", async () => {
    const { cwd, git } = await repository();
    await startQuick(cwd, "tiny-fix");
    await writeFile(join(cwd, "d.txt"), "d\n");
    await git.run(["add", "d.txt"]);
    await git.run(["commit", "-q", "--no-verify", "-m", "bypassed"]);
    const codes = (await checkIntegrity(cwd)).map((issue) => issue.code);
    expect(codes).toContain("work-untraced");
  });

  it("traces inline implementation commits that carry only Harness-Work", async () => {
    const { cwd, git } = await repository();
    await startQuick(cwd, "inline-quick");
    await writeFile(join(cwd, "inline.txt"), "inline\n");
    await git.commit(["inline.txt"], "feat: inline", { work: "inline-quick" });
    expect(await checkHistory(cwd)).toEqual([]);
  });
});

describe("delegated execution", () => {
  async function delegatedAtImplement(cwd: string): Promise<void> {
    await startSdd(cwd, "deleg", "autonomous", "delegated");
    expect((await readStatus(cwd))?.execution).toBe("delegated");
    const { addTask } = await import("../src/work/tasks.js");
    for (const phase of ["intake", "explore", "assess", "specify", "plan"]) {
      await fillPhase(cwd, "deleg", phase);
      await advanceSdd(cwd);
    }
    await addTask(cwd, "api", "Build API");
    await fillPhase(cwd, "deleg", "decompose");
    await advanceSdd(cwd);
    await fillPhase(cwd, "deleg", "implement");
  }

  async function integrateWorker(cwd: string): Promise<void> {
    const { integrateTask, prepareTask } = await import("../src/work/tasks.js");
    const task = await prepareTask(cwd, "api");
    const worker = new GitRepository(task.worktree!);
    await writeFile(join(task.worktree!, "api.ts"), "export const api = true;\n");
    await integrateTask(cwd, "api", [await worker.commit(["api.ts"], "feat: api", { work: "deleg", task: "api" })]);
  }

  it("certifies implement when every commit was integrated from a task", async () => {
    const { cwd, git } = await repository();
    await delegatedAtImplement(cwd);
    await expect(advanceSdd(cwd)).rejects.toThrow(/must be integrated/);
    await integrateWorker(cwd);
    await advanceSdd(cwd);
    expect((await git.lastCommit()).trailers.phase).toBe("implement");
  });

  it("rejects orchestrator commits, even with forged task trailers", async () => {
    const { cwd, git } = await repository();
    await delegatedAtImplement(cwd);
    await integrateWorker(cwd);
    await writeFile(join(cwd, "forged.ts"), "// orchestrator wrote this\n");
    await git.commit(["forged.ts"], "feat: forged", { work: "deleg", task: "api" });
    await expect(advanceSdd(cwd)).rejects.toThrow(/"feat: forged" was not integrated from a task/);
  });

  it.each([
    ["staged production", "api.ts", true],
    ["unstaged unrelated", "unrelated.txt", false],
  ] as const)("does not absorb %s changes into delegated certification", async (_label, path, staged) => {
    const { cwd, git } = await repository();
    await delegatedAtImplement(cwd);
    await integrateWorker(cwd);
    const integratedHead = await git.head();
    await writeFile(join(cwd, path), "// injected outside the task worktree\n");
    if (staged) await git.run(["add", "--", path]);

    await expect(advanceSdd(cwd)).rejects.toThrow(/Dirty or staged content outside delegated implementation orchestration/);

    expect(await git.head()).toBe(integratedHead);
    expect((await loadState(cwd))?.phase).toBe("implement");
    await expect(readFile(join(cwd, ".ways/sdd/deleg/review.md"), "utf8")).rejects.toThrow();
  });

  it("clears execution when downgrading", async () => {
    const { cwd } = await repository();
    await startSdd(cwd, "deleg", "autonomous", "delegated");
    for (const phase of ["intake", "explore"]) {
      await fillPhase(cwd, "deleg", phase);
      await advanceSdd(cwd);
    }
    await fillPhase(cwd, "deleg", "assess");
    const { downgradeSdd } = await import("../src/work/sdd.js");
    await downgradeSdd(cwd, "quick");
    expect((await loadState(cwd))?.execution).toBeUndefined();
    expect((await checkIntegrity(cwd)).filter((issue) => issue.code === "state-git-divergence")).toEqual([]);
  });
});

describe("bootstrap hooks", () => {
  it("installs a managed commit-msg hook and points core.hooksPath at it", async () => {
    const { cwd, git } = await repository();
    expect(await git.run(["config", "core.hooksPath"])).toBe(".ways/hooks");
    const manifest = JSON.parse(await readFile(join(cwd, ".ways/manifest.json"), "utf8")) as { managedFiles: Record<string, string> };
    expect(Object.keys(manifest.managedFiles)).toContain(".ways/hooks/commit-msg");
  });
});
