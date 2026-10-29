import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeClaudeSettings, renderClaude, resolveNames } from "../src/adapters/claude.js";
import { installAdapter, PROVIDERS } from "../src/adapters/install.js";
import { mergeHookEntries } from "../src/adapters/hook-file.js";
import { loadAdapterSource, MAX_ROLE_LINES, nonEmptyLines } from "../src/adapters/source.js";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { run } from "../src/cli.js";
import { checkIntegrity } from "../src/integrity/integrity.js";
import { applyUpgrade, planUpgrade } from "../src/upgrade/upgrade.js";
import { startChange } from "../src/work/work.js";
import { repository } from "./helpers.js";

const ROLES = ["documentalist", "onboarder", "reviewer"];
const COMMANDS = ["orchestrator", "outcome", "remember"];
const AGENT_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
const OLD_GUARD = { matcher: "Bash", hooks: [{ type: "command", command: "\"$CLAUDE_PROJECT_DIR\"/.claude/ways-guard.sh" }] };

describe("canonical adapter source", () => {
  it("loads a few bounded prompts that say what, not step by step", async () => {
    const source = await loadAdapterSource();
    expect(source.roles.map((role) => role.name).sort()).toEqual(ROLES);
    expect(source.commands.map((command) => command.name).sort()).toEqual(COMMANDS);
    for (const role of source.roles) expect(nonEmptyLines(role.body).length).toBeLessThanOrEqual(MAX_ROLE_LINES);
    for (const command of source.commands) expect(nonEmptyLines(command.body).length, command.name).toBeLessThanOrEqual(2);
    const reviewer = source.roles.find((role) => role.name === "reviewer");
    expect(reviewer).toMatchObject({ name: "reviewer", access: "read" });
    expect(reviewer?.body).toContain("ways records it");
    // The documentalist writes the wiki for humans and says it must leave code and the memory alone.
    const documentalist = source.roles.find((role) => role.name === "documentalist");
    expect(documentalist).toMatchObject({ access: "write" });
    expect(documentalist?.body).toMatch(/docs\/wiki/);
    expect(documentalist?.body).toMatch(/Never touch code.*\.ways\/knowledge/);
    // The onboarder writes only what an agent cannot read from the code, and only proposes checks.
    const onboarder = source.roles.find((role) => role.name === "onboarder");
    expect(onboarder?.body).toMatch(/cannot see by reading the code/);
    expect(onboarder?.body).toMatch(/ways runs each and keeps only those that work/);
    expect(onboarder?.body).toMatch(/Never edit code, tests, config or AGENTS\.md/);
  });

  it("rejects prompts longer than six lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "ways-source-"));
    await mkdir(join(root, "commands"));
    await mkdir(join(root, "roles"));
    await writeFile(join(root, "statusline.sh"), "");
    await writeFile(join(root, "roles", "long.md"), `---\ndescription: x\naccess: read\n---\n${"line\n".repeat(7)}`);
    await expect(loadAdapterSource(root)).rejects.toThrow(/exceeds 6/);
  });
});

describe("claude renderer", () => {
  it("renders optional procedures as skills, a read-only reviewer and the status line", async () => {
    const files = renderClaude(await loadAdapterSource());
    const byPath = new Map(files.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual([".claude/agents/ways-documentalist.md", ".claude/agents/ways-onboarder.md", ".claude/agents/ways-reviewer.md", ".claude/skills/ways-orchestrator/SKILL.md", ".claude/skills/ways-outcome/SKILL.md", ".claude/skills/ways-remember/SKILL.md", ".claude/ways-statusline.sh"]);
    expect(byPath.get(".claude/skills/ways-outcome/SKILL.md")?.content).toMatch(/^---\nname: ways-outcome\ndescription: .*\nargument-hint: <id> \[what to deliver\]\n---\n/);
    expect(byPath.get(".claude/agents/ways-reviewer.md")?.content).toContain("permissionMode: plan");
    expect(byPath.get(".claude/ways-statusline.sh")?.mode).toBe(0o755);
  });

  it("merges the agent hooks without dropping user keys or hooks, removes the 0.2 guard and stays idempotent", () => {
    const mine = { matcher: "Write", hooks: [{ type: "command", command: "mine.sh" }] };
    const once = mergeClaudeSettings({ theme: "dark", hooks: { PreToolUse: [mine, OLD_GUARD], Notification: [{ hooks: [{ type: "command", command: "notify.sh" }] }] } });
    expect(once.notes).toContain("removed the retired ways guard hook");
    expect(once.settings.theme).toBe("dark");
    const hooks = once.settings.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number; if?: string; async?: boolean }> }>>;
    expect(Object.keys(hooks).sort()).toEqual([...AGENT_EVENTS, "SubagentStart", "SubagentStop", "Notification"].sort());
    // Only the ways-reviewer subagent is handed the review and has its answer recorded.
    expect(hooks.SubagentStart).toEqual([{ matcher: "ways-reviewer", hooks: [expect.objectContaining({ command: "\"$CLAUDE_PROJECT_DIR\"/.ways/hooks/agent-hook claude SubagentStart" })] }]);
    expect(hooks.SubagentStop).toEqual([{ matcher: "ways-reviewer", hooks: [expect.objectContaining({ command: "\"$CLAUDE_PROJECT_DIR\"/.ways/hooks/agent-hook claude SubagentStop", timeout: 60 })] }]);
    expect(hooks.PreToolUse![0]).toEqual(mine);
    // The guard runs only on calls that could touch a record or switch the hooks off.
    expect(hooks.PreToolUse!.slice(1).map((group) => [group.matcher, group.hooks.map((entry) => entry.if)])).toEqual([
      ["Write|Edit|MultiEdit|NotebookEdit", ["Edit(**/.ways/work/**)", "Write(**/.ways/work/**)"]],
      ["Bash", ["Bash(*.ways/work*)", "Bash(*WAYS_DISABLE*)", "Bash(git commit *)", "Bash(git -c *)", "Bash(git config *)"]],
    ]);
    expect(hooks.PostToolUse![0]).toMatchObject({ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ async: true }] });
    for (const event of AGENT_EVENTS) {
      for (const entry of hooks[event]!.at(-1)!.hooks) expect(entry).toMatchObject({ type: "command", command: `"$CLAUDE_PROJECT_DIR"/.ways/hooks/agent-hook claude ${event}`, timeout: 10 });
    }
    expect(hooks.Stop![0]).not.toHaveProperty("matcher");
    expect(mergeClaudeSettings(once.settings).settings).toEqual(once.settings);
    expect(() => mergeClaudeSettings({ hooks: [] })).toThrow(/hooks must contain a JSON object/);
  });

  it("wraps a user-defined statusline instead of replacing it, idempotently", () => {
    const { settings, notes } = mergeClaudeSettings({ statusLine: { type: "command", command: "my-status.sh --short" } });
    expect((settings.statusLine as { command: string }).command).toBe(".claude/ways-statusline.sh 'my-status.sh --short'");
    expect(notes[0]).toMatch(/wrapped existing statusLine/);
    expect(mergeClaudeSettings(settings).settings).toEqual(settings);
  });

  it("shows the active work after the wrapped statusline output, from the runtime pointer", async () => {
    const { cwd, git } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "chore: install ways"]);
    const status = (): string => execFileSync("sh", [join(cwd, ".claude/ways-statusline.sh"), "printf mine"], { cwd, input: JSON.stringify({ workspace: { project_dir: cwd } }), encoding: "utf8" });
    expect(status()).toBe("mine | ways: idle");
    await startChange(cwd, "padding");
    expect(status()).toBe("mine | ways: change padding");
  });

  it("resolves neutral placeholders and leaves no provider names in the source", async () => {
    expect(resolveNames("use {{command:outcome}} then {{role:reviewer}}")).toBe("use /ways-outcome then ways-reviewer");
    const source = await loadAdapterSource();
    for (const text of [...source.commands.map((c) => c.body), ...source.roles.map((r) => r.body), source.statusline]) expect(text).not.toMatch(/ways-[a-z]/);
  });
});

describe("adapter installation", () => {
  it("knows Claude Code and pi as first class, Codex and Cursor as best effort", () => {
    expect(PROVIDERS.map((adapter) => [adapter.id, adapter.tier])).toEqual([["claude", "default"], ["codex", "best-effort"], ["cursor", "best-effort"], ["pi", "default"]]);
  });

  it("bootstrap renders the default providers and integrity guards their files", async () => {
    const { cwd } = await repository();
    const { manifest } = await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"] });
    expect(Object.keys(manifest.adapters ?? {}).sort()).toEqual(["claude", "pi"]);
    expect(Object.keys(manifest.adapters?.claude ?? {})).toHaveLength(COMMANDS.length + ROLES.length + 1);
    expect(await checkIntegrity(cwd)).toEqual([]);
    await writeFile(join(cwd, ".claude/agents/ways-reviewer.md"), "tampered\n");
    expect((await checkIntegrity(cwd)).map((issue) => issue.code)).toContain("adapter-file-modified");
  });

  it("refuses to overwrite unmanaged files unless forced, and upgrade re-renders", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"], agents: [] });
    const skill = ".claude/skills/ways-outcome/SKILL.md";
    await mkdir(join(cwd, ".claude", "skills", "ways-outcome"), { recursive: true });
    await writeFile(join(cwd, skill), "mine\n");
    await expect(installAdapter(cwd, "claude")).rejects.toThrow(/Refusing to overwrite/);
    await installAdapter(cwd, "claude", true);
    await writeFile(join(cwd, skill), "tampered\n");
    expect((await planUpgrade(cwd)).modifiedManagedFiles).toEqual([skill]);
    await expect(applyUpgrade(cwd, new Set())).rejects.toThrow(/--overwrite=\.claude\/skills\/ways-outcome\/SKILL\.md/);
    await applyUpgrade(cwd, new Set([skill]));
    expect(await readFile(join(cwd, skill), "utf8")).not.toBe("tampered\n");
    expect(await checkIntegrity(cwd)).toEqual([]);
  });

  it("removes orphaned files and serves the CLI paths", async () => {
    const { cwd } = await repository();
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
  });
});

describe("codex, cursor and pi renderers", () => {
  it("render commands and the read-only reviewer in each provider's documented shape", async () => {
    const source = await loadAdapterSource();
    const { renderCodex } = await import("../src/adapters/codex.js");
    const { renderCursor } = await import("../src/adapters/cursor.js");
    const { renderPi } = await import("../src/adapters/pi.js");
    const codex = new Map(renderCodex(source).map((file) => [file.path, file]));
    expect([...codex.keys()].filter((path) => path.startsWith(".agents/skills/"))).toHaveLength(COMMANDS.length);
    expect(codex.get(".codex/agents/ways-reviewer.toml")?.content).toContain('sandbox_mode = "read-only"');
    expect(codex.get(".agents/skills/ways-outcome/SKILL.md")?.content).toContain("the arguments the human gave with this skill");
    expect(codex.get(".agents/skills/ways-outcome/SKILL.md")?.content).not.toContain("$ARGUMENTS");
    const cursor = new Map(renderCursor(source).map((file) => [file.path, file]));
    expect(cursor.get(".cursor/skills/ways-outcome/SKILL.md")?.content).toContain("disable-model-invocation: true");
    expect(cursor.get(".cursor/agents/ways-reviewer.md")?.content).toContain("readonly: true");
    const pi = new Map(renderPi(source).map((file) => [file.path, file]));
    // pi and Codex read the same `.agents/skills`; both write it byte for byte the same.
    expect([...pi.keys()].filter((path) => path.startsWith(".agents/skills/")).sort()).toEqual(COMMANDS.map((name) => `.agents/skills/ways-${name}/SKILL.md`));
    for (const name of COMMANDS) expect(pi.get(`.agents/skills/ways-${name}/SKILL.md`)?.content).toBe(codex.get(`.agents/skills/ways-${name}/SKILL.md`)?.content);
    expect([...pi.keys()].some((path) => path.startsWith(".pi/prompts/"))).toBe(false);
    expect(pi.get(".pi/agents/ways-reviewer.md")?.content).toContain("tools: read, grep, find, ls");
    const extension = pi.get(".pi/extensions/ways/index.ts")?.content ?? "";
    expect(extension).toContain("setStatus");
    expect(extension).toContain("active.json");
    for (const event of ["session_start", "before_agent_start", "tool_call", "tool_result", "agent_end", "session_shutdown"]) expect(extension).toContain(`on("${event}"`);
    expect(extension).toContain(".ways/hooks/agent-hook");
  });

  it("lets pi and Codex share the skills they both read", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"], agents: ["pi", "codex"] });
    expect(await checkIntegrity(cwd)).toEqual([]);
    await installAdapter(cwd, "pi");
    await installAdapter(cwd, "codex");
    await expect(readFile(join(cwd, ".agents/skills/ways-outcome/SKILL.md"), "utf8")).resolves.toContain("name: ways-outcome");
  });

  it("rejects malformed hook containers instead of discarding them", () => {
    expect(() => mergeHookEntries({ hooks: [] }, { PreToolUse: [] }, () => false)).toThrow(/hooks must contain a JSON object/);
    expect(() => mergeHookEntries({ hooks: { PreToolUse: {} } }, { PreToolUse: [] }, () => false)).toThrow(/hooks.PreToolUse must contain an array/);
  });

  it("removes the 0.2 guard from Codex and Cursor hook files and keeps the user's entries", async () => {
    const { cwd } = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "process.exit(0)"], agents: [] });
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await writeFile(join(cwd, ".codex/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }, { matcher: "Bash", hooks: [{ type: "command", command: "\"$(git rev-parse --show-toplevel)\"/.codex/ways-guard.sh" }] }], Stop: [{ hooks: [] }] } }));
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }], beforeShellExecution: [{ command: "./.cursor/ways-guard.sh", timeout: 30, failClosed: true }] } }));
    await installAdapter(cwd, "codex");
    await installAdapter(cwd, "cursor");
    await installAdapter(cwd, "cursor");
    expect(JSON.parse(await readFile(join(cwd, ".codex/hooks.json"), "utf8"))).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }], Stop: [{ hooks: [] }] } });
    expect(JSON.parse(await readFile(join(cwd, ".cursor/hooks.json"), "utf8"))).toEqual({ version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }] } });
    expect(await checkIntegrity(cwd)).toEqual([]);
  });
});
