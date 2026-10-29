import { readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrap, DEFAULT_AGENTS } from "../src/bootstrap/bootstrap.js";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { repository } from "./helpers.js";

async function tracked(cwd: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(cwd, path));
    }
  };
  await walk(cwd);
  return found.filter((path) => path !== ".gitkeep").sort();
}

describe("bootstrap", () => {
  it("installs Claude Code and pi by default in at most 30 files, and passes integrity", async () => {
    const { cwd } = await repository();
    const result = await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(DEFAULT_AGENTS).toEqual(["claude", "pi"]);
    const files = await tracked(cwd);
    expect(files.length).toBeLessThanOrEqual(30);
    expect(result.files).toEqual(files);
    expect(Object.keys(result.manifest.adapters ?? {}).sort()).toEqual(["claude", "pi"]);
    expect(files.some((path) => path.startsWith(".codex/") || path.startsWith(".cursor/"))).toBe(false);
    // pi reads the Agent Skills directory; Claude Code only its own.
    expect(files.filter((path) => path.includes("/skills/")).sort()).toEqual([
      ".agents/skills/ways-outcome/SKILL.md", ".agents/skills/ways-remember/SKILL.md",
      ".claude/skills/ways-outcome/SKILL.md", ".claude/skills/ways-remember/SKILL.md",
    ]);
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const config = JSON.parse(await readFile(join(cwd, ".ways/config.json"), "utf8"));
    expect(config).toMatchObject({ schemaVersion: 2, enforcement: "observe", testCommand: ["npm", "test"] });
    expect(Object.keys(result.manifest.managedFiles).sort()).toEqual([".ways/hooks/agent-hook", ".ways/hooks/commit-msg", ".ways/hooks/prepare-commit-msg", "scripts/check.sh"]);
    expect(await checkIntegrity(cwd)).toEqual([]);
  });

  it("installs Codex and Cursor only when asked", async () => {
    const { cwd } = await repository();
    const result = await bootstrap({ cwd, testCommand: ["npm", "test"], agents: ["claude", "pi", "codex", "cursor"] });
    expect(Object.keys(result.manifest.adapters ?? {}).sort()).toEqual(["claude", "codex", "cursor", "pi"]);
    await expect(bootstrap({ cwd, testCommand: ["npm", "test"], agents: ["nope"] })).rejects.toThrow(/Unknown provider: nope/);
  });

  it("seeds AGENTS.md once and then leaves it to the project", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toContain("## Project");
    await writeFile(join(cwd, "AGENTS.md"), "# My project\n");
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe("# My project\n");
    expect(await checkIntegrity(cwd)).toEqual([]);
  });

  it("does not overwrite an edited managed file or config without --force", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    await writeFile(join(cwd, "scripts/check.sh"), "#!/bin/sh\n");
    await expect(bootstrap({ cwd, testCommand: ["npm", "test"] })).rejects.toThrow("overwrite scripts/check.sh");
    await bootstrap({ cwd, testCommand: ["npm", "test"], force: true });
    await expect(bootstrap({ cwd, testCommand: ["yarn", "test"] })).rejects.toThrow(/overwrite \.ways\/config\.json/);
  });

  it("keeps an existing CLAUDE.md and only adds the AGENTS.md import, once", async () => {
    const { cwd } = await repository();
    await writeFile(join(cwd, "CLAUDE.md"), "Prefer tabs.");
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("Prefer tabs.\n\n@AGENTS.md\n");
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("Prefer tabs.\n\n@AGENTS.md\n");
  });

  it("does not write CLAUDE.md without the Claude adapter", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: ["npm", "test"], agents: ["pi"] });
    await expect(readFile(join(cwd, "CLAUDE.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await checkIntegrity(cwd)).toEqual([]);
  });

  it("leaves a symlink from an earlier bootstrap alone and refuses a foreign one without --force", async () => {
    const { cwd } = await repository();
    await symlink("AGENTS.md", join(cwd, "CLAUDE.md"));
    await bootstrap({ cwd, testCommand: ["npm", "test"] });
    expect(await readlink(join(cwd, "CLAUDE.md"))).toBe("AGENTS.md");
    await rm(join(cwd, "CLAUDE.md"));
    await symlink("elsewhere.md", join(cwd, "CLAUDE.md"));
    await expect(bootstrap({ cwd, testCommand: ["npm", "test"] })).rejects.toThrow(/--force/);
    await bootstrap({ cwd, testCommand: ["npm", "test"], force: true });
    expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("writes nothing that points at the ways repository itself or at removed workflows", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: ["npm", "test"], agents: ["claude", "pi", "codex", "cursor"] });
    const leaks: string[] = [];
    for (const path of await tracked(cwd)) {
      const content = await readFile(join(cwd, path), "utf8");
      const match = content.match(/(?:^|[^\w.-])(?:src\/|assets\/)|ROADMAP|HANDOFF|docs\/decisions|\bsdd\b|\bSDD\b|ways plan|ways quick|ways task|ways-guard/m);
      if (match) leaks.push(`${path}: ${match[0].trim()}`);
    }
    expect(leaks).toEqual([]);
  });
});
