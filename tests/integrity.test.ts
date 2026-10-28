import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";
import { checkIntegrity } from "../src/integrity/integrity.js";

async function installed(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-integrity-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  await bootstrap({ cwd, testCommand: ["npm", "test"] });
  return cwd;
}

describe("integrity", () => {
  it("accepts a fresh bootstrap", async () => {
    expect(await checkIntegrity(await installed())).toEqual([]);
  });

  it("detects a modified managed file", async () => {
    const cwd = await installed();
    await writeFile(join(cwd, "AGENTS.md"), "changed\n");
    expect((await checkIntegrity(cwd)).map((issue) => issue.code)).toContain("managed-file-modified");
  });

  it("verifies adapter settings structurally", async () => {
    const cwd = await installed();
    await writeFile(join(cwd, ".claude/settings.json"), "{}\n");
    expect((await checkIntegrity(cwd)).map((issue) => issue.code)).toContain("adapter-guard-missing");
  });

  it("accepts a CLAUDE.md import or a legacy symlink and rejects a file without the import", async () => {
    const cwd = await installed();
    await writeFile(join(cwd, "CLAUDE.md"), "Notes for Claude.\n\n@AGENTS.md\n");
    expect(await checkIntegrity(cwd)).toEqual([]);
    await rm(join(cwd, "CLAUDE.md"));
    await symlink("AGENTS.md", join(cwd, "CLAUDE.md"));
    expect(await checkIntegrity(cwd)).toEqual([]);
    await rm(join(cwd, "CLAUDE.md"));
    await writeFile(join(cwd, "CLAUDE.md"), "only notes\n");
    const [issue] = await checkIntegrity(cwd);
    expect(issue).toMatchObject({ code: "invalid-claude-md" });
    expect(issue?.message).toContain("@AGENTS.md");
    await rm(join(cwd, "CLAUDE.md"));
    expect((await checkIntegrity(cwd)).map((entry) => entry.code)).toContain("missing-claude-md");
  });
});
