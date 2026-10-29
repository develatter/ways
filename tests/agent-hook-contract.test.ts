import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_EXTENSION } from "../src/adapters/pi.js";
import { parseEvents } from "../src/events/bus.js";
import { remember } from "../src/memory/memory.js";
import { done, openOutcome } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

/*
 * Contract tests: real payload shapes in (tests/fixtures/hooks), the exact
 * output each agent expects out, through the managed wrapper and the built
 * CLI, as the agent would run them.
 */
const PLACEHOLDER = "/home/user/project";

function fixtures(name: "claude" | "pi", cwd: string): Record<string, Record<string, unknown>> {
  const text = readFileSync(join(import.meta.dirname, "fixtures", "hooks", `${name}.json`), "utf8").replaceAll(PLACEHOLDER, cwd);
  return JSON.parse(text) as Record<string, Record<string, unknown>>;
}

function hook(cwd: string, agent: string, event: string, payload: unknown): { stdout: string; status: number | null; stderr: string } {
  const result = spawnSync("sh", [join(cwd, ".ways/hooks/agent-hook"), agent, event], { cwd, input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8" });
  return { stdout: result.stdout, status: result.status, stderr: result.stderr };
}

function commonDir(cwd: string): string {
  return spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).stdout.trim();
}

function events(cwd: string, session: string): ReturnType<typeof parseEvents> {
  try {
    return parseEvents(readFileSync(join(commonDir(cwd), "ways", "events", `${session}.jsonl`), "utf8"));
  } catch {
    return [];
  }
}

/** An outcome that passed `ways done` and waits for an independent review, with memory about the code it changed. */
async function verifyingOutcome(options: { review?: "required" | "none"; approval?: "required" | "none" } = {}): Promise<string> {
  const { cwd, git } = await installed({ agents: ["claude", "pi"] });
  await mkdir(join(cwd, "src"), { recursive: true });
  await openOutcome(cwd, "greeting", { goal: "Configurable greeting", criteria: ["AC1:the greeting reads config"], verify: ["AC1:test -f src/greeting.ts"], strength: [], review: options.review ?? "required", approval: options.approval ?? "none" });
  await remember(cwd, "Greetings come from config/greeting.json, never hard-coded", { paths: ["src/**"], type: "convention" });
  await git.run(["add", "-A"]);
  await commitFile(git, cwd, "src/greeting.ts", "export const greeting = 'hi';\n", "feat: greeting");
  expect((await done(cwd)).status).toBe("verifying");
  return cwd;
}

describe("Claude Code contract", () => {
  it("answers every event in Claude Code's format, says each thing once, and logs to the shared Git directory", async () => {
    const cwd = await verifyingOutcome();
    const claude = fixtures("claude", cwd);

    const start = hook(cwd, "claude", "SessionStart", claude.SessionStart);
    expect(start.status).toBe(0);
    const started = JSON.parse(start.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(started.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const context = started.hookSpecificOutput.additionalContext;
    expect(context.length).toBeLessThanOrEqual(6000);
    expect(context).toContain("Work: outcome greeting — Configurable greeting");
    expect(context).toContain("- AC1 [test] passed: the greeting reads config");
    expect(context).toContain("Waiting on: an independent review of");
    expect(context).toMatch(/Next: `ways review` \(an independent read-only reviewer of [0-9a-f]{12}; or the ways-reviewer subagent, whose verdict ways records\)/);
    expect(context).toContain("[convention] Greetings come from config/greeting.json, never hard-coded — src/** (.ways/knowledge/conventions/");

    // Nothing changed: the prompt hook stays silent.
    expect(hook(cwd, "claude", "UserPromptSubmit", claude.UserPromptSubmit)).toMatchObject({ status: 0, stdout: "" });

    for (const name of ["PreToolUse.Write.record", "PreToolUse.Bash.record"]) {
      const denied = JSON.parse(hook(cwd, "claude", "PreToolUse", claude[name]).stdout) as { hookSpecificOutput: Record<string, string> };
      expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
      expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(/\.ways\/work\/greeting\.json is a work record.*`ways done`/);
    }
    expect(hook(cwd, "claude", "PreToolUse", claude["PreToolUse.Bash.read"])).toMatchObject({ status: 0, stdout: "" });
    // Claude Code loads memory through .claude/rules, so PostToolUse only logs.
    expect(hook(cwd, "claude", "PostToolUse", claude["PostToolUse.Edit"])).toMatchObject({ status: 0, stdout: "" });

    const stop = JSON.parse(hook(cwd, "claude", "Stop", claude.Stop).stdout) as { decision: string; reason: string };
    expect(stop.decision).toBe("block");
    expect(stop.reason).toMatch(/^ways \(said once\): greeting passed its checks on [0-9a-f]{12} but is not closed: an independent review is required\. Next: /);
    expect(hook(cwd, "claude", "Stop", claude.Stop).stdout).toBe("");
    expect(hook(cwd, "claude", "Stop", claude["Stop.active"]).stdout).toBe("");
    expect(hook(cwd, "claude", "SessionEnd", claude.SessionEnd)).toMatchObject({ status: 0, stdout: "" });

    const log = events(cwd, "abc123-claude-session");
    expect(log.map((event) => `${event.type}:${event.result}`)).toEqual([
      "session.started:injected", "prompt.submitted:silent", "tool.denied:denied", "tool.denied:denied", "tool.started:ok",
      "tool.finished:ok", "agent.stopped:reminded", "agent.stopped:ok", "agent.stopped:ok", "session.ended:ok",
    ]);
    expect(log[0]).toMatchObject({ v: 1, agent: "claude", hook: "SessionStart", worktree: cwd, branch: "main", work: "greeting", detail: "startup" });
    expect(log[0]!.chars).toBe(context.length);
    expect(log[2]).toMatchObject({ tool: "Write", paths: [".ways/work/greeting.json"], detail: "record-write" });
    expect(log[5]).toMatchObject({ tool: "Edit", paths: ["src/greeting.ts"] });
    expect(log.every((event) => typeof event.ms === "number" && !Number.isNaN(Date.parse(event.ts)))).toBe(true);
    // No prompt or file content is ever stored.
    const raw = readFileSync(join(commonDir(cwd), "ways", "events", "abc123-claude-session.jsonl"), "utf8");
    expect(raw).not.toContain("Make the greeting configurable");
    expect(raw).not.toContain("hello");
    // The bus is outside the working tree: nothing shows up in git status.
    expect(spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" }).stdout).toBe("");
  });

  it("re-injects only what changed, and says when a pending item is gone", async () => {
    const cwd = await verifyingOutcome();
    const claude = fixtures("claude", cwd);
    hook(cwd, "claude", "SessionStart", claude.SessionStart);
    const status = JSON.parse(spawnSync(process.execPath, [process.env.WAYS_CLI!, "status", "--json"], { cwd, encoding: "utf8" }).stdout) as { active: { evidence: { input: string } } };
    const input = status.active.evidence.input;
    // The ways-reviewer subagent: ways hands it the review and records its final answer.
    const started = JSON.parse(hook(cwd, "claude", "SubagentStart", claude["SubagentStart.reviewer"]).stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(started.hookSpecificOutput.hookEventName).toBe("SubagentStart");
    expect(started.hookSpecificOutput.additionalContext).toContain("# Independent review of outcome greeting");
    expect(started.hookSpecificOutput.additionalContext).toContain(`"commit": "${input}"`);
    expect(hook(cwd, "claude", "PostToolUse", claude["PostToolUse.Read.reviewer"])).toMatchObject({ status: 0, stdout: "" });
    const answer = claude["SubagentStop.reviewer"]!;
    const stopped = JSON.parse(hook(cwd, "claude", "SubagentStop", { ...answer, last_assistant_message: String(answer.last_assistant_message).replace("<COMMIT>", input) }).stdout) as Record<string, string>;
    expect(stopped.systemMessage).toMatch(/^ways recorded the independent review of [0-9a-f]{12}: pass; the work is closed\.$/);
    const { committedRecord } = await import("../src/work/record.js");
    const { GitRepository } = await import("../src/git/git.js");
    expect((await committedRecord(new GitRepository(cwd), "greeting"))?.review).toMatchObject({ commit: input, verdict: "pass", provenance: { via: "subagent", agentId: "agent-rev01", agentType: "ways-reviewer", session: "abc123-claude-session" } });
    expect(events(cwd, "abc123-claude-session").filter((event) => event.agentId === "agent-rev01").map((event) => event.type)).toEqual(["subagent.started", "tool.finished", "review.recorded"]);
    const prompt = JSON.parse(hook(cwd, "claude", "UserPromptSubmit", claude.UserPromptSubmit).stdout) as { hookSpecificOutput: { additionalContext: string } };
    const delta = prompt.hookSpecificOutput.additionalContext;
    expect(delta).toContain("Work: none active now (closed or cancelled).");
    expect(delta).toContain("Waiting on: nothing.");
    // The memory fact was already given in this session.
    expect(delta).not.toContain("Greetings come from config");
  });

  it("tells the human, not the model, about an approval only the human can give", async () => {
    const cwd = await verifyingOutcome({ review: "none", approval: "required" });
    const stop = JSON.parse(hook(cwd, "claude", "Stop", fixtures("claude", cwd).Stop).stdout) as Record<string, string>;
    expect(stop.decision).toBeUndefined();
    expect(stop.systemMessage).toMatch(/^ways: greeting is waiting for your approval \(the work was opened with --approval=required\): run `ways approve` in your terminal\.$/);
  });

  it("never breaks a session: bad input, no repository or no ways all answer nothing with exit 0", async () => {
    const cwd = await verifyingOutcome();
    const bad = hook(cwd, "claude", "UserPromptSubmit", "{not json");
    expect(bad).toMatchObject({ status: 0, stdout: "" });
    const outside = await mkdtemp(join(tmpdir(), "ways-no-repo-"));
    const cli = (event: string, input: string, dir: string) => spawnSync(process.execPath, [process.env.WAYS_CLI!, "hook", event, "--agent=claude"], { cwd: dir, input, encoding: "utf8" });
    expect(cli("SessionStart", JSON.stringify({ session_id: "x", cwd: outside }), outside)).toMatchObject({ status: 0, stdout: "" });
    const bare = await mkdtemp(join(tmpdir(), "ways-bare-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: bare });
    expect(cli("SessionStart", JSON.stringify({ session_id: "x", cwd: bare }), bare)).toMatchObject({ status: 0, stdout: "" });
    await expect(readFile(join(bare, ".git", "ways", "events", "x.jsonl"))).rejects.toThrow();
    // A payload that is valid JSON but not an object, and an unknown tool, are ignored.
    expect(hook(cwd, "claude", "PreToolUse", "[1,2]")).toMatchObject({ status: 0, stdout: "" });
    expect(hook(cwd, "claude", "PreToolUse", { session_id: "s", cwd, tool_name: "WebFetch", tool_input: { url: "https://example.com" } })).toMatchObject({ status: 0, stdout: "" });
  });

  it("logs an internal error as an event and still answers nothing with exit 0", async () => {
    const cwd = await verifyingOutcome();
    // A directory where the session state file should be makes writing it fail.
    await mkdir(join(commonDir(cwd), "ways", "sessions", "broken-session.json"), { recursive: true });
    const result = hook(cwd, "claude", "SessionStart", { session_id: "broken-session", cwd, hook_event_name: "SessionStart", source: "startup" });
    expect(result).toMatchObject({ status: 0, stdout: "" });
    const log = events(cwd, "broken-session");
    expect(log.at(-1)).toMatchObject({ type: "hook.error", result: "error", hook: "SessionStart" });
    expect(log.at(-1)!.detail).toMatch(/EISDIR|illegal operation|directory/i);
  });
});

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  ui: { setStatus(key: string, text: string): void; notify(message: string, level?: string): void };
  sessionManager: { getSessionId(): string };
}

/** Loads the rendered pi extension with a fake ExtensionAPI and returns its handlers. */
async function loadPiExtension(cwd: string): Promise<{ fire(event: string, payload: unknown): Promise<unknown>; sent: unknown[]; statuses: string[]; notes: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "ways-pi-ext-"));
  const file = join(dir, "index.ts");
  await writeFile(file, PI_EXTENSION);
  const module = (await import(pathToFileURL(file).href)) as { default(pi: unknown): void };
  const handlers = new Map<string, (event: unknown, ctx: FakeCtx) => unknown>();
  const sent: unknown[] = [];
  const statuses: string[] = [];
  const notes: string[] = [];
  module.default({
    on: (event: string, handler: (event: unknown, ctx: FakeCtx) => unknown) => handlers.set(event, handler),
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
  });
  const ctx: FakeCtx = { cwd, hasUI: true, ui: { setStatus: (_key, text) => statuses.push(text), notify: (message) => notes.push(message) }, sessionManager: { getSessionId: () => "pi-session-1" } };
  return { fire: async (event, payload) => await handlers.get(event)!(payload, ctx), sent, statuses, notes };
}

describe("pi contract", () => {
  it("maps pi events onto ways hooks and applies the answers through the extension API", async () => {
    const cwd = await verifyingOutcome();
    const pi = fixtures("pi", cwd);
    const extension = await loadPiExtension(cwd);

    expect(await extension.fire("session_start", pi.session_start)).toBeUndefined();
    expect(extension.statuses.at(-1)).toBe("ways: outcome greeting");
    const first = await extension.fire("before_agent_start", pi.before_agent_start) as { message: { customType: string; content: string; display: boolean } };
    expect(first.message).toMatchObject({ customType: "ways", display: false });
    expect(first.message.content).toContain("Work: outcome greeting — Configurable greeting");
    expect(first.message.content).toContain("Greetings come from config/greeting.json");
    expect(await extension.fire("before_agent_start", pi.before_agent_start)).toBeUndefined();

    expect(await extension.fire("tool_call", pi["tool_call.write.record"])).toEqual({ block: true, reason: expect.stringMatching(/^ways: refused: \.ways\/work\/greeting\.json is a work record/) });
    expect(await extension.fire("tool_call", pi["tool_call.bash.read"])).toBeUndefined();

    // pi has no path rules: the first touch of an area brings its memory, once (here it was already in the brief).
    expect(await extension.fire("tool_result", pi["tool_result.edit"])).toBeUndefined();

    expect(await extension.fire("agent_end", pi.agent_end)).toBeUndefined();
    expect(extension.sent).toEqual([{ message: { customType: "ways", content: expect.stringContaining("an independent review is required"), display: true }, options: { triggerTurn: true } }]);
    await extension.fire("agent_end", pi.agent_end);
    expect(extension.sent).toHaveLength(1);
    await extension.fire("session_shutdown", pi.session_shutdown);

    const log = events(cwd, "pi-session-1");
    expect(log.map((event) => event.type)).toEqual(["session.started", "prompt.submitted", "prompt.submitted", "tool.denied", "tool.started", "tool.finished", "agent.stopped", "agent.stopped", "session.ended"]);
    expect(log.every((event) => event.agent === "pi")).toBe(true);
    expect(log[5]).toMatchObject({ tool: "edit", paths: ["src/greeting.ts"] });
  });

  it("confines a session ways launched as the documentalist to docs/wiki, for every write", async () => {
    const { cwd } = await installed({ agents: ["pi"] });
    const extension = await loadPiExtension(cwd);
    const write = (path: string) => ({ type: "tool_call", toolCallId: "c9", toolName: "write", input: { path, content: "x" } });
    // An ordinary session: a write to code is nobody's business.
    expect(await extension.fire("tool_call", write("src/a.ts"))).toBeUndefined();
    process.env.WAYS_ROLE = "documentalist";
    try {
      expect(await extension.fire("tool_call", write("src/a.ts"))).toEqual({ block: true, reason: expect.stringMatching(/outside docs\/wiki\/, and you are the documentalist/) });
      expect(await extension.fire("tool_call", write(".ways/knowledge/conventions/x.md"))).toMatchObject({ block: true });
      expect(await extension.fire("tool_call", write("docs/wiki/a.md"))).toBeUndefined();
    } finally {
      delete process.env.WAYS_ROLE;
    }
  });

  it("appends the memory of a newly touched area to the tool result", async () => {
    const { cwd, git } = await installed({ agents: ["pi"] });
    await remember(cwd, "Billing amounts are integer cents", { paths: ["billing/**"], type: "pitfall" });
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "docs: billing memory"]);
    const extension = await loadPiExtension(cwd);
    await extension.fire("session_start", { type: "session_start", reason: "startup" });
    const result = { type: "tool_result", toolCallId: "c1", toolName: "read", input: { path: "billing/invoice.ts" }, content: [{ type: "text", text: "file" }], isError: false };
    const changed = await extension.fire("tool_result", result) as { content: Array<{ type: string; text: string }> };
    expect(changed.content[0]).toEqual({ type: "text", text: "file" });
    expect(changed.content[1]!.text).toMatch(/^ways memory for billing\/invoice\.ts:\n- \[pitfall\] Billing amounts are integer cents — billing\/\*\* \(\.ways\/knowledge\/pitfalls\/billing-amounts-are-integer-cents\.md\)$/);
    expect(await extension.fire("tool_result", result)).toBeUndefined();
  });
});
