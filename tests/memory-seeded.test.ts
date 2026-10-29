import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrief } from "../src/context/brief.js";
import { renderRule } from "../src/context/rules.js";
import { inspectOkf } from "../src/knowledge/okf.js";
import { checkMemory } from "../src/memory/memory.js";
import { stampSeeded } from "../src/memory/verify.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { installed } from "./helpers.js";

const fact = (paths: string, source: string): string => `---\ntype: pitfall\ntitle: Prices are integer cents\npaths: ["${paths}"]\nsources:\n  - resource: ${source}\n---\nPrices are integer cents; never add floats.\n`;

async function seeded(paths = "src/**", source = "/src/money.js"): Promise<Awaited<ReturnType<typeof installed>>> {
  const repo = await installed();
  await mkdir(join(repo.cwd, "src"));
  await writeFile(join(repo.cwd, "src/money.js"), "module.exports = (cents) => cents;\n");
  await mkdir(join(repo.cwd, ".ways/knowledge/pitfalls"), { recursive: true });
  await writeFile(join(repo.cwd, ".ways/knowledge/pitfalls/cents.md"), fact(paths, source));
  await stampSeeded(repo.cwd, ".ways/knowledge/pitfalls/cents.md");
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: seed"]);
  return repo;
}

describe("seeded memory", () => {
  it("marks a fact stale when the file it was read from changes, and keeps showing it", async () => {
    const { cwd } = await seeded();
    expect((await checkMemory(cwd)).warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["unverified"]));
    await writeFile(join(cwd, "src/money.js"), "module.exports = (cents) => cents / 100;\n");
    const memory = await checkMemory(cwd);
    expect(memory.issues).toEqual([]);
    expect(memory.warnings.find((warning) => warning.code === "source-changed")?.message).toContain("src/money.js");
    const brief = await buildBrief(gitDirs(cwd), { touched: ["src/money.js"] });
    const shown = brief.sections.find((section) => section.id.startsWith("memory:"))?.text ?? "";
    expect(shown).toContain("Prices are integer cents");
    expect(shown).toContain("(unverified: seeded by onboarding");
    expect(shown).toContain("(possibly stale");
    const document = (await inspectOkf(cwd, { validateSources: false })).documents.find((entry) => entry.id === "pitfalls/cents")!;
    expect(renderRule(document).content).toContain("ways memory (pitfall, unverified: seeded by onboarding");
  }, 60_000);

  it("refuses a seeded fact whose source or paths name nothing", async () => {
    const { cwd } = await seeded("lib/**", "/src/ghost.js");
    const codes = (await checkMemory(cwd)).issues.map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["seeded-missing-source", "seeded-paths-match-nothing"]));
  }, 60_000);

  it("ways memory confirm needs a person at a terminal", async () => {
    const { cwd } = await seeded();
    const result = spawnSync(process.execPath, [process.env.WAYS_CLI!, "memory", "confirm", "pitfalls/cents"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/needs a person at an interactive terminal.*`ways ask`/s);
    expect(await readFile(join(cwd, ".ways/knowledge/pitfalls/cents.md"), "utf8")).not.toContain("verified:");
  }, 60_000);
});
