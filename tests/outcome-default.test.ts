import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAdapterSource } from "../src/adapters/source.js";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { run } from "../src/cli.js";
import { GitRepository } from "../src/git/git.js";
import { loadState } from "../src/state/store.js";
import { applyUpgrade, planUpgrade } from "../src/upgrade/upgrade.js";
import { advanceSdd, SDD_DEPRECATION, startSdd } from "../src/work/sdd.js";

const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

afterEach(() => {
  log.mockClear();
  error.mockClear();
});

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-default-"));
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

async function fill(cwd: string, id: string, phase: string): Promise<void> {
  const path = join(cwd, `.ways/sdd/${id}/${phase}.md`);
  const content = await readFile(path, "utf8");
  await writeFile(path, content.replace("Goal:", "Goal: deliver behavior").replace("Evidence:", "Evidence: repository inspection"));
}

describe("outcome as the default workflow", () => {
  it("tells agents to open outcome work, with quick for small changes and SDD only as deprecated", async () => {
    const { cwd } = await repository();
    const contract = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(contract).toContain("npx ways outcome open <id>");
    expect(contract).toContain("npx ways quick start <id>");
    expect(contract).toContain("SDD is deprecated");
    expect(contract).not.toMatch(/explore|decompose/);

    const source = await loadAdapterSource();
    expect(source.commands.find((command) => command.name === "outcome")?.body).toContain("npx ways outcome evaluate");
    expect(source.commands.find((command) => command.name === "sdd")?.body).toMatch(/^SDD is deprecated/);
    expect(source.commands.find((command) => command.name === "status")?.body).toContain("{{command:outcome}} (default)");
    expect(await readFile(join(cwd, ".claude/commands/ways-outcome.md"), "utf8")).toContain("npx ways outcome open");
  });

  it("still starts SDD but prints a deprecation notice pointing to outcome", async () => {
    const { cwd } = await repository();
    expect(await run(["sdd", "start", "legacy-work"], cwd)).toBe(0);
    expect(error).toHaveBeenCalledWith(SDD_DEPRECATION);
    expect(SDD_DEPRECATION).toContain("ways outcome open");
    expect((await loadState(cwd))?.mode).toBe("sdd");
  });

  it("upgrades idempotently around active SDD work without rewriting its history", async () => {
    const { cwd, git } = await repository();
    await startSdd(cwd, "legacy-work", "autonomous");
    await fill(cwd, "legacy-work", "intake");
    await advanceSdd(cwd);
    const history = await git.run(["ls-tree", "-r", "HEAD", ".ways/sdd"]);
    const state = await readFile(join(cwd, ".ways/state/current.json"), "utf8");
    const head = await git.head();

    const plan = await planUpgrade(cwd);
    expect(plan.incompatible).toEqual([]);
    expect(plan.activeWork).toEqual([expect.stringContaining("Active SDD work legacy-work (workflow v1, phase explore) continues under its original SDD workflow")]);
    expect(await run(["upgrade"], cwd)).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("continues under its original SDD workflow");

    await applyUpgrade(cwd, new Set());
    const afterFirst = await git.run(["status", "--porcelain"]);
    const manifest = await readFile(join(cwd, ".ways/manifest.json"), "utf8");
    await applyUpgrade(cwd, new Set());
    expect(await git.run(["status", "--porcelain"])).toBe(afterFirst);
    expect(await readFile(join(cwd, ".ways/manifest.json"), "utf8")).toBe(manifest);
    expect(afterFirst).toBe("");

    expect(await git.head()).toBe(head);
    expect(await git.run(["ls-tree", "-r", "HEAD", ".ways/sdd"])).toBe(history);
    expect(await readFile(join(cwd, ".ways/state/current.json"), "utf8")).toBe(state);
    await fill(cwd, "legacy-work", "explore");
    await advanceSdd(cwd);
    expect((await loadState(cwd))?.phase).toBe("assess");
  });

  it("diagnoses incompatible active state and refuses to apply over it", async () => {
    const { cwd } = await repository();
    const state = await startSdd(cwd, "future-workflow", "autonomous");
    await writeFile(join(cwd, ".ways/state/current.json"), JSON.stringify({ ...state, workflowVersion: 2 }));
    const plan = await planUpgrade(cwd);
    expect(plan.incompatible).toEqual([expect.stringContaining("Unsupported SDD workflow version 2")]);
    expect(await run(["upgrade"], cwd)).toBe(1);
    await expect(applyUpgrade(cwd, new Set(["*"]))).rejects.toThrow("Upgrade refused over incompatible active state");
  });
});
