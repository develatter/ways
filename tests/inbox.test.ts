import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEvents } from "../src/events/bus.js";
import { addressedTo, answerItem, claim, closeItem, createItem, deliverTo, getItem, listItems, parseDuration, type InboxItem } from "../src/inbox/inbox.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { cancel, startChange } from "../src/work/work.js";
import { installed, repository } from "./helpers.js";

/*
 * The inbox round trip, as agents run it: `ways ask` from the agent's shell,
 * an answer from the human, and delivery through the managed agent hook of
 * Claude Code and pi, once.
 */
const CLI = resolve("dist/cli.js");

function hook(cwd: string, agent: string, event: string, payload: Record<string, unknown>): string {
  const result = spawnSync("sh", [join(cwd, ".ways/hooks/agent-hook"), agent, event], { cwd, input: JSON.stringify({ cwd, hook_event_name: event, ...payload }), encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

function ways(cwd: string, args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, WAYS_SESSION: "", WAYS_AGENT: "", CLAUDECODE: "", ...env } });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function asked(cwd: string, args: string[], env: Record<string, string>): InboxItem {
  const result = ways(cwd, ["ask", ...args, "--json"], env);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as InboxItem;
}

describe("inbox store", () => {
  it("validates items, answers by option or text, and expires with or without a default", async () => {
    const { cwd } = await repository();
    const dirs = gitDirs(cwd);
    const to = { worktree: cwd };
    expect(() => createItem(dirs, { type: "ask", title: "  ", from: {}, to })).toThrow(/one-line title/);
    expect(() => createItem(dirs, { type: "decision", title: "Pick", options: ["a"], from: {}, to })).toThrow(/two --options/);
    expect(() => createItem(dirs, { type: "ask", title: "Pick", options: ["a", "b"], default: "c", from: {}, to })).toThrow(/--default must be one of/);
    expect(() => createItem(dirs, { type: "ask", title: "Who?", from: {}, to: {} })).toThrow(/recipient/);
    const approval = createItem(dirs, { type: "approval", title: "May I drop the cache table?", from: { agent: "claude" }, to });
    expect(approval.options).toEqual(["approve", "reject"]);
    expect(() => answerItem(dirs, approval.id, { choice: "maybe" }, "human", "cli")).toThrow(/not one of the options/);
    expect(answerItem(dirs, approval.id, { text: "approve" }, "human", "cli").answer).toMatchObject({ choice: "approve", text: "" });
    // Changing the answer is allowed until the agent has it.
    expect(answerItem(dirs, approval.id, { choice: "reject", text: "use a migration" }, "human", "cli").answer).toMatchObject({ choice: "reject", text: "use a migration" });

    const decision = createItem(dirs, { type: "decision", title: "Mock it?", options: ["mock", "key"], default: "mock", from: {}, to, expiresIn: -1 });
    expect(getItem(dirs, decision.id)).toMatchObject({ status: "answered", answer: { choice: "mock", via: "expiry" } });
    const question = createItem(dirs, { type: "ask", title: "Which port?", from: {}, to, expiresIn: -1 });
    expect(getItem(dirs, question.id).status).toBe("expired");
    expect(() => answerItem(dirs, question.id, { text: "8080" }, "human", "cli")).toThrow(/expired; it can no longer be answered/);

    const instruction = createItem(dirs, { type: "instruction", title: "Stream the export", from: { by: "human" }, to });
    expect(() => answerItem(dirs, instruction.id, { text: "ok" }, "human", "cli")).toThrow(/instruction/);
    expect(closeItem(dirs, instruction.id, "human", "not needed").closed).toMatchObject({ by: "human", reason: "not needed" });
    expect(listItems(dirs).map((item) => item.id)).not.toContain(instruction.id);
    expect(listItems(dirs, { all: true }).map((item) => item.id)).toContain(instruction.id);
    expect(getItem(dirs, approval.id).history.map((step) => step.status)).toEqual(["open", "answered", "answered"]);
    expect(() => getItem(dirs, "../../etc/passwd")).toThrow(/Not an inbox item id/);
    expect(parseDuration("90", "--wait")).toBe(90_000);
    expect(parseDuration("10m", "--wait")).toBe(600_000);
    expect(() => parseDuration("soon", "--wait")).toThrow(/duration/);
  });

  it("routes an answer to the asking session, or to whoever starts next in its worktree", async () => {
    const { cwd } = await repository();
    const dirs = gitDirs(cwd);
    const item = createItem(dirs, { type: "ask", title: "?", from: { session: "s1" }, to: { session: "s1", worktree: cwd } });
    expect(addressedTo(item, { session: "s1", agent: "claude", worktree: cwd, work: null })).toBe(true);
    expect(addressedTo(item, { session: "s2", agent: "claude", worktree: cwd, work: null })).toBe(false);
    expect(addressedTo(item, { session: "s2", agent: "claude", worktree: cwd, work: null, starting: true })).toBe(true);
    expect(addressedTo(item, { session: "s2", agent: "claude", worktree: "/elsewhere", work: null, starting: true })).toBe(false);
    const forWork = createItem(dirs, { type: "instruction", title: "x", from: {}, to: { work: "billing" } });
    expect(addressedTo(forWork, { session: "s9", agent: "pi", worktree: "/any", work: "billing" })).toBe(true);
    expect(addressedTo(forWork, { session: "s9", agent: "pi", worktree: "/any", work: "other" })).toBe(false);
    // One delivery only, whoever claims first.
    expect(claim(dirs, item.id)).toBe(true);
    expect(claim(dirs, item.id)).toBe(false);
  });

  it("never reads anything when there is no inbox", async () => {
    const { cwd } = await repository();
    expect(deliverTo(gitDirs(cwd), { session: "s1", agent: "claude", worktree: cwd, work: null }, "Stop")).toBeUndefined();
  });
});

describe("inbox round trip through the agent hooks", () => {
  it("Claude Code: ask from the session's shell, the human answers, the Stop hook delivers it once", async () => {
    const { cwd } = await installed({ agents: ["claude"] });
    const env = await mkdtemp(join(tmpdir(), "ways-env-"));
    // SessionStart exports the session for the agent's later shell commands.
    hook(cwd, "claude", "SessionStart", { session_id: "sess-claude-1", source: "startup" });
    expect(spawnSync("sh", [join(cwd, ".ways/hooks/agent-hook"), "claude", "SessionStart"], { cwd, input: JSON.stringify({ session_id: "sess-claude-1", cwd }), encoding: "utf8", env: { ...process.env, CLAUDE_ENV_FILE: join(env, "env.sh") } }).status).toBe(0);
    expect(readFileSync(join(env, "env.sh"), "utf8")).toBe("export WAYS_SESSION=sess-claude-1\nexport WAYS_AGENT=claude\n");

    const item = asked(cwd, ["Mock Stripe in CI, or will you add the key?", "--options=mock,key"], { WAYS_SESSION: "sess-claude-1", WAYS_AGENT: "claude" });
    expect(item).toMatchObject({ type: "ask", status: "open", from: { agent: "claude", session: "sess-claude-1", worktree: cwd }, to: { session: "sess-claude-1" } });
    // Nothing to deliver while it is open.
    expect(hook(cwd, "claude", "Stop", { session_id: "sess-claude-1", stop_hook_active: false })).toBe("");

    expect(ways(cwd, ["inbox", "answer", item.id, "and", "note", "it", "--choice=mock"]).status).toBe(0);
    // Another session in the same worktree does not take it mid-session.
    expect(hook(cwd, "claude", "UserPromptSubmit", { session_id: "sess-other", prompt: "hi" })).not.toContain(item.id);

    const stop = JSON.parse(hook(cwd, "claude", "Stop", { session_id: "sess-claude-1", stop_hook_active: true })) as { decision: string; reason: string };
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain(`The human answered your question "Mock Stripe in CI, or will you add the key?" (${item.id}): "mock" — and note it`);
    expect(hook(cwd, "claude", "Stop", { session_id: "sess-claude-1", stop_hook_active: true })).toBe("");
    expect(hook(cwd, "claude", "UserPromptSubmit", { session_id: "sess-claude-1", prompt: "go on" })).not.toContain(item.id);
    expect(getItem(gitDirs(cwd), item.id)).toMatchObject({ status: "delivered", delivered: { session: "sess-claude-1", agent: "claude", via: "Stop" } });
    const events = parseEvents(readFileSync(join(cwd, ".git", "ways", "events", "sess-claude-1.jsonl"), "utf8"));
    expect(events.filter((event) => event.type === "agent.stopped").map((event) => event.result)).toEqual(["ok", "reminded", "ok"]);
  });

  it("pi: an instruction from the human arrives with the next prompt, once", async () => {
    const { cwd } = await installed({ agents: ["pi"] });
    hook(cwd, "pi", "SessionStart", { session_id: "pi-sess-1" });
    const told = ways(cwd, ["inbox", "tell", "Stream", "the", "export", "--json"]);
    expect(told.status, told.stderr).toBe(0);
    const item = JSON.parse(told.stdout) as InboxItem;
    expect(item).toMatchObject({ type: "instruction", status: "open", to: { worktree: cwd } });
    const answer = JSON.parse(hook(cwd, "pi", "UserPromptSubmit", { session_id: "pi-sess-1", prompt: "continue" })) as { context: string };
    expect(answer.context).toContain(`Instruction from the human (${item.id}): Stream the export`);
    expect(hook(cwd, "pi", "UserPromptSubmit", { session_id: "pi-sess-1", prompt: "again" })).not.toContain(item.id);
    expect(getItem(gitDirs(cwd), item.id).status).toBe("delivered");
  });

  it("pi: an answer is delivered at its Stop as a message that starts a turn", async () => {
    const { cwd } = await installed({ agents: ["pi"] });
    const item = asked(cwd, ["Which", "region?"], { WAYS_SESSION: "pi-sess-2", WAYS_AGENT: "pi" });
    answerItem(gitDirs(cwd), item.id, { text: "eu-west-1" }, "human", "ui");
    const answer = JSON.parse(hook(cwd, "pi", "Stop", { session_id: "pi-sess-2" })) as { message: string };
    expect(answer.message).toContain("eu-west-1");
    expect(hook(cwd, "pi", "Stop", { session_id: "pi-sess-2" })).toBe("");
  });

  it("a new session in the worktree picks up an answer its predecessor never got", async () => {
    const { cwd } = await installed({ agents: ["claude"] });
    const item = asked(cwd, ["Keep the old endpoint?"], { WAYS_SESSION: "gone-session", WAYS_AGENT: "claude" });
    answerItem(gitDirs(cwd), item.id, { text: "yes, for one release" }, "human", "ui");
    const start = JSON.parse(hook(cwd, "claude", "SessionStart", { session_id: "new-session", source: "startup" })) as { hookSpecificOutput: { additionalContext: string } };
    expect(start.hookSpecificOutput.additionalContext).toContain("yes, for one release");
  });

  it("ways ask --wait returns the answer and counts as delivered; times out with 2", async () => {
    const { cwd } = await installed({ agents: ["claude"] });
    const child = spawn(process.execPath, [CLI, "ask", "Ship", "it?", "--options=yes,no", "--wait=20s", "--json"], { cwd, env: { ...process.env, WAYS_SESSION: "sess-wait", WAYS_AGENT: "claude", WAYS_INBOX_POLL_MS: "100" } });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const exited = new Promise<number | null>((done) => child.on("close", done));
    const dirs = gitDirs(cwd);
    let open: InboxItem | undefined;
    for (let attempt = 0; attempt < 100 && !open; attempt += 1) {
      open = listItems(dirs).find((entry) => entry.title === "Ship it?");
      if (!open) await new Promise((done) => setTimeout(done, 50));
    }
    answerItem(dirs, open!.id, { choice: "yes" }, "human", "ui");
    expect(await exited).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id: open!.id, status: "delivered", answer: { choice: "yes" }, delivered: { via: "wait", session: "sess-wait" } });
    // The hook does not say it again.
    expect(hook(cwd, "claude", "Stop", { session_id: "sess-wait" })).toBe("");

    const timeout = ways(cwd, ["ask", "Anyone?", "--wait=1s"], { WAYS_INBOX_POLL_MS: "100" });
    expect(timeout.status).toBe(2);
    expect(timeout.stdout).toMatch(/No answer yet .* still open/);
  });

  it("ways block lands in the inbox, and cancelling the work closes it", async () => {
    const { cwd } = await installed();
    await startChange(cwd, "needs-redis");
    const result = ways(cwd, ["block", "AC1 needs Redis in the test environment; add the service or allow an in-memory store"], { WAYS_SESSION: "sess-block", WAYS_AGENT: "claude" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/inbox i-/);
    const [item] = listItems(gitDirs(cwd));
    expect(item).toMatchObject({ type: "block", status: "open", priority: "high", work: "needs-redis", to: { session: "sess-block" } });
    await cancel(cwd);
    expect(getItem(gitDirs(cwd), item!.id)).toMatchObject({ status: "closed", closed: { by: "ways", reason: "the work was cancelled" } });
  });

  it("every inbox command speaks JSON and explains its usage errors", async () => {
    const { cwd } = await installed();
    const item = asked(cwd, ["Port?", "--type=decision", "--options=8080,9090", "--default=8080", "--expires=1h", "--priority=high"], {});
    expect(item).toMatchObject({ type: "decision", priority: "high", default: "8080" });
    expect(JSON.parse(ways(cwd, ["inbox", "--json"]).stdout)).toHaveLength(1);
    expect(JSON.parse(ways(cwd, ["inbox", "show", item.id, "--json"]).stdout)).toMatchObject({ id: item.id });
    expect(JSON.parse(ways(cwd, ["inbox", "answer", item.id, "--choice=9090", "--json"]).stdout)).toMatchObject({ status: "answered", answer: { choice: "9090", by: "cli", via: "cli" } });
    expect(JSON.parse(ways(cwd, ["inbox", "close", item.id, "--reason=done", "--json"]).stdout)).toMatchObject({ status: "closed" });
    expect(ways(cwd, ["inbox", "show"]).stderr).toMatch(/Usage: ways inbox show <id>[\s\S]*ways inbox --help/);
    expect(ways(cwd, ["inbox", "show", "nope"]).stderr).toMatch(/Not an inbox item id/);
    expect(ways(cwd, ["ask"]).stderr).toMatch(/Usage: ways ask/);
    expect(ways(cwd, ["ask", "x", "--type=block"]).stderr).toMatch(/--type must be ask, decision, approval/);
    // Items are runtime: outside Git history, private to the user.
    expect(spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).stdout).toBe("");
    expect(statSync(join(cwd, ".git", "ways", "inbox")).isDirectory()).toBe(true);
    await writeFile(join(cwd, ".git", "ways", "inbox", "garbage.json"), "{nope");
    expect(JSON.parse(ways(cwd, ["inbox", "--all", "--json"]).stdout)).toHaveLength(1);
  });
});
