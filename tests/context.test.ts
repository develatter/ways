import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { buildContext, renderContext, type ContextPacket } from "../src/context/context.js";
import { stableJson } from "../src/fs/files.js";
import { GitRepository } from "../src/git/git.js";
import { writeIndexes } from "../src/knowledge/indexes.js";
import { startQuick } from "../src/work/quick.js";
import { closeOutcome, evaluateOutcome, openOutcome } from "../src/work/outcome.js";
import { reviewDigest, submitReview } from "../src/work/review.js";
import { startSdd } from "../src/work/sdd.js";
import { addTask, integrateTask, prepareTask } from "../src/work/tasks.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TEST = "const fs=require('node:fs');process.exit(['base.txt','feature.txt'].every((f)=>fs.existsSync(f))?0:1)";

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-context-"));
  created.push(cwd);
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: [process.execPath, "-e", TEST] });
  await mkdir(join(cwd, ".ways/knowledge/conventions"), { recursive: true });
  await writeFile(join(cwd, ".ways/knowledge/conventions/greeting.md"), "---\ntype: convention\nstatus: draft\ntitle: Greeting convention\n---\n\n# Greeting\nGreetings are plain text files.\n");
  await writeIndexes(cwd);
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "bootstrap"]);
  return { cwd, git };
}

async function snapshot(cwd: string, git: GitRepository): Promise<string> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else entries.push(`${path}:${(await stat(path)).mtimeMs}`);
    }
  }
  await walk(join(cwd, ".ways"));
  return `${(await git.status()).join("\n")}\n${entries.sort().join("\n")}`;
}

/** Reads the packet twice and asserts it is identical and that nothing changed on disk. */
async function readOnlyContext(cwd: string, git: GitRepository): Promise<ContextPacket> {
  const before = await snapshot(cwd, git);
  const first = stableJson(await buildContext(cwd));
  const second = stableJson(await buildContext(cwd));
  expect(second).toBe(first);
  expect(await snapshot(cwd, git)).toBe(before);
  return JSON.parse(first) as ContextPacket;
}

async function implement(cwd: string, workId: string, taskId: string): Promise<void> {
  const task = await prepareTask(cwd, taskId);
  await writeFile(join(task.worktree!, `${taskId}.txt`), "hello\n");
  const commit = await new GitRepository(task.worktree!).commit([`${taskId}.txt`], `feat: ${taskId}`, { work: workId, task: taskId });
  await integrateTask(cwd, taskId, [commit]);
}

/**
 * A fresh session: it knows nothing but the serialized packet and the
 * harness commands, and drives the work to completion from those facts.
 */
async function freshSession(cwd: string, serialized: string): Promise<void> {
  let packet = JSON.parse(serialized) as ContextPacket;
  const active = packet.active!;
  expect(packet.divergence).toBeNull();
  expect(active.mode).toBe("outcome");
  for (const id of active.readyTasks) await implement(cwd, active.id, id);
  const outcome = active.outcome!;
  const criteria = Object.fromEntries(outcome.criteria.map((criterion) => [criterion.id, { summary: criterion.summary ?? `Done: ${criterion.text}` }]));
  await writeFile(join(cwd, outcome.evidencePath), JSON.stringify({ schemaVersion: 1, workId: active.id, attempt: active.attempt, criteria }));
  await evaluateOutcome(cwd);

  packet = await buildContext(cwd);
  expect(packet.active?.outcome?.evaluation.status).toBe("passed");
  expect(packet.active?.outcome?.review.status).toBe("absent");
  const reviewFile = join(cwd, ".ways/runtime/review.json");
  await mkdir(join(cwd, ".ways/runtime"), { recursive: true });
  await writeFile(reviewFile, JSON.stringify({ schemaVersion: 1, workId: active.id, reviewer: "independent", digest: await reviewDigest(cwd), verdict: "pass", findings: [] }));
  await submitReview(cwd, reviewFile);
  expect((await buildContext(cwd)).active?.outcome?.review.status).toBe("pass");
  await closeOutcome(cwd);
}

describe("ways context", () => {
  it("reports an idle repository without inventing work", async () => {
    const { cwd, git } = await repository();
    const packet = await readOnlyContext(cwd, git);
    expect(packet).toEqual({ schemaVersion: 1, head: await git.head(), divergence: null, active: null, outcomes: [], knowledge: [] });
    expect(renderContext(packet)).toContain("Active work: none");
  });

  it("lets a fresh session resume a bounded outcome work mid-execute and close it", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "greeting", "Greeting files exist", [{ id: "AC1", text: "base.txt exists" }, { id: "AC2", text: "feature.txt exists" }]);
    await addTask(cwd, "base", "Write base.txt");
    await addTask(cwd, "feature", "Write feature.txt", ["base"]);
    await implement(cwd, "greeting", "base");

    const packet = await readOnlyContext(cwd, git);
    expect(packet.head).toBe(await git.head());
    expect(packet.active).toMatchObject({ id: "greeting", mode: "outcome", stage: "execute", attempt: 0, readyTasks: ["feature"] });
    expect(packet.active?.tasks.map((task) => [task.id, task.status, task.integrated])).toEqual([["base", "completed", true], ["feature", "ready", false]]);
    expect(packet.active?.outcome).toMatchObject({
      goal: "Greeting files exist",
      criteria: [{ id: "AC1", evidence: "missing", evaluation: "absent" }, { id: "AC2", evidence: "missing", evaluation: "absent" }],
      evaluation: { status: "absent" },
      review: { status: "absent" },
      blockers: ["tasks not integrated: feature", "criteria without evidence: AC1, AC2", "evaluation absent", "review absent"],
    });
    expect(packet.outcomes).toEqual([{ id: "greeting", status: "open", goal: "Greeting files exist", commit: null }]);
    expect(packet.knowledge).toEqual([{ path: ".ways/knowledge/conventions/greeting.md", title: "Greeting convention" }]);
    expect(renderContext(packet)).toContain("Ready tasks: feature");

    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      expect(await run(["context", "--json"], cwd)).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(output.join("")).toBe(stableJson(packet));
    await freshSession(cwd, output.join(""));

    const closed = await readOnlyContext(cwd, git);
    expect(closed.active).toBeNull();
    expect(closed.outcomes).toEqual([{ id: "greeting", status: "closed", goal: "Greeting files exist", commit: await git.head() }]);
    expect(await git.status()).toEqual([]);
  });

  it("marks evidence stale after the evaluated input changes and reviews stale on digest mismatch", async () => {
    const { cwd, git } = await repository();
    await openOutcome(cwd, "greeting", "Greeting files exist", [{ id: "AC1", text: "files exist" }]);
    await addTask(cwd, "base", "Write base.txt");
    await addTask(cwd, "feature", "Write feature.txt");
    await implement(cwd, "greeting", "base");
    await implement(cwd, "greeting", "feature");
    await writeFile(join(cwd, ".ways/outcomes/greeting/attempts/0/evidence.json"), JSON.stringify({ schemaVersion: 1, workId: "greeting", attempt: 0, criteria: { AC1: { summary: "both files", checks: ["test"] } } }));
    await evaluateOutcome(cwd);
    await mkdir(join(cwd, ".ways/outcomes/greeting/attempts/0/reviews"), { recursive: true });
    await writeFile(join(cwd, ".ways/outcomes/greeting/attempts/0/reviews/latest.json"), JSON.stringify({ schemaVersion: 1, workId: "greeting", reviewer: "r", digest: "0".repeat(64), verdict: "pass", findings: [] }));
    expect((await readOnlyContext(cwd, git)).active?.outcome).toMatchObject({
      criteria: [{ id: "AC1", evidence: "filled", evaluation: "passed" }], evaluation: { status: "passed" }, review: { status: "stale" },
    });

    // Evidence edited after evaluation is exactly what close refuses.
    const evidencePath = ".ways/outcomes/greeting/attempts/0/evidence.json";
    const evaluated = await readFile(join(cwd, evidencePath), "utf8");
    await writeFile(join(cwd, evidencePath), JSON.stringify({ schemaVersion: 1, workId: "greeting", attempt: 0, criteria: { AC1: { summary: "rewritten" } } }));
    const edited = (await readOnlyContext(cwd, git)).active?.outcome;
    expect(edited?.evaluation).toMatchObject({ status: "stale", changedSinceInput: [evidencePath] });
    expect(edited?.criteria[0]?.evaluation).toBe("stale");
    expect(edited?.blockers).toContain(`evaluation stale (changed since input: ${evidencePath})`);
    await writeFile(join(cwd, evidencePath), evaluated);

    await writeFile(join(cwd, "feature.txt"), "changed\n");
    const stale = await readOnlyContext(cwd, git);
    expect(stale.active?.outcome?.evaluation).toMatchObject({ status: "stale", changedSinceInput: ["feature.txt"] });
    expect(stale.active?.outcome?.criteria[0]?.evaluation).toBe("stale");
  });

  it("reports divergence instead of failing", async () => {
    const { cwd: other } = await repository();
    await openOutcome(other, "greeting", "Greeting files exist", [{ id: "AC1", text: "files exist" }]);
    const state = join(other, ".ways/state/current.json");
    const value = JSON.parse(await readFile(state, "utf8")) as Record<string, unknown>;
    await writeFile(state, JSON.stringify({ ...value, baseCommit: "f".repeat(40) }));
    const diverged = await buildContext(other);
    expect(diverged.divergence).toMatch(/diverged/);
    expect(diverged.active?.id).toBe("greeting");
  });

  it("describes legacy SDD and quick work with their own facts", async () => {
    const { cwd, git } = await repository();
    await startSdd(cwd, "auth-refresh", "autonomous");
    const sdd = await readOnlyContext(cwd, git);
    expect(sdd.active).toMatchObject({ id: "auth-refresh", mode: "sdd", phase: "intake", lastCompletedPhase: null, stage: null, attempt: 0, profile: "autonomous", outcome: null });
    expect(sdd.divergence).toBeNull();

    const { cwd: quickCwd, git: quickGit } = await repository();
    await startQuick(quickCwd, "button-spacing");
    const quick = await readOnlyContext(quickCwd, quickGit);
    expect(quick.active).toMatchObject({ id: "button-spacing", mode: "quick", phase: null, stage: null, tasks: [], outcome: null });
  });
});
