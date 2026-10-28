import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../src/domain/types.js";
import { migrateLivingMemory, runMigrations } from "../src/upgrade/migrations.js";

async function legacyRepository(): Promise<{ cwd: string; config: HarnessConfig }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-migration-"));
  await mkdir(join(cwd, ".ways/indexes"), { recursive: true });
  await mkdir(join(cwd, ".ways/knowledge"), { recursive: true });
  await mkdir(join(cwd, ".ways/sdd/old-work"), { recursive: true });
  await writeFile(join(cwd, ".ways/.gitignore"), "worktrees/\n");
  await writeFile(join(cwd, ".ways/indexes/search.json"), "tracked legacy cache\n");
  await writeFile(join(cwd, ".ways/sdd/old-work/reconcile-memory.md"), "# certified under v0.1\n");
  return {
    cwd,
    config: { schemaVersion: 1, harnessVersion: "0.1.0", testCommand: ["true"], defaultBranch: "master" },
  };
}

describe("living-memory compatibility migration", () => {
  it("is idempotent, drops only cache data, and preserves old certifications", async () => {
    const { cwd, config } = await legacyRepository();
    await migrateLivingMemory({ cwd, config });
    const discovery = await readFile(join(cwd, ".ways/memory/discovery.json"), "utf8");
    await migrateLivingMemory({ cwd, config });

    expect(config.memory).toMatchObject({ releaseBranch: "master", relevantPaths: ["**/*"] });
    expect(await readFile(join(cwd, ".ways/.gitignore"), "utf8")).toBe("worktrees/\nindexes/\n");
    await expect(readFile(join(cwd, ".ways/indexes/search.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cwd, ".ways/memory/discovery.json"), "utf8")).toBe(discovery);
    expect(await readFile(join(cwd, ".ways/sdd/old-work/reconcile-memory.md"), "utf8")).toBe("# certified under v0.1\n");
    for (const directory of ["coverage", "roadmap", "debt", "deprecated"]) {
      expect(await import("node:fs/promises").then(({ stat }) => stat(join(cwd, ".ways/knowledge", directory)))).toMatchObject({});
    }
  });

  it("advances the version once and has no path that reinterprets legacy state", async () => {
    const { cwd, config } = await legacyRepository();
    await runMigrations({ cwd, config }, "0.2.0");
    expect(config.harnessVersion).toBe("0.2.0");
    await runMigrations({ cwd, config }, "0.2.0");
    expect(config.harnessVersion).toBe("0.2.0");
  });

  it("moves the recorded version between releases without structural changes, and refuses newer state", async () => {
    const { cwd, config } = await legacyRepository();
    config.harnessVersion = "0.2.0";
    await runMigrations({ cwd, config }, "0.3.0-dev.0");
    expect(config.harnessVersion).toBe("0.3.0-dev.0");
    await expect(runMigrations({ cwd, config }, "0.2.0")).rejects.toThrow(/newer or unknown ways/);
  });
});
