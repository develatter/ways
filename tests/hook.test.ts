import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_PATH } from "../src/domain/constants.js";
import { addTrailer } from "../src/hooks/hook.js";
import { readActive } from "../src/runtime/runtime.js";
import { committedRecord } from "../src/work/record.js";
import { done, openOutcome } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

async function enforce(cwd: string): Promise<void> {
  const path = join(cwd, CONFIG_PATH);
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...config, enforcement: "enforce" }, null, 2)}\n`);
}

describe("addTrailer", () => {
  it("appends to the trailer block, keeps Git's comment block last and never fills an empty message", () => {
    expect(addTrailer("fix: a\n", "x")).toBe("fix: a\n\nHarness-Work: x\n");
    expect(addTrailer("fix: a\n\nbody\n\nSigned-off-by: Me <me@x>\n", "x")).toBe("fix: a\n\nbody\n\nSigned-off-by: Me <me@x>\nHarness-Work: x\n");
    expect(addTrailer("fix: a\n\n# Please enter the commit message\n# Lines starting with '#'\n", "x")).toBe("fix: a\n\nHarness-Work: x\n\n# Please enter the commit message\n# Lines starting with '#'\n");
    expect(addTrailer("\n# Please enter the commit message\n", "x")).toBe("\n# Please enter the commit message\n");
    expect(addTrailer("fix: a\n\nHarness-Work: y\n", "x")).toBe("fix: a\n\nHarness-Work: y\n");
  });
});

describe("the commit hook", () => {
  it("in observe mode accepts every ordinary commit and traces it", async () => {
    const { cwd, git } = await installed();
    await commitFile(git, cwd, "a.txt", "a\n", "feat: add a");
    expect((await git.commitInfo()).trailers.work).toBe("feat-add-a");
    await git.run(["commit", "-q", "--allow-empty", "-m", "chore: empty", "--no-verify"]);
    // --no-verify skips commit-msg but not prepare-commit-msg.
    expect((await git.commitInfo()).trailers.work).toBe("feat-add-a");
  });

  it("does not attribute the commit that installs ways", async () => {
    const { cwd, git } = await installed();
    expect((await git.commitInfo()).trailers.work).toBeUndefined();
    expect(readActive(cwd)).toBeUndefined();
  });

  it("traces a message written in the editor through commit-msg", async () => {
    const { cwd, git } = await installed();
    await writeFile(join(cwd, "e.txt"), "e\n");
    await git.run(["add", "e.txt"]);
    await git.run(["commit", "-q"], { GIT_EDITOR: `node -e "require('fs').writeFileSync(process.argv[1], 'docs: from the editor\\n')"` });
    expect((await git.commitInfo()).subject).toBe("docs: from the editor");
    // prepare-commit-msg saw an empty message, so commit-msg started and traced the work.
    expect((await git.commitInfo()).trailers.work).toBeDefined();
  });

  it("refuses a hand-made change to a work record in every mode, and WAYS_DISABLE skips it", async () => {
    const { cwd, git } = await installed();
    await openOutcome(cwd, "guarded", { goal: "Guard", criteria: ["AC1:x"], verify: ["AC1:true"], strength: [], review: "none" });
    const path = join(cwd, ".ways/work/guarded.json");
    await writeFile(path, (await readFile(path, "utf8")).replace("\"x\"", "\"y\""));
    await git.run(["add", "-A"]);
    await expect(git.run(["commit", "-q", "-m", "chore: tweak"])).rejects.toMatchObject({ stderr: expect.stringMatching(/only ways writes[\s\S]*git restore --staged \.ways\/work\/guarded\.json/) });
    await expect(git.run(["commit", "-q", "--no-verify", "-m", "chore: tweak"])).rejects.toThrow();
    await git.run(["commit", "-q", "-m", "chore: tweak"], { WAYS_DISABLE: "1" });
  });

  it("lets a merge or cherry-pick carry records that already exist on the other branch", async () => {
    const { cwd, git } = await installed();
    await git.run(["checkout", "-q", "-b", "feature"]);
    await openOutcome(cwd, "merged", { goal: "Merge", criteria: ["AC1:x"], verify: ["AC1:test -f m.txt"], strength: [], review: "none" });
    await commitFile(git, cwd, "m.txt", "m\n", "feat: m");
    expect((await done(cwd)).status).toBe("closed");
    await git.run(["checkout", "-q", "main"]);
    await commitFile(git, cwd, "other.txt", "o\n", "feat: diverge");
    await done(cwd);
    await git.run(["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    expect((await committedRecord(git, "merged"))?.closed).toBeDefined();

    await git.run(["checkout", "-q", "-b", "picked", "main~1"]);
    const close = (await git.run(["log", "--format=%H", "-1", "feature", "--", ".ways/work/merged.json"])).trim();
    await git.run(["cherry-pick", "feature~2", "feature~1", close]);
    expect((await committedRecord(git, "merged"))?.closed).toBeDefined();
  });

  it("in enforce mode refuses commits outside an active work and says how to start one", async () => {
    const { cwd, git } = await installed();
    await enforce(cwd);
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "chore: enforce"], { WAYS_DISABLE: "1" });
    await writeFile(join(cwd, "b.txt"), "b\n");
    await git.run(["add", "b.txt"]);
    await expect(git.run(["commit", "-q", "-m", "feat: b"])).rejects.toMatchObject({ stderr: expect.stringContaining("ways start <id>") });
    expect(readActive(cwd)).toBeUndefined();
  });

  it("runs in well under 100 ms of its own work per commit", async () => {
    const { cwd } = await installed();
    const cli = resolve("dist/cli.js");
    const message = join(cwd, ".git", "TEST_MSG");
    await writeFile(message, "feat: timing\n");
    const durations: number[] = [];
    for (let run = 0; run < 12; run += 1) {
      const started = process.hrtime.bigint();
      const result = spawnSync("node", [cli, "hook", "prepare-commit-msg", message, "message"], { cwd, encoding: "utf8" });
      durations.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(result.status).toBe(0);
    }
    const baseline: number[] = [];
    for (let run = 0; run < 12; run += 1) {
      const started = process.hrtime.bigint();
      spawnSync("node", ["-e", "0"], { encoding: "utf8" });
      baseline.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    const p95 = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95) - 1]!;
    // Node's own start-up is excluded so the bound measures what ways adds.
    expect(p95(durations) - p95(baseline)).toBeLessThan(100);
  });
});
