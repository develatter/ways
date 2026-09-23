import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";
import { readStatus } from "../src/state/status.js";
import { loadState } from "../src/state/store.js";
import { finishQuick, startQuick } from "../src/work/quick.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-quick-"));
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

describe("quick work", () => {
  it("finishes with checks and an atomic traced commit", async () => {
    const { cwd, git } = await repository();
    await startQuick(cwd, "button-spacing");
    await writeFile(join(cwd, "button.css"), "gap: 1rem;\n");
    await finishQuick(cwd, "fix: space modal buttons", "unchanged");
    const commit = await git.lastCommit();
    expect(commit.trailers).toEqual({ work: "button-spacing", state: "completed" });
    expect(await git.status()).toEqual([]);
  });

  it("commits already staged changes, such as a resolved merge", async () => {
    const { cwd, git } = await repository();
    await startQuick(cwd, "staged");
    await writeFile(join(cwd, "staged.txt"), "staged\n");
    await git.run(["add", "staged.txt"]);
    await finishQuick(cwd, "feat: staged");
    expect(await git.run(["show", "--name-only", "--format=", "HEAD"])).toBe("staged.txt");
    expect(await git.status()).toEqual([]);
  });

  it("keeps the work and its status active when the close is refused", async () => {
    const { cwd } = await repository();
    await startQuick(cwd, "nothing");
    await expect(finishQuick(cwd, "chore: nothing")).rejects.toThrow(/without explicit paths/);
    expect(await loadState(cwd)).toMatchObject({ id: "nothing", status: "active" });
    expect(await readStatus(cwd)).toMatchObject({ active: true, id: "nothing" });
  });
});
