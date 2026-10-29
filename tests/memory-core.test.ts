import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/git/git.js";
import { inspectOkf } from "../src/knowledge/okf.js";
import { checkMemory, pathsFingerprint, relevantConcepts, remember } from "../src/memory/memory.js";
import { run } from "../src/cli.js";

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-memory-core-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await mkdir(join(cwd, "src/auth"), { recursive: true });
  await writeFile(join(cwd, "src/auth/token.ts"), "export const early = 60;\n");
  await writeFile(join(cwd, "src/other.ts"), "export const other = 1;\n");
  await mkdir(join(cwd, ".ways/knowledge"), { recursive: true });
  await writeFile(join(cwd, ".ways/knowledge/index.md"), "# Knowledge\n");
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "initial"]);
  return { cwd, git };
}

describe("ways remember", () => {
  it("writes one short concept tied to its paths, uncommitted, that memory check accepts", async () => {
    const { cwd, git } = await repository();
    const result = await remember(cwd, "Tokens refresh 60 s before expiry; never on revoked tokens", { paths: ["src/auth/**"], type: "convention" });
    expect(result).toEqual({ path: ".ways/knowledge/conventions/tokens-refresh-60-s-before-expiry-never-on.md", warnings: [] });
    const content = await readFile(join(cwd, result.path), "utf8");
    expect(content).toMatch(/^---\ntype: convention\ntitle: Tokens refresh 60 s before expiry; never on revoked tokens\npaths:\n {2}- src\/auth\/\*\*\ngenerated:\n {2}by: process:ways-remember\n {2}at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n---\n\nTokens refresh/);
    expect(await git.dirtyPaths()).toEqual([result.path]);
    expect((await checkMemory(cwd)).issues).toEqual([]);
    const second = await remember(cwd, "Tokens refresh 60 s before expiry; never on revoked tokens", { paths: ["src/auth/**"] });
    expect(second.path).toMatch(/-2\.md$/);
  });

  it("refuses paths outside the repository and empty facts, and says why", async () => {
    const { cwd } = await repository();
    await expect(remember(cwd, "x y", { paths: ["../elsewhere/**"] })).rejects.toThrow(/repository-relative/);
    await expect(remember(cwd, "   ")).rejects.toThrow(/Nothing to remember/);
    expect((await remember(cwd, "No path given here")).warnings.join(" ")).toMatch(/no --path/);
  });

  it("is one CLI command, also with --path <glob>", async () => {
    const { cwd } = await repository();
    expect(await run(["remember", "Run", "e2e", "with", "npm", "run", "e2e", "--path", "e2e/**", "--type=howto", "--id=e2e-command"], cwd)).toBe(0);
    expect(await readFile(join(cwd, ".ways/knowledge/howto/e2e-command.md"), "utf8")).toContain("Run e2e with npm run e2e");
  });
});

describe("memory freshness and relevance", () => {
  it("points at concepts whose paths cover the changed files", async () => {
    const { cwd, git } = await repository();
    await remember(cwd, "Tokens refresh early", { paths: ["src/auth/**"] });
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "memory"]);
    expect((await relevantConcepts(cwd, ["src/auth/token.ts"])).map((concept) => [concept.title, concept.stale])).toEqual([["Tokens refresh early", false]]);
    expect(await relevantConcepts(cwd, ["src/other.ts"])).toEqual([]);
  });

  it("marks a concept possibly stale when its files change after it, by content, and an edit refreshes it", async () => {
    const { cwd, git } = await repository();
    const { path } = await remember(cwd, "Tokens refresh early", { paths: ["src/auth/**"] });
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "memory"]);
    await git.run(["commit", "-q", "--allow-empty", "-m", "a commit that changes nothing"]);
    expect((await checkMemory(cwd)).warnings).toEqual([]);
    await writeFile(join(cwd, "src/other.ts"), "export const other = 2;\n");
    await git.run(["commit", "-qam", "unrelated"]);
    expect((await checkMemory(cwd)).warnings).toEqual([]);
    await writeFile(join(cwd, "src/auth/token.ts"), "export const early = 30;\n");
    await git.run(["commit", "-qam", "change the code"]);
    expect((await checkMemory(cwd)).warnings).toEqual([expect.objectContaining({ code: "possibly-stale" })]);
    await writeFile(join(cwd, path), (await readFile(join(cwd, path), "utf8")).replace("Tokens refresh early", "Tokens refresh 30 s early"));
    await git.run(["commit", "-qam", "update the memory with the change"]);
    expect((await checkMemory(cwd)).warnings).toEqual([]);
  });

  it("fingerprints only the files under the globs", async () => {
    const { git } = await repository();
    const entries = await git.treeEntries("HEAD");
    expect(pathsFingerprint(entries, ["src/auth/**"])).not.toBe(pathsFingerprint(entries, ["src/**"]));
    expect(pathsFingerprint(entries, ["nothing/**"])).toBe(pathsFingerprint([], ["nothing/**"]));
  });
});

describe("source validation", () => {
  it("fails missing active sources but ignores deprecated history sources", async () => {
    const { cwd, git } = await repository();
    await mkdir(join(cwd, ".ways/knowledge/components"), { recursive: true });
    await writeFile(join(cwd, ".ways/knowledge/components/active.md"), "---\ntype: component\nstatus: draft\nsources:\n  - resource: /src/missing.ts\n---\n");
    await writeFile(join(cwd, ".ways/knowledge/components/old.md"), "---\ntype: component\nstatus: deprecated\nsources:\n  - resource: /src/removed.ts\n---\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "knowledge"]);
    const issues = (await inspectOkf(cwd)).issues;
    expect(issues.map((issue) => issue.code)).toContain("missing-source");
    expect(issues.filter((issue) => issue.path.includes("old.md"))).toEqual([]);
  });
});
