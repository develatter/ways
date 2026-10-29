import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GitError, GitRepository, formatTrailers, parseTrailers } from "../src/git/git.js";

let cwd: string;
let git: GitRepository;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ways-git-"));
  git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, "README.md"), "initial\n");
  await git.run(["add", "README.md"]);
  await git.run(["commit", "-q", "-m", "initial"]);
});

describe("GitRepository", () => {
  it("rejects a dirty worktree", async () => {
    await writeFile(join(cwd, "README.md"), "changed\n");
    await expect(git.assertClean()).rejects.toBeInstanceOf(GitError);
  });

  it("exposes exact tree and commit topology primitives", async () => {
    const initial = await git.head();
    const entries = await git.treeEntries(initial);
    expect(entries.map((entry) => entry.path)).toEqual(["README.md"]);
    expect((await git.objectBytes(entries[0]!.object)).toString()).toBe("initial\n");
    expect(await git.resolveRef("HEAD")).toBe(initial);
    expect(await git.parents()).toHaveLength(0);

    await writeFile(join(cwd, "README.md"), "changed\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "change"]);
    expect(await git.parents()).toEqual([initial]);
    expect(await git.changedPathsBetween(initial, "HEAD")).toEqual(["README.md"]);
    expect(await git.mergeBase(initial, "HEAD")).toBe(initial);
    expect(await git.isMergeCommit()).toBe(false);
  });

  it("makes a harness commit of only the given paths, with trailers and without hooks", async () => {
    await git.run(["config", "core.hooksPath", ".hooks"]);
    await writeFile(join(cwd, "record.json"), "{}\n");
    await writeFile(join(cwd, "other.txt"), "staged\n");
    await git.run(["add", "other.txt"]);
    await git.harnessCommit(["record.json"], "chore(ways): close x", { work: "x", state: "closed" });
    const commit = await git.lastCommit();
    expect(commit.subject).toBe("chore(ways): close x");
    expect(commit.trailers).toEqual({ work: "x", state: "closed" });
    expect(await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("record.json");
    expect(await git.dirtyPaths()).toEqual(["other.txt"]);
  });

  it("lists modified, staged, untracked and renamed paths", async () => {
    await writeFile(join(cwd, "README.md"), "changed\n");
    await writeFile(join(cwd, "new file.txt"), "x\n");
    expect(await git.dirtyPaths()).toEqual(["README.md", "new file.txt"]);
  });
});

describe("trailers", () => {
  it("round trip and are read only from the final trailer block", () => {
    const text = formatTrailers({ work: "x", state: "closed" });
    expect(text).toBe("Harness-Work: x\nHarness-State: closed");
    expect(parseTrailers(text)).toEqual({ work: "x", state: "closed" });
    expect(parseTrailers("Harness-Work: quoted in the body\n\nreal text\n\nHarness-Work: y")).toEqual({ work: "y" });
    expect(parseTrailers("Harness-Work: early\n\njust a paragraph")).toEqual({});
  });
});
