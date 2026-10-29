import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { buildBrief } from "../src/context/brief.js";
import { guard } from "../src/hooks/guard.js";
import { loadIndexes } from "../src/knowledge/indexes.js";
import { checkHistory } from "../src/integrity/history.js";
import { checkMemory, remember } from "../src/memory/memory.js";
import { queryKnowledgeResult } from "../src/query/query.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { installed } from "./helpers.js";

/*
 * The wiki (docs/wiki) is for people; the memory (.ways/knowledge) is for
 * agents. These tests pin the four ways they are kept apart (docs/WIKI.md).
 */

const ROLE = { ...process.env, WAYS_ROLE: "documentalist" };

async function write(cwd: string, path: string, content: string): Promise<void> {
  await mkdir(join(cwd, path, ".."), { recursive: true });
  await writeFile(join(cwd, path), content);
}

describe("1. context and the memory index never read the wiki", () => {
  it("does not bring up memory because a wiki page was touched, changed or is uncommitted", async () => {
    const { cwd, git } = await installed();
    // docs/ is tracked, as in a project with documentation; an untracked folder would be shown by git as just `docs/`.
    await write(cwd, "docs/README.md", "# Docs\n");
    await remember(cwd, "Docs are written in British English", { paths: ["docs/**"], id: "docs-english" });
    await git.run(["add", "-A"]);
    // Without the hooks, so no change is started and only what is touched or uncommitted is in play.
    await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "docs: a convention for docs"]);
    const dirs = gitDirs(cwd);

    await write(cwd, "docs/wiki/a.md", "# A page\n\nWritten for people.\n");
    // Touching, and having uncommitted, a wiki page: nothing.
    const quiet = await buildBrief(dirs, { touched: ["docs/wiki/a.md"] });
    expect(quiet.memory).toEqual([]);
    // The same concept does apply to the docs that are not the wiki.
    await write(cwd, "docs/other.md", "x\n");
    const loud = await buildBrief(dirs, { touched: ["docs/other.md"] });
    expect(loud.memory.map((concept) => concept.path)).toEqual([".ways/knowledge/conventions/docs-english.md"]);
    const uncommitted = await buildBrief(dirs);
    expect(uncommitted.memory.map((concept) => concept.path)).toEqual([".ways/knowledge/conventions/docs-english.md"]);
  });

  it("shows nothing of the wiki in `ways context`, whatever a concept's paths cover", async () => {
    const { cwd, git } = await installed();
    await write(cwd, "docs/README.md", "# Docs\n");
    await remember(cwd, "Docs are written in British English", { paths: ["docs/**"], id: "docs-english" });
    await remember(cwd, "Everything is UTF-8", { paths: ["**"], id: "utf8" });
    await git.run(["add", "-A"]);
    await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "docs: conventions"]);
    await write(cwd, "docs/wiki/zebra.md", "---\ntitle: Zebracorn\n---\n\nThe zebracorn page, for humans.\n");
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (chunks.push(String(chunk)), true));
    try {
      expect(await run(["context", "--json", "--session=s1"], cwd)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const brief = JSON.parse(chunks.join("")) as { memory: unknown[]; sections: Array<{ text: string }> };
    expect(brief.memory).toEqual([]);
    expect(JSON.stringify(brief)).not.toMatch(/zebra|docs\/wiki/i);
  });

  it("does not make a concept stale when only the wiki changed", async () => {
    const { cwd, git } = await installed();
    await remember(cwd, "Docs are written in British English", { paths: ["docs/**"], id: "docs-english" });
    await write(cwd, "docs/wiki/a.md", "one\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "docs: convention and wiki"]);
    await write(cwd, "docs/wiki/a.md", "two\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "docs: reword the wiki"]);
    expect((await checkMemory(cwd)).warnings.filter((warning) => warning.code === "possibly-stale")).toEqual([]);
    await write(cwd, "docs/other.md", "changed\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "docs: other docs"]);
    expect((await checkMemory(cwd)).warnings.filter((warning) => warning.code === "possibly-stale")).toHaveLength(1);
  });

  it("indexes and searches only .ways/knowledge", async () => {
    const { cwd } = await installed();
    await remember(cwd, "Tokens refresh sixty seconds early", { paths: ["src/auth/**"], id: "tokens" });
    await write(cwd, "docs/wiki/zebra.md", "---\ntitle: Zebracorn\nkind: explanation\n---\n\nThe zebracorn explanation, for humans.\n");
    const indexes = await loadIndexes(cwd);
    expect(indexes.catalog.documents.map((document) => document.id)).toEqual(["conventions/tokens"]);
    expect(Object.keys(indexes.search.terms)).not.toContain("zebracorn");
    expect((await queryKnowledgeResult(cwd, "zebracorn")).hits).toEqual([]);
    expect((await queryKnowledgeResult(cwd, "tokens")).hits.map((hit) => hit.path)).toEqual([".ways/knowledge/conventions/tokens.md"]);
  });
});

describe("2. the documentalist cannot write outside docs/wiki", () => {
  const top = "/repo";
  const as = (tool: string, toolInput: unknown, role?: string) => guard({ tool, toolInput, top, cwd: top, enforcement: "observe", ...(role ? { role } : {}) });

  it("refuses file tools and shell writes to code, config and the memory, and allows the wiki", () => {
    for (const [tool, input] of [
      ["Write", { file_path: "/repo/src/a.ts" }],
      ["Edit", { file_path: ".ways/knowledge/conventions/x.md" }],
      ["MultiEdit", { file_path: "/repo/docs/other.md" }],
      ["write", { path: "package.json" }],
      ["Write", { file_path: "/etc/passwd" }],
      ["Write", { file_path: "../elsewhere.md" }],
      ["Bash", { command: "echo x > src/a.ts" }],
      ["Bash", { command: "sed -i 's/a/b/' .ways/knowledge/conventions/x.md" }],
      ["Bash", { command: "cd docs && rm other.md" }],
      ["Bash", { command: "cp docs/wiki/a.md .ways/knowledge/conventions/a.md" }],
    ] as const) {
      const verdict = as(tool, input, "documentalist");
      expect(verdict.code, `${tool} ${JSON.stringify(input)}`).toBe("role-scope");
      expect(verdict.deny).toMatch(/you are the documentalist: you write only the wiki for humans/);
    }
    for (const [tool, input] of [
      ["Write", { file_path: "/repo/docs/wiki/a.md" }],
      ["Edit", { file_path: "docs/wiki/reference/b.md" }],
      ["Bash", { command: "echo x > docs/wiki/a.md" }],
      ["Bash", { command: "cd docs/wiki && echo x > a.md" }],
      ["Bash", { command: "ways wiki check 2>&1 | head" }],
      ["Read", { file_path: "/repo/src/a.ts" }],
    ] as const) expect(as(tool, input, "documentalist").deny, `${tool} ${JSON.stringify(input)}`).toBeUndefined();
  });

  it("changes nothing for sessions that are not the documentalist's", () => {
    expect(as("Write", { file_path: "/repo/src/a.ts" })).toEqual({ paths: ["src/a.ts"] });
    expect(as("Bash", { command: "echo x > src/a.ts" })).toEqual({ paths: [] });
    expect(as("Write", { file_path: "/repo/src/a.ts" }, "someone-else")).toEqual({ paths: ["src/a.ts"] });
  });

  it("does not let the documentalist switch the commit hooks off, in any enforcement mode", () => {
    expect(as("Bash", { command: "WAYS_DISABLE=1 git commit -m x" }, "documentalist").code).toBe("hooks-bypass");
    expect(as("Bash", { command: "WAYS_DISABLE=1 git commit -m x" })).toEqual({ paths: [] });
  });

  it("does not let the documentalist drop its role to commit outside the wiki", () => {
    for (const command of ["WAYS_ROLE= git commit -m x", "WAYS_ROLE=other git commit -am x", "env -u WAYS_ROLE git commit -m x", "unset WAYS_ROLE; git commit -m x", "export WAYS_ROLE=; git commit -m x"]) {
      expect(as("Bash", { command }, "documentalist").code, command).toBe("hooks-bypass");
      expect(as("Bash", { command }), command).toEqual({ paths: [] });
    }
    // Reading about it is fine.
    expect(as("Bash", { command: "grep -rn WAYS_ROLE docs/wiki" }, "documentalist").deny).toBeUndefined();
    expect(as("Bash", { command: "echo $WAYS_ROLE" }, "documentalist").deny).toBeUndefined();
  });

  it("answers through the real hook from the environment ways set, and logs the role", async () => {
    const { cwd } = await installed();
    const hook = (env: NodeJS.ProcessEnv): Record<string, unknown> => {
      const result = spawnSync("sh", [join(cwd, ".ways/hooks/agent-hook"), "claude", "PreToolUse"], { cwd, env, encoding: "utf8", input: JSON.stringify({ session_id: "wiki-s1", cwd, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(cwd, "src/a.ts"), content: "x" } }) });
      return result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : {};
    };
    const denied = hook(ROLE) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(denied.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(denied.hookSpecificOutput?.permissionDecisionReason).toMatch(/documentalist/);
    expect(hook({ ...process.env, WAYS_ROLE: "" })).toEqual({});
    const { readSessionEvents } = await import("../src/events/bus.js");
    const events = readSessionEvents(gitDirs(cwd), "wiki-s1");
    expect(events[0]).toMatchObject({ type: "tool.denied", role: "documentalist", detail: "role-scope", paths: ["src/a.ts"] });
    expect(events[1]).not.toHaveProperty("role");
  });
});

describe("3. a documentation commit cannot touch .ways/knowledge", () => {
  it("is refused by the commit hook in a documentalist session, and accepted when it stays in docs/wiki", async () => {
    const { cwd, git } = await installed();
    await write(cwd, "docs/wiki/a.md", "# A page\n");
    await write(cwd, ".ways/knowledge/conventions/c.md", "---\ntype: convention\ntitle: c\n---\nA memory\n");
    await git.run(["add", "-A"]);
    const refused = await git.run(["commit", "-q", "-m", "docs: wiki and memory"], ROLE).then(() => "committed", (error: Error) => error.message);
    expect(refused).toMatch(/refused: this commit comes from the documentalist session and changes \.ways\/knowledge\/conventions\/c\.md, outside docs\/wiki\//);
    expect(await git.run(["log", "-1", "--format=%s"])).toBe("chore: install ways");

    await git.run(["restore", "--staged", ".ways/knowledge/conventions/c.md"]);
    await git.run(["commit", "-q", "-m", "docs: wiki"], ROLE);
    const message = await git.run(["log", "-1", "--format=%B"]);
    expect(message).toMatch(/Harness-Work: \S+\nHarness-Role: documentalist\s*$/);
    // Someone who is not the documentalist may commit the memory, with the wiki or without it.
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "docs: remember"]);
    expect(await git.run(["log", "-1", "--format=%s"])).toBe("docs: remember");
  });

  it("is also caught afterwards by the history audit, for a commit that skipped the hook", async () => {
    const { cwd, git } = await installed();
    await write(cwd, "docs/wiki/a.md", "# A page\n");
    await write(cwd, "src/x.ts", "export {};\n");
    await git.run(["add", "-A"]);
    await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "docs: sneaky", "-m", "Harness-Role: documentalist"]);
    const issues = await checkHistory(cwd);
    expect(issues).toMatchObject([{ code: "history-role-scope" }]);
    expect(issues[0]!.message).toMatch(/is the documentalist's but changes src\/x\.ts, outside docs\/wiki\//);
    // A documentalist commit that stays in the wiki is fine.
    await write(cwd, "docs/wiki/b.md", "# B\n");
    await git.run(["add", "docs/wiki/b.md"]);
    await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "docs: fine", "-m", "Harness-Role: documentalist"]);
    expect((await checkHistory(cwd)).filter((issue) => issue.message.includes("docs: fine"))).toEqual([]);
  });
});

describe("4. the memory cannot cite the wiki", () => {
  it("fails `ways memory check` when a concept's sources, paths or links point into docs/wiki", async () => {
    const { cwd, git } = await installed();
    await write(cwd, "docs/wiki/a.md", "# A page\n");
    await write(cwd, "docs/other.md", "# Other\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "docs: pages"]);
    const concept = (name: string, front: string, body = "A fact."): Promise<void> => write(cwd, `.ways/knowledge/conventions/${name}.md`, `---\ntype: convention\ntitle: ${name}\n${front}---\n\n${body}\n`);
    await concept("by-source", "sources:\n  - resource: /docs/wiki/a.md\n");
    await concept("by-paths", "paths:\n  - docs/wiki/**\n");
    await concept("by-link", "", "See [the page](../../../docs/wiki/a.md).");
    await concept("fine", "sources:\n  - resource: /docs/other.md\npaths:\n  - docs/**\n");
    const result = await checkMemory(cwd);
    const citations = result.issues.filter((issue) => issue.code === "okf-wiki-citation");
    expect(citations.map((issue) => issue.path).sort()).toEqual(["conventions/by-link.md", "conventions/by-paths.md", "conventions/by-source.md"]);
    expect(citations[0]!.message).toMatch(/points into docs\/wiki\/, the wiki for humans; a memory is grounded in the code[\s\S]*the wiki cites the memory, not the reverse/);
    expect(result.issues.filter((issue) => issue.path.includes("fine"))).toEqual([]);
    await expect(loadIndexes(cwd)).rejects.toThrow(/okf-wiki-citation|points into docs\/wiki/);
  });

  it("lets the wiki cite the memory", async () => {
    const { cwd } = await installed();
    await remember(cwd, "Tokens refresh sixty seconds early", { paths: ["src/auth/**"], id: "tokens" });
    await write(cwd, "docs/wiki/explanation/tokens.md", "---\ntitle: Tokens\nkind: explanation\nsources:\n  - .ways/knowledge/conventions/tokens.md\nreviewed: 2026-10-29\n---\n\n# Tokens\n");
    const { checkWiki } = await import("../src/wiki/check.js");
    const report = await checkWiki(cwd);
    expect(report.issues.filter((issue) => issue.code === "missing-source" || issue.code === "frontmatter")).toEqual([]);
  });
});
