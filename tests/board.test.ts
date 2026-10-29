import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkRecord } from "../src/domain/types.js";
import { appendEvent, type WaysEvent } from "../src/events/bus.js";
import type { InboxItem } from "../src/inbox/inbox.js";
import { gitDirs, writeActive } from "../src/runtime/runtime.js";
import { COLUMNS, deriveBoard, phaseOf, STALL_MS, summarizeSessions, type RepoSnapshot, type WorktreeSnapshot } from "../src/serve/board.js";
import { DemoSource } from "../src/serve/demo.js";
import { LiveSource, SessionTracker } from "../src/serve/live.js";
import { installed } from "./helpers.js";

/*
 * The board is derived, never dragged: these fixtures pin which column each
 * combination of records, runs, hook events and inbox items lands in.
 */
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const SHA = (seed: string): string => seed.repeat(40);

function event(session: string, type: WaysEvent["type"], minutesAgo: number, overrides: Partial<WaysEvent> = {}): WaysEvent {
  return { v: 1, ts: at(minutesAgo), session, agent: "claude", type, hook: "x", worktree: "/repo", branch: "main", work: "w", result: "ok", ms: 1, ...overrides };
}

function record(id: string, extra: Partial<WorkRecord> = {}): WorkRecord {
  return { schemaVersion: 2, id, kind: "outcome", goal: `Goal of ${id}`, criteria: [{ id: "AC1", text: "it works", strength: "test", verify: ["true"] }], policy: { review: "none", approval: "none" }, openedAt: at(60), ...extra } as WorkRecord;
}

function passed(input: string, criteria: Record<string, "passed" | "review-only"> = { AC1: "passed" }, signature: "required" | "optional" = "optional"): WorkRecord["evidence"] {
  return { input: { commit: input }, base: SHA("0"), passed: true, ranAt: at(5), criteria: Object.fromEntries(Object.entries(criteria).map(([id, status]) => [id, { status }])), verifierChanges: [], checks: [], integrity: [], approvals: { signature } } as unknown as WorkRecord["evidence"];
}

function worktree(path: string, records: WorkRecord[], extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  const first = records[0];
  return { path, branch: `b-${path.split("/").pop()}`, head: SHA("1"), active: first && !first.closed ? { id: first.id, kind: first.kind, base: SHA("0") } : null, records, fresh: Object.fromEntries(records.map((entry) => [entry.id, true])), lastRuns: {}, ...extra };
}

function repo(worktrees: WorktreeSnapshot[], events: WaysEvent[] = [], inbox: InboxItem[] = []): RepoSnapshot {
  return { id: "r1", name: "app", top: "/repo", worktrees, sessions: summarizeSessions(events), inbox };
}

function ask(work: string | null, worktree: string, status: InboxItem["status"] = "open"): InboxItem {
  return { v: 1, id: "i-abcdef-00000001", type: "ask", status, title: "?", priority: "normal", work, from: { worktree, session: "s-ask" }, to: { worktree }, createdAt: at(2), updatedAt: at(2), history: [] };
}

describe("sessions from hook events", () => {
  it("tells live, stopped, ended and stalled apart, and ignores what trails a stop", () => {
    const sessions = summarizeSessions([
      event("live", "session.started", 30), event("live", "prompt.submitted", 3), event("live", "tool.finished", 1, { tool: "Edit" }),
      event("stopped", "prompt.submitted", 6), event("stopped", "agent.stopped", 5), event("stopped", "tool.finished", 4.95, { tool: "Edit" }),
      // A stop ways turned into a reminder kept the agent going.
      event("reminded", "prompt.submitted", 6), event("reminded", "agent.stopped", 5, { result: "reminded" }),
      event("ended", "prompt.submitted", 9), event("ended", "session.ended", 8),
      event("stalled", "prompt.submitted", 40), event("stalled", "tool.started", 30, { tool: "Bash" }),
      // pi's tool results are synchronous: one well after a stop is a new turn.
      event("resumed", "agent.stopped", 10), event("resumed", "tool.finished", 2, { tool: "edit", agent: "pi" }),
    ]);
    const phase = Object.fromEntries(sessions.map((session) => [session.session, phaseOf(session, NOW)]));
    expect(phase).toEqual({ live: "live", stopped: "stopped", reminded: "live", ended: "ended", stalled: "stalled", resumed: "live" });
    expect(sessions.find((session) => session.session === "live")?.last).toMatchObject({ type: "tool.finished", tool: "Edit" });
    expect(STALL_MS).toBe(600_000);
  });

  it("follows the bus incrementally, holding back a line still being written", async () => {
    const common = await mkdtemp(join(tmpdir(), "ways-tracker-"));
    const tracker = new SessionTracker(join(common, "ways", "events"));
    expect(tracker.update()).toEqual([]);
    appendEvent({ common }, event("s1", "prompt.submitted", 1, { ts: new Date().toISOString() }));
    expect(tracker.update().map((session) => session.last.type)).toEqual(["prompt.submitted"]);
    const half = JSON.stringify(event("s1", "agent.stopped", 0, { ts: new Date().toISOString() }));
    await appendFile(join(common, "ways", "events", "s1.jsonl"), half.slice(0, 20));
    expect(tracker.update()[0]?.last.type).toBe("prompt.submitted");
    await appendFile(join(common, "ways", "events", "s1.jsonl"), `${half.slice(20)}\n`);
    expect(tracker.update()[0]?.last.type).toBe("agent.stopped");
  });
});

describe("board columns", () => {
  it("places each card by precedence: done, waiting, blocked, verifying, working, preparing", () => {
    const events = [
      event("s-work", "prompt.submitted", 1, { worktree: "/repo/wt-working" }),
      event("s-prep", "prompt.submitted", 1, { worktree: "/repo/wt-preparing" }),
      event("s-ask", "prompt.submitted", 1, { worktree: "/repo/wt-asking" }),
      event("s-stuck", "tool.started", 25, { worktree: "/repo/wt-stalled" }),
      event("s-fail", "agent.stopped", 3, { worktree: "/repo/wt-failing" }),
      event("s-idle", "agent.stopped", 3, { worktree: "/repo/wt-idle" }),
      event("s-new", "prompt.submitted", 1, { worktree: "/repo/wt-nowork", work: null }),
      event("s-old", "agent.stopped", 200, { worktree: "/repo/wt-gone", work: null }),
    ];
    const failing = { "failing": { at: at(4), input: SHA("1"), passed: false, failures: ["criterion AC1 failed: npm test", "    expected 1, got 2"] } };
    const board = deriveBoard([repo([
      worktree("/repo/wt-working", [record("working")]),
      worktree("/repo/wt-preparing", [record("preparing")], { head: SHA("0") }),
      worktree("/repo/wt-asking", [record("asking")]),
      worktree("/repo/wt-blocked", [record("blocked", { blocked: { at: at(9), reason: "needs the sandbox key", input: SHA("1") } })]),
      worktree("/repo/wt-approval", [record("approval", { policy: { review: "none", approval: "required" }, evidence: passed(SHA("a")) })]),
      worktree("/repo/wt-signed", [record("signed", { policy: { review: "none", approval: "required" }, evidence: passed(SHA("a"), { AC1: "passed" }, "required") })]),
      worktree("/repo/wt-review", [record("review", { criteria: [{ id: "AC1", text: "reads well", strength: "review-only" }], evidence: passed(SHA("a"), { AC1: "review-only" }) })]),
      worktree("/repo/wt-stalled", [record("stalled")]),
      worktree("/repo/wt-failing", [record("failing")], { lastRuns: failing }),
      worktree("/repo/wt-idle", [record("idle")]),
      worktree("/repo/wt-done", [record("done", { closed: { at: at(90) } })]),
      worktree("/repo/wt-old", [record("old", { closed: { at: at(8 * 24 * 60) } })]),
      worktree("/repo/wt-nowork", []),
      worktree("/repo/wt-gone", []),
    ], events, [ask("asking", "/repo/wt-asking")])], NOW);

    const column = Object.fromEntries(board.cards.map((card) => [card.work?.id ?? card.worktree, card.column]));
    expect(column).toEqual({
      working: "working", preparing: "preparing", asking: "waiting", blocked: "waiting", approval: "waiting", signed: "waiting",
      review: "verifying", stalled: "blocked", failing: "blocked", idle: "waiting", done: "done", "/repo/wt-nowork": "preparing",
    });
    const card = (id: string) => board.cards.find((entry) => entry.work?.id === id)!;
    expect(card("asking").reasons).toEqual([{ code: "inbox", n: 1 }]);
    expect(card("blocked").reasons).toEqual([{ code: "blocked", text: "needs the sandbox key" }]);
    expect(card("stalled").reasons).toEqual([{ code: "stalled", n: 25 }]);
    expect(card("failing").failing).toEqual(["criterion AC1 failed: npm test"]);
    expect(card("failing").criteria).toMatchObject([{ id: "AC1", state: "failed" }]);
    expect(card("idle").reasons).toEqual([{ code: "turn-ended" }]);
    expect(card("working")).toMatchObject({ agent: "claude", session: "s-work", phase: "live", branch: "b-wt-working", criteria: [{ id: "AC1", state: "pending" }] });
    // Approvals come from the records, with the exact terminal command where only a signature counts.
    const approvals = board.inbox.filter((entry) => entry.binding);
    expect(approvals.map((entry) => [entry.id, entry.binding!.signature, entry.options])).toEqual([["a-r1-approval", false, ["approve"]], ["a-r1-signed", true, []]]);
    expect(approvals[1]!.binding!.command).toBe("cd /repo/wt-signed && ways approve --key=<your SSH key>");
    expect(card("signed").reasons).toEqual([{ code: "approval-signed", text: expect.stringContaining("--approval=required") }]);
    // The board's inbox lists the stored items too, open first.
    expect(board.inbox.map((entry) => entry.id)).toContain("i-abcdef-00000001");
    expect(board.live).toBe(4);
  });

  it("sends a work whose evidence no longer certifies HEAD back to work, without pending review or approval", () => {
    const board = deriveBoard([repo([worktree("/repo/wt", [record("stale", { policy: { review: "none", approval: "required" }, evidence: passed(SHA("a")) })], { fresh: { stale: false } })],
      [event("s1", "prompt.submitted", 1, { worktree: "/repo/wt" })])], NOW);
    expect(board.cards[0]).toMatchObject({ column: "working", approval: null });
    expect(board.inbox).toEqual([]);
  });

  it("the demo fills every column, through the same derivation", async () => {
    const demo = new DemoSource();
    demo.stop();
    const state = await demo.state();
    expect(new Set(state.cards.map((card) => card.column))).toEqual(new Set(COLUMNS));
    expect(state.repos.map((entry) => entry.name)).toEqual(["shop-api", "web-app"]);
    await demo.answer("i-demo01-00000001", { choice: "mock" });
    expect((await demo.state()).inbox.find((entry) => entry.id === "i-demo01-00000001")).toMatchObject({ status: "answered", answer: { choice: "mock" } });
  });
});

describe("the live board", () => {
  it("shows three worktrees, each with its agent and work, from git, records and hook events", async () => {
    const { cwd, git } = await installed();
    const dirs = gitDirs(cwd);
    const paths: string[] = [];
    for (const [index, name] of ["api", "web", "docs"].entries()) {
      const path = join(await mkdtemp(join(tmpdir(), "ways-wt-")), name);
      await git.run(["worktree", "add", "-q", "-b", `feat/${name}`, path]);
      await writeActive(path, { schemaVersion: 1, id: name, kind: "change", base: await git.head(), startedAt: new Date().toISOString(), origin: "start" });
      appendEvent(dirs, { v: 1, ts: new Date().toISOString(), session: `sess-${name}`, agent: index === 1 ? "pi" : "claude", type: "prompt.submitted", hook: "UserPromptSubmit", worktree: path, branch: `feat/${name}`, work: name, result: "silent", ms: 3 });
      paths.push(path);
    }
    await mkdir(join(paths[2]!, "notes"), { recursive: true });
    await writeFile(join(paths[2]!, "notes", "x.md"), "draft\n");
    const live = new LiveSource([cwd, paths[0]!]);
    expect(live.count).toBe(1);
    const state = await live.state();
    const cards = state.cards.filter((card) => card.work);
    expect(cards.map((card) => [card.work!.id, card.agent, card.session, card.branch, card.column]).sort()).toEqual([
      ["api", "claude", "sess-api", "feat/api", "preparing"],
      ["docs", "claude", "sess-docs", "feat/docs", "preparing"],
      ["web", "pi", "sess-web", "feat/web", "preparing"],
    ]);
    expect(state.repos).toEqual([{ id: expect.any(String), name: expect.stringMatching(/^ways-test-/), top: cwd, worktrees: 4 }]);
    expect(state.live).toBe(3);
  });
});
