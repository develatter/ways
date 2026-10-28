import { mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { GitRepository } from "../src/git/git.js";

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-bootstrap-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  return cwd;
}

describe("bootstrap", () => {
  it("installs the complete portable contract", async () => {
    const cwd = await repository();
    const manifest = await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(await readFile(join(cwd, "scripts/check.sh"), "utf8")).toContain("ways check");
    expect(manifest.managedFiles["AGENTS.md"]).toMatch(/^[a-f0-9]{64}$/);
    const config = JSON.parse(await readFile(join(cwd, ".ways/config.json"), "utf8"));
    expect(config.testCommand).toEqual(["npm", "test"]);
    expect(config.memory).toMatchObject({ releaseBranch: "main", reconciliationBranchPattern: "reconcile/*" });
    expect(await readFile(join(cwd, ".ways/.gitignore"), "utf8")).toContain("indexes/");
    for (const type of ["roadmap", "debt", "deprecated"]) expect(await readFile(join(cwd, `.ways/knowledge/${type}/index.md`), "utf8")).toContain("# Concepts");
    expect(JSON.parse(await readFile(join(cwd, ".ways/memory/discovery.json"), "utf8"))).toMatchObject({ kind: "bootstrap", status: "review-required" });
    await expect(readFile(join(cwd, ".ways/indexes/search.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes interrupted or repeated installation but does not overwrite divergence", async () => {
    const cwd = await repository();
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    const pending = await readFile(join(cwd, ".ways/memory/discovery.json"), "utf8");
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, ".ways/memory/discovery.json"), "utf8")).toBe(pending);
    await writeFile(join(cwd, "AGENTS.md"), "local contract\n");
    await expect(bootstrap({ cwd, testCommand: ["npm", "test"] })).rejects.toThrow("overwrite AGENTS.md");
  });

  it("keeps an existing CLAUDE.md and only adds the AGENTS.md import, once", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "CLAUDE.md"), "Prefer tabs.");
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("Prefer tabs.\n\n@AGENTS.md\n");
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("Prefer tabs.\n\n@AGENTS.md\n");
  });

  it("leaves a symlink from an earlier bootstrap alone and refuses a foreign one without --force", async () => {
    const cwd = await repository();
    await symlink("AGENTS.md", join(cwd, "CLAUDE.md"));
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readlink(join(cwd, "CLAUDE.md"))).toBe("AGENTS.md");
    await rm(join(cwd, "CLAUDE.md"));
    await symlink("elsewhere.md", join(cwd, "CLAUDE.md"));
    await expect(bootstrap({ cwd, testCommand: ["npm", "test"] })).rejects.toThrow(/--force/);
    await bootstrap({ cwd, testCommand: ["npm", "test"], force: true });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("writes nothing that points at the ways repository itself", async () => {
    const cwd = await repository();
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    const leaks: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.name === ".git") continue;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const content = await readFile(path, "utf8");
          const match = content.match(/(?:^|[^\w.-])(?:src\/|assets\/)|ROADMAP|HANDOFF|docs\/decisions/m);
          if (match) leaks.push(`${relative(cwd, path)}: ${match[0].trim()}`);
        }
      }
    };
    await walk(cwd);
    expect(leaks).toEqual([]);
    // The adapters for every provider were rendered, so this covers commands, roles, guard and statusline too.
    expect((await readdir(join(cwd, ".claude/agents"))).length).toBeGreaterThan(0);
    expect((await readdir(join(cwd, ".pi"))).length).toBeGreaterThan(0);
  });
});
