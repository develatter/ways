import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { checkMemory, relevantConcepts } from "../src/memory/memory.js";
import { readActive } from "../src/runtime/runtime.js";
import { applyUpgrade, planUpgrade } from "../src/upgrade/upgrade.js";
import { done } from "../src/work/work.js";
import { GitRepository } from "../src/git/git.js";
import { installed } from "./helpers.js";

const FIXTURE = resolve("tests/fixtures/ways-0.2");

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

/** A clone of the genuine 0.2.2 repository, with its uncommitted active quick work restored. */
async function legacyRepository(): Promise<{ cwd: string; git: GitRepository }> {
  const parent = await mkdtemp(join(tmpdir(), "ways-legacy-"));
  const cwd = join(parent, "repo");
  await new GitRepository(parent).run(["clone", "-q", join(FIXTURE, "repo.bundle"), cwd]);
  const git = new GitRepository(cwd);
  await git.run(["checkout", "-q", "-B", "main", "origin/main"]);
  await git.run(["config", "user.name", "Fixture Dev"]);
  await git.run(["config", "user.email", "dev@example.com"]);
  await git.run(["config", "commit.gpgSign", "false"]);
  await mkdir(join(cwd, ".ways/state"), { recursive: true });
  await copyFile(join(FIXTURE, "active-state.json"), join(cwd, ".ways/state/current.json"));
  await copyFile(join(FIXTURE, "active-status.json"), join(cwd, ".ways/status.json"));
  await copyFile(join(FIXTURE, "dirty-auth.js"), join(cwd, "src/auth.js"));
  return { cwd, git };
}

describe("upgrade from ways 0.2.x", () => {
  it("moves a real 0.2.2 repository to the lean model without losing its memory, checks or active change", async () => {
    const { cwd, git } = await legacyRepository();
    const base = await git.head();
    const plan = await planUpgrade(cwd);
    expect(plan).toMatchObject({ from: "0.2.2", modifiedManagedFiles: [] });
    const applied = await applyUpgrade(cwd, new Set());
    const notes = applied.notes.join("\n");

    const config = JSON.parse(await readFile(join(cwd, ".ways/config.json"), "utf8"));
    expect(config).toEqual({ schemaVersion: 2, harnessVersion: applied.to, enforcement: "observe", testCommand: ["node", "-e", "process.exit(0)"] });

    // Memory: the coverage glob moved onto its concept; shards, watermark and empty indexes are gone.
    const concept = await readFile(join(cwd, ".ways/knowledge/conventions/token-refresh.md"), "utf8");
    expect(concept).toContain("paths:\n  - src/**");
    expect(concept).toContain("Access tokens are refreshed 60 seconds before they expire");
    for (const gone of [".ways/knowledge/coverage/auth.json", ".ways/knowledge/state.json", ".ways/knowledge/system/index.md", ".ways/memory/discovery.json", ".ways/state/current.json", ".ways/status.json", "MAP.md", ".ways/.gitignore", ".claude/ways-guard.sh", ".codex/ways-guard.sh", ".claude/commands/ways-sdd.md", ".claude/agents/ways-implementer.md"]) {
      expect(await exists(join(cwd, gone)), gone).toBe(false);
    }
    expect((await checkMemory(cwd)).issues).toEqual([]);
    expect((await relevantConcepts(cwd, ["src/auth.js"])).map((entry) => entry.path)).toEqual([".ways/knowledge/conventions/token-refresh.md"]);

    // The active quick work continues as a change on the same base; the edit in progress is untouched.
    expect(readActive(cwd)).toMatchObject({ id: "padding", kind: "change", base });
    expect(await readFile(join(cwd, "src/auth.js"), "utf8")).toBe(await readFile(join(FIXTURE, "dirty-auth.js"), "utf8"));
    expect(notes).toMatch(/quick work padding continues as the active change/);
    expect(notes).toMatch(/\.ways\/outcomes\/ hold 0\.2 work artifacts/);
    expect(await exists(join(cwd, ".ways/outcomes/greeting/outcome.json"))).toBe(true);

    // The new hooks are installed; the old guard is gone from Claude's settings; adapters stay installed.
    expect(await git.run(["config", "core.hooksPath"])).toBe(".ways/hooks");
    expect(await readFile(join(cwd, ".ways/hooks/prepare-commit-msg"), "utf8")).toContain("hook prepare-commit-msg");
    expect(JSON.stringify(JSON.parse(await readFile(join(cwd, ".claude/settings.json"), "utf8")))).not.toContain("ways-guard");
    expect(JSON.parse(await readFile(join(cwd, ".ways/manifest.json"), "utf8")).adapters).toHaveProperty("codex");
    expect(await checkIntegrity(cwd)).toEqual([]);

    // The upgraded repository works: the carried-over change finishes with one command.
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "chore: upgrade ways"]);
    expect((await git.commitInfo()).trailers.work).toBe("padding");
    expect((await done(cwd)).status).toBe("closed");

    // Applying again changes nothing.
    await applyUpgrade(cwd, new Set());
    expect(await git.run(["status", "--porcelain"])).toBe("");
  });

  it("reports an active 0.2 outcome with the command that reopens it", async () => {
    const { cwd } = await legacyRepository();
    await writeFile(join(cwd, ".ways/state/current.json"), JSON.stringify({ schemaVersion: 1, harnessVersion: "0.2.2", id: "greeting", mode: "outcome", status: "active", stage: "execute", baseCommit: "0".repeat(40), gateCommit: "0".repeat(40), createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", tasks: [] }));
    const notes = (await applyUpgrade(cwd, new Set())).notes.join("\n");
    expect(notes).toContain("ways outcome open greeting --goal=\"Greet users\" --criterion=\"AC1:greeting.txt says hi\"");
    expect(readActive(cwd)).toBeUndefined();
  });

  it("keeps an edited 0.2 AGENTS.md and needs approval before overwriting an edited managed file", async () => {
    const { cwd } = await legacyRepository();
    await writeFile(join(cwd, "AGENTS.md"), "# Our project\n");
    await writeFile(join(cwd, "scripts/check.sh"), "#!/bin/sh\necho custom\n");
    expect((await planUpgrade(cwd)).modifiedManagedFiles).toEqual(["scripts/check.sh"]);
    await expect(applyUpgrade(cwd, new Set())).rejects.toThrow(/--overwrite=scripts\/check\.sh/);
    const applied = await applyUpgrade(cwd, new Set(["scripts/check.sh"]));
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe("# Our project\n");
    expect(applied.notes.join("\n")).toMatch(/AGENTS\.md is no longer managed by ways and you edited it/);
    expect(await readFile(join(cwd, "scripts/check.sh"), "utf8")).toContain("ways check");
  });

  it("is a no-op on a repository installed by this version", async () => {
    const { cwd, git } = await installed();
    const before = await readFile(join(cwd, ".ways/manifest.json"), "utf8");
    await applyUpgrade(cwd, new Set());
    expect(await readFile(join(cwd, ".ways/manifest.json"), "utf8")).toBe(before);
    expect(await git.run(["status", "--porcelain"])).toBe("");
  });
});
