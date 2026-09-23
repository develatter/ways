import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasGuard, mergeClaudeSettings, renderClaude, resolveNames } from "../src/adapters/claude.js";
import { installAdapter, PROVIDERS } from "../src/adapters/install.js";
import { mergeHookEntries } from "../src/adapters/hook-file.js";
import { loadAdapterSource, MAX_ROLE_LINES, nonEmptyLines } from "../src/adapters/source.js";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { run } from "../src/cli.js";
import { GitRepository } from "../src/git/git.js";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { applyUpgrade, planUpgrade } from "../src/upgrade/upgrade.js";
import { loadState, saveState } from "../src/state/store.js";
import { startSdd } from "../src/work/sdd.js";
import { prepareTask } from "../src/work/tasks.js";

const ROLES = ["explorer", "implementer", "reviewer", "qa", "sweeper"];
const COMMANDS = ["status", "query", "quick", "plan", "sdd", "memory"];

async function repository(): Promise<{ cwd: string; git: GitRepository }> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-adapter-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  return { cwd, git };
}

describe("canonical adapter source", () => {
  it("loads every role and command with bounded prompts", async () => {
    const source = await loadAdapterSource();
    expect(source.roles.map((role) => role.name).sort()).toEqual([...ROLES].sort());
    expect(source.commands.map((command) => command.name).sort()).toEqual([...COMMANDS].sort());
    for (const role of source.roles) expect(nonEmptyLines(role.body).length).toBeLessThanOrEqual(MAX_ROLE_LINES);
    expect(source.commands.find((command) => command.name === "memory")?.body).toContain("memory reconcile inspect");
    expect(source.roles.find((role) => role.name === "implementer")?.body).toContain("durable semantic impact");
    expect(source.roles.filter((role) => role.access === "read").map((role) => role.name).sort()).toEqual(["explorer", "reviewer"]);
  });

  it("rejects prompts longer than six lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "ways-source-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "commands"));
    await mkdir(join(root, "roles"));
    await writeFile(join(root, "statusline.sh"), "");
    await writeFile(join(root, "guard.sh"), "");
    await writeFile(join(root, "roles", "long.md"), `---\ndescription: x\naccess: read\n---\n${"line\n".repeat(7)}`);
    await expect(loadAdapterSource(root)).rejects.toThrow(/exceeds 6/);
  });
});

describe("claude renderer", () => {
  it("renders commands, read-only agents, statusline and guard", async () => {
    const files = renderClaude(await loadAdapterSource());
    const byPath = new Map(files.map((file) => [file.path, file]));
    expect(byPath.get(".claude/commands/ways-quick.md")?.content).toMatch(/^---\ndescription: .*\nargument-hint: <id> \[what to change\]\n---\n/);
    expect(byPath.get(".claude/agents/ways-reviewer.md")?.content).toContain("permissionMode: plan");
    expect(byPath.get(".claude/agents/ways-implementer.md")?.content).not.toContain("permissionMode");
    expect(byPath.get(".claude/ways-statusline.sh")?.mode).toBe(0o755);
    expect(byPath.get(".claude/ways-guard.sh")?.mode).toBe(0o755);
  });

  it("merges settings without dropping user keys and stays idempotent", () => {
    const once = mergeClaudeSettings({ theme: "dark", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "mine.sh" }] }] } });
    const twice = mergeClaudeSettings(once.settings);
    expect(twice.settings).toEqual(once.settings);
    expect(once.settings.theme).toBe("dark");
    expect(hasGuard(once.settings)).toBe(true);
    const groups = (once.settings.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).PreToolUse;
    expect(groups.map((group) => group.matcher)).toEqual(["Write", "Bash", "Edit|Write|MultiEdit|NotebookEdit"]);
    expect(groups.flatMap((group) => group.hooks.map((hook) => hook.command))).toEqual(["mine.sh", "\"$CLAUDE_PROJECT_DIR\"/.claude/ways-guard.sh", "\"$CLAUDE_PROJECT_DIR\"/.claude/ways-guard.sh"]);
  });

  it("wraps a user-defined statusline instead of replacing it, idempotently", () => {
    const { settings, notes } = mergeClaudeSettings({ statusLine: { type: "command", command: "my-status.sh --short" } });
    expect((settings.statusLine as { command: string }).command).toBe(".claude/ways-statusline.sh 'my-status.sh --short'");
    expect(notes[0]).toMatch(/wrapped existing statusLine/);
    expect(mergeClaudeSettings(settings).settings).toEqual(settings);
    expect(hasGuard(settings)).toBe(true);
  });

  it("appends the harness status after the wrapped statusline output", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
    const out = execFileSync("sh", [join(cwd, ".claude/ways-statusline.sh"), "printf mine"], { cwd, input: JSON.stringify({ workspace: { project_dir: cwd } }), encoding: "utf8" });
    expect(out).toBe("mine | ways: idle");
  });

  it("resolves neutral placeholders and leaves no provider names in the source", async () => {
    expect(resolveNames("use {{command:quick}} then {{role:reviewer}}")).toBe("use /ways-quick then ways-reviewer");
    const source = await loadAdapterSource();
    const texts = [...source.commands.map((c) => c.body), ...source.roles.map((r) => r.body), source.guard, source.statusline];
    for (const text of texts) expect(text).not.toMatch(/ways-[a-z]/);
  });
});

describe("adapter installation", () => {
  it("bootstrap renders every provider and integrity guards the files", async () => {
    const { cwd } = await repository();
    const manifest = await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
    expect(Object.keys(manifest.adapters ?? {})).toEqual(PROVIDERS.map((adapter) => adapter.id));
    expect(Object.keys(manifest.adapters?.claude ?? {})).toHaveLength(COMMANDS.length + ROLES.length + 2);
    expect(await checkIntegrity(cwd)).toEqual([]);
    await writeFile(join(cwd, ".claude/agents/ways-reviewer.md"), "tampered\n");
    expect((await checkIntegrity(cwd)).map((issue) => issue.code)).toContain("adapter-file-modified");
  });

  it("refuses to overwrite unmanaged files unless forced, and upgrade re-renders", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"], adapters: false });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, ".claude", "commands"), { recursive: true });
    await writeFile(join(cwd, ".claude/commands/ways-quick.md"), "mine\n");
    await expect(installAdapter(cwd, "claude")).rejects.toThrow(/Refusing to overwrite/);
    await installAdapter(cwd, "claude", true);
    await writeFile(join(cwd, ".claude/commands/ways-quick.md"), "tampered\n");
    expect((await planUpgrade(cwd)).modifiedManagedFiles).toEqual([".claude/commands/ways-quick.md"]);
    await expect(applyUpgrade(cwd, new Set())).rejects.toThrow(/overwrite approval/);
    await applyUpgrade(cwd, new Set([".claude/commands/ways-quick.md"]));
    expect(await readFile(join(cwd, ".claude/commands/ways-quick.md"), "utf8")).not.toBe("tampered\n");
    expect(await checkIntegrity(cwd)).toEqual([]);
  });

  it("removes orphaned files and serves the CLI paths", async () => {
    const { cwd, git } = await repository();
    expect(await run(["bootstrap", `--test-command=${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}`, "--no-adapters"], cwd)).toBe(0);
    const manifestPath = join(cwd, ".ways/manifest.json");
    expect(JSON.parse(await readFile(manifestPath, "utf8")).adapters).toBeUndefined();
    expect(await run(["adapter", "list"], cwd)).toBe(0);
    expect(await run(["adapter", "install", "claude"], cwd)).toBe(0);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { adapters: { claude: Record<string, string> } };
    manifest.adapters.claude[".claude/agents/ways-legacy.md"] = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await writeFile(join(cwd, ".claude/agents/ways-legacy.md"), "old\n");
    await installAdapter(cwd, "claude");
    await expect(readFile(join(cwd, ".claude/agents/ways-legacy.md"))).rejects.toThrow();
    await expect(run(["adapter", "install", "nope"], cwd)).rejects.toThrow(/Unknown provider/);
    void git;
  });

  it("statusline and guard read the status artifact with plain shell", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
    const run = (script: string, payload: unknown): { stdout: string; code: number } => {
      try {
        return { stdout: execFileSync("sh", [join(cwd, script)], { cwd, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }), code: 0 };
      } catch (error) {
        const failure = error as { status: number; stdout: string };
        return { stdout: failure.stdout, code: failure.status };
      }
    };
    expect(run(".claude/ways-statusline.sh", { workspace: { project_dir: cwd } }).stdout).toBe("ways: idle");
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "git add . && git commit -m x" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "git -C . commit" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "git log" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_name: "Write", tool_input: { file_path: ".ways/sdd/x/approvals/plan.json" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_name: "Bash", tool_input: { command: "cat > .ways/sdd/x/reviews/latest.json" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_name: "Bash", tool_input: { command: "cp a.json .ways/sdd/x/approvals/plan.json" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_name: "Bash", tool_input: { command: "cat .ways/sdd/x/approvals/plan.json" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_name: "Write", tool_input: { file_path: ".ways/outcomes/x/approvals/0/close.json" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_name: "Bash", tool_input: { command: "cp a.json .ways/outcomes/x/approvals/0/remediate.json" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_name: "Write", tool_input: { file_path: ".ways/outcomes/x/attempts/0/evidence.json" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_name: "Bash", tool_input: { command: "git show HEAD:.ways/sdd/x/reviews/latest.json" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "git status", description: "check before git commit" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "git log --grep commit" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "echo git commit" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "git commitment" }, cwd }).code).toBe(0);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "npm test && git commit -am x" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "command git commit" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "/usr/bin/git commit -m x" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "echo `git commit -m x`" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "sh -c \"git commit -m x\"" }, cwd }).code).toBe(2);
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "x=$(git commit -m x)" }, cwd }).code).toBe(2);
    const git = new GitRepository(cwd);
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "bootstrap"]);
    await startSdd(cwd, "demo", "supervised");
    expect(run(".claude/ways-statusline.sh", { workspace: { project_dir: cwd } }).stdout).toBe("ways: sdd:demo @intake [supervised] HUMAN GATE");
    expect(run(".claude/ways-guard.sh", { tool_input: { command: "git commit -m x" }, cwd }).code).toBe(0);
  });

  it("blocks orchestrator edits during delegated implement but not inside task worktrees", async () => {
    const { cwd, git } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "bootstrap"]);
    const run = (payload: unknown): number => {
      try {
        execFileSync("sh", [join(cwd, ".claude/ways-guard.sh")], { cwd, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    const edit = (dir: string) => ({ tool_name: "Edit", tool_input: { file_path: join(dir, "src.ts") }, cwd });
    const head = await git.head();
    await saveState(cwd, {
      schemaVersion: 1, harnessVersion: "0.1.0", id: "deleg", mode: "sdd", status: "active", profile: "autonomous", execution: "delegated",
      phase: "implement", lastCompletedPhase: "decompose", baseCommit: head, gateCommit: await git.parent(head),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      tasks: [{ id: "api", title: "Build API", status: "ready", dependsOn: [], commits: [] }],
    });
    expect(run(edit(cwd))).toBe(2);
    expect(run({ tool_name: "apply_patch", tool_input: { patch: "*** Add File: src.ts\n+export {};\n" }, cwd })).toBe(2);
    expect(run({ tool_name: "apply_patch", tool_input: { patch: "*** Add File: .ways/sdd/x/reviews/latest.json\n+{}\n" }, cwd })).toBe(2);
    expect(run({ tool_name: "Write", tool_input: { file_path: join(cwd, "new", "deep", "file.ts") }, cwd })).toBe(2);
    expect(run({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(cwd, "n.ipynb") }, cwd })).toBe(2);
    expect(run({ tool_name: "Bash", tool_input: { command: "printf bad > src.ts" }, cwd })).toBe(2);
    expect(run({ tool_name: "Bash", tool_input: { command: "node -e \"require('node:fs').writeFileSync('src.ts', 'bad')\"" }, cwd })).toBe(2);
    expect(run({ tool_name: "Bash", tool_input: { command: "printf 'Goal: x' > .ways/sdd/deleg/implement.md" }, cwd })).toBe(0);
    expect(run({ tool_name: "Bash", tool_input: { command: "npx ways sdd advance" }, cwd })).toBe(0);
    expect(run({ tool_name: "Read", tool_input: { file_path: join(cwd, "src.ts") }, cwd })).toBe(0);
    for (const phase of ["review", "validate"] as const) {
      const current = await loadState(cwd);
      if (!current) throw new Error("missing delegated test state");
      await saveState(cwd, { ...current, phase });
      expect(run(edit(cwd))).toBe(2);
      expect(run({ tool_name: "Bash", tool_input: { command: "tee src.ts" }, cwd })).toBe(2);
      expect(run({ tool_name: "Bash", tool_input: { command: `printf 'Goal: x' > .ways/sdd/deleg/${phase}.md` }, cwd })).toBe(0);
    }
    const current = await loadState(cwd);
    if (!current) throw new Error("missing delegated test state");
    await saveState(cwd, { ...current, phase: "implement" });
    await git.commit(await git.changedPaths(), "sdd(decompose): complete deleg", { work: "deleg", phase: "decompose", state: "completed" });
    const task = await prepareTask(cwd, "api");
    expect(run(edit(task.worktree!))).toBe(0);
    expect(run({ tool_name: "apply_patch", tool_input: { patch: "*** Update File: src.ts\n@@\n-x\n+y\n" }, cwd: task.worktree! })).toBe(0);
    expect(run({ tool_name: "NotebookEdit", tool_input: { notebook_path: join(task.worktree!, "n.ipynb") }, cwd })).toBe(0);
    const statusline = execFileSync("sh", [join(cwd, ".claude/ways-statusline.sh")], { cwd, input: JSON.stringify({ workspace: { project_dir: cwd } }), encoding: "utf8" });
    expect(statusline).toBe("ways: sdd:deleg @implement [autonomous] delegated");
  });
});

describe("codex, cursor and pi renderers", () => {
  it("render commands, read-only roles and guards in each provider's documented shape", async () => {
    const source = await loadAdapterSource();
    const { renderCodex } = await import("../src/adapters/codex.js");
    const { renderCursor } = await import("../src/adapters/cursor.js");
    const { renderPi } = await import("../src/adapters/pi.js");
    const codex = new Map(renderCodex(source).map((file) => [file.path, file]));
    expect([...codex.keys()].filter((path) => path.startsWith(".agents/skills/"))).toHaveLength(COMMANDS.length);
    expect(codex.get(".codex/agents/ways-reviewer.toml")?.content).toContain('sandbox_mode = "read-only"');
    expect(codex.get(".codex/agents/ways-implementer.toml")?.content).not.toContain("sandbox_mode");
    expect(codex.get(".agents/skills/ways-plan/SKILL.md")?.content).toContain("$ways-sdd");
    expect(codex.get(".agents/skills/ways-plan/SKILL.md")?.content).toContain("first word of the arguments the human gave with this skill");
    expect(codex.get(".agents/skills/ways-sdd/SKILL.md")?.content).not.toContain("$ARGUMENTS");
    expect(codex.get(".agents/skills/ways-sdd/SKILL.md")?.content).toContain("`npx ways sdd start` with the arguments the human gave with this skill");
    expect(codex.get(".codex/ways-guard.sh")?.mode).toBe(0o755);
    const cursor = new Map(renderCursor(source).map((file) => [file.path, file]));
    expect(cursor.get(".cursor/skills/ways-quick/SKILL.md")?.content).toContain("disable-model-invocation: true");
    expect(cursor.get(".cursor/agents/ways-reviewer.md")?.content).toContain("readonly: true");
    expect(cursor.get(".cursor/agents/ways-qa.md")?.content).not.toContain("readonly");
    const pi = new Map(renderPi(source).map((file) => [file.path, file]));
    expect(pi.get(".pi/prompts/ways-sdd.md")?.content).toContain("$ARGUMENTS");
    expect(pi.get(".pi/prompts/ways-sdd.md")?.content).toContain("argument-hint:");
    expect(pi.get(".pi/agents/ways-explorer.md")?.content).toContain("tools: read, grep, find, ls");
    expect(pi.get(".pi/agents/ways-sweeper.md")?.content).not.toContain("tools:");
    expect(pi.get(".pi/extensions/ways/index.ts")?.content).toContain('pi.on("tool_call"');
    expect(pi.get(".pi/extensions/ways/index.ts")?.content).toContain("setStatus");
    expect(pi.get(".pi/extensions/ways/index.ts")?.content).toContain("fileURLToPath");
    expect(pi.get(".pi/extensions/ways/index.ts")?.content).toContain("result.code !== 0");
  });

  it("rejects malformed hook containers instead of discarding them", () => {
    expect(() => mergeHookEntries({ hooks: [] }, { PreToolUse: [] }, () => false)).toThrow(/hooks must contain a JSON object/);
    expect(() => mergeHookEntries({ hooks: { PreToolUse: {} } }, { PreToolUse: [] }, () => false)).toThrow(/hooks.PreToolUse must contain an array/);
  });

  it("merges guard hooks into existing hook files idempotently and verifies them", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"], adapters: false });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await writeFile(join(cwd, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }], Stop: [{ hooks: [] }] } }));
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }] } }));
    await installAdapter(cwd, "codex");
    await installAdapter(cwd, "codex");
    await installAdapter(cwd, "cursor");
    await installAdapter(cwd, "cursor");
    await installAdapter(cwd, "pi");
    const codex = JSON.parse(await readFile(join(cwd, ".codex/hooks.json"), "utf8"));
    expect(codex.hooks.PreToolUse.map((group: { matcher: string }) => group.matcher)).toEqual(["Bash", "Bash", "apply_patch|Edit|Write"]);
    expect(codex.hooks.PreToolUse[0].hooks[0].command).toBe("mine.sh");
    expect(codex.hooks.Stop).toEqual([{ hooks: [] }]);
    const cursor = JSON.parse(await readFile(join(cwd, ".cursor/hooks.json"), "utf8"));
    expect(cursor.version).toBe(1);
    expect(cursor.hooks.afterFileEdit).toEqual([{ command: "./format.sh" }]);
    expect(cursor.hooks.beforeShellExecution).toHaveLength(1);
    expect(cursor.hooks.preToolUse).toEqual([{ command: "./.cursor/ways-guard.sh", matcher: "Write", timeout: 30, failClosed: true }]);
    expect(await checkIntegrity(cwd)).toEqual([]);
    await writeFile(join(cwd, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
    expect((await checkIntegrity(cwd)).map((issue) => `${issue.code}:${issue.path}`)).toContain("adapter-guard-missing:.cursor/hooks.json");
    await writeFile(join(cwd, ".codex/hooks.json"), JSON.stringify({ hooks: {} }));
    expect((await checkIntegrity(cwd)).map((issue) => `${issue.code}:${issue.path}`)).toContain("adapter-guard-missing:.codex/hooks.json");
    const guard = (script: string, payload: unknown): number => {
      try {
        execFileSync("sh", [join(cwd, script)], { cwd, input: JSON.stringify(payload), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect(guard(".cursor/ways-guard.sh", { command: "git commit -m x", cwd })).toBe(2);
    expect(guard(".cursor/ways-guard.sh", { tool_name: "Write", tool_input: { path: ".ways/sdd/x/reviews/latest.json" }, cwd })).toBe(2);
    expect(guard(".codex/ways-guard.sh", { tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd })).toBe(2);
    expect(guard(".pi/ways-guard.sh", { tool_name: "Bash", tool_input: { command: "git status" }, cwd })).toBe(0);
  });
});
