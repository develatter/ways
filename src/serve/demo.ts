import type { WorkRecord } from "../domain/types.js";
import type { EventType } from "../events/bus.js";
import type { InboxItem } from "../inbox/inbox.js";
import { deriveBoard, type BoardState, type RepoSnapshot, type SessionSummary, type WorktreeSnapshot } from "./board.js";
import { NotFound, type BoardSource } from "./live.js";

/**
 * `ways serve --demo`: made-up repositories, agents and inbox items, run
 * through the real derivation, so the board can be seen without agents.
 * Answers, instructions and approvals change only this in-memory state; a
 * live session "works" every few seconds to show the live updates.
 */
const SHA = (seed: string): string => seed.repeat(40).slice(0, 40);

function evidence(input: string, criteria: Record<string, "passed" | "failed" | "review-only">, minutesAgo: number, now: number): NonNullable<WorkRecord["evidence"]> {
  return {
    input: { commit: input },
    base: SHA("b"),
    passed: !Object.values(criteria).includes("failed"),
    ranAt: new Date(now - minutesAgo * 60_000).toISOString(),
    criteria: Object.fromEntries(Object.entries(criteria).map(([id, status]) => [id, { status }])),
    verifierChanges: [],
    checks: [],
    integrity: [],
  } as unknown as NonNullable<WorkRecord["evidence"]>;
}

function record(id: string, goal: string, criteria: Array<[string, string, string]>, extra: Partial<WorkRecord> = {}): WorkRecord {
  return {
    schemaVersion: 2,
    id,
    kind: "outcome",
    goal,
    criteria: criteria.map(([criterion, text, strength]) => ({ id: criterion, text, strength: strength as never, ...(strength === "review-only" ? {} : { verify: ["npm", "test"] }) })),
    policy: { review: "none", approval: "none" },
    openedAt: new Date().toISOString(),
    ...extra,
  } as WorkRecord;
}

function session(id: string, agent: string, worktree: string, work: string | null, minutesAgo: number, now: number, last: { type: EventType; tool?: string; detail?: string }, state: "live" | "stopped" | "ended"): SessionSummary {
  const ts = new Date(now - minutesAgo * 60_000).toISOString();
  const start = new Date(now - (minutesAgo + 40) * 60_000).toISOString();
  return {
    session: id, agent, worktree, branch: worktree.split("/").pop() ?? null, work, startedAt: start, lastTs: ts,
    last: { type: last.type, hook: "PostToolUse", ...(last.tool ? { tool: last.tool } : {}), ...(last.detail ? { detail: last.detail } : {}), result: "ok", ts },
    stopTs: state === "stopped" ? ts : "", activeTs: state === "live" ? ts : start, endTs: state === "ended" ? ts : "", errors: 0,
  };
}

function tree(path: string, branch: string, head: string, records: WorkRecord[], active: WorktreeSnapshot["active"], extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return { path, branch, head, active, records, fresh: Object.fromEntries(records.map((entry) => [entry.id, true])), lastRuns: {}, ...extra };
}

function item(id: string, input: Partial<InboxItem> & Pick<InboxItem, "type" | "title">, minutesAgo: number, now: number): InboxItem {
  const at = new Date(now - minutesAgo * 60_000).toISOString();
  return { v: 1, id, status: "open", priority: "normal", work: null, from: {}, to: {}, createdAt: at, updatedAt: at, history: [{ at, status: "open", by: input.from?.agent ?? "human" }], ...input };
}

export class DemoSource implements BoardSource {
  private readonly repos: RepoSnapshot[];
  private tick = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(now = Date.now()) {
    const api = "/home/alex/code/shop-api";
    const web = "/home/alex/code/web-app";
    const billing = record("billing-export", "Export monthly invoices as CSV", [["AC1", "GET /invoices/export returns text/csv", "test"], ["AC2", "Amounts use the account currency", "property"], ["AC3", "The export link appears in Settings", "e2e"]]);
    const auth = record("auth-refresh", "Refresh tokens 60 s before they expire", [["AC1", "A token 59 s from expiry is refreshed", "test"], ["AC2", "Refresh failures log the user out", "test"]], { policy: { review: "none", approval: "required" } });
    auth.evidence = evidence(SHA("a"), { AC1: "passed", AC2: "passed" }, 6, now);
    const rate = record("rate-limit", "Limit login attempts per IP", [["AC1", "The 6th attempt within a minute gets 429", "test"]], { blocked: { at: new Date(now - 14 * 60_000).toISOString(), reason: "AC1 needs Redis in the test environment; add the redis service to .ways/config.json or allow an in-memory store", input: SHA("c") } });
    const trim = record("format-trim", "Trim whitespace in imported names", [["AC1", "Imported names have no leading or trailing spaces", "test"], ["AC2", "The import screen explains the change", "review-only"]]);
    trim.evidence = evidence(SHA("d"), { AC1: "passed", AC2: "review-only" }, 3, now);
    const cart = record("cart-total", "Cart total includes shipping", [["AC1", "Total = items + shipping", "property"]], { closed: { at: new Date(now - 125 * 60_000).toISOString() } });
    cart.evidence = evidence(SHA("e"), { AC1: "passed" }, 130, now);
    const stripe = record("stripe-webhooks", "Verify Stripe webhook signatures", [["AC1", "A webhook with a bad signature gets 400", "test"], ["AC2", "A replayed event is ignored", "test"]]);
    const login = record("flaky-login", "Fix the intermittent login test", [["AC1", "login.spec passes 20 runs in a row", "e2e"]]);
    this.repos = [
      {
        id: "demo-api", name: "shop-api", top: api,
        worktrees: [
          tree(api, "feat/billing-export", SHA("1"), [billing], { id: "billing-export", kind: "outcome", base: SHA("0") }, { lastRuns: { "billing-export": { at: new Date(now - 4 * 60_000).toISOString(), input: SHA("1"), passed: false, failures: ["criterion AC2 failed: npm test -- currency", "    expected 12.50 EUR, got 12.5"] } } }),
          tree(`${api}-wt/auth-refresh`, "feat/auth-refresh", SHA("2"), [auth], { id: "auth-refresh", kind: "outcome", base: SHA("0") }),
          tree(`${api}-wt/rate-limit`, "feat/rate-limit", SHA("3"), [rate], { id: "rate-limit", kind: "outcome", base: SHA("0") }),
          tree(`${api}-wt/format-trim`, "fix/format-trim", SHA("4"), [trim], { id: "format-trim", kind: "outcome", base: SHA("0") }),
          tree(`${api}-wt/stripe-webhooks`, "feat/stripe-webhooks", SHA("8"), [stripe], { id: "stripe-webhooks", kind: "outcome", base: SHA("0") }),
        ],
        sessions: [
          session("5f1c2a9e-claude", "claude", api, "billing-export", 0.2, now, { type: "tool.finished", tool: "Edit" }, "live"),
          session("pi-7d21", "pi", `${api}-wt/auth-refresh`, "auth-refresh", 5, now, { type: "agent.stopped" }, "stopped"),
          session("c0ffee42-claude", "claude", `${api}-wt/rate-limit`, "rate-limit", 13, now, { type: "agent.stopped" }, "stopped"),
          session("pi-91ab", "pi", `${api}-wt/format-trim`, "format-trim", 1, now, { type: "tool.finished", tool: "read" }, "live"),
          session("pi-3c3c", "pi", `${api}-wt/stripe-webhooks`, "stripe-webhooks", 3, now, { type: "tool.finished", tool: "bash" }, "live"),
        ],
        inbox: [
          item("i-demo01-00000001", { type: "decision", title: "The Stripe test key is missing in CI: use a mock, or will you add STRIPE_TEST_KEY?", options: ["mock", "I add the key"], default: "mock", priority: "high", work: "stripe-webhooks", from: { agent: "pi", session: "pi-3c3c", worktree: `${api}-wt/stripe-webhooks`, work: "stripe-webhooks" }, to: { session: "pi-3c3c", worktree: `${api}-wt/stripe-webhooks` }, expiresAt: new Date(now + 50 * 60_000).toISOString() }, 3, now),
          item("i-demo02-00000002", { type: "block", title: rate.blocked!.reason, priority: "high", work: "rate-limit", from: { agent: "claude", session: "c0ffee42-claude", worktree: `${api}-wt/rate-limit`, work: "rate-limit" }, to: { session: "c0ffee42-claude", worktree: `${api}-wt/rate-limit` } }, 14, now),
          item("i-demo03-00000003", { type: "ask", title: "Should the CSV include cancelled invoices?", body: "Finance asked for 'all invoices'; cancelled ones have negative totals.", status: "answered", answer: { text: "Yes, in a separate section at the end", by: "human", via: "ui", at: new Date(now - 60_000).toISOString() }, work: "billing-export", from: { agent: "claude", session: "5f1c2a9e-claude", worktree: api, work: "billing-export" }, to: { session: "5f1c2a9e-claude", worktree: api } }, 9, now),
          item("i-demo04-00000004", { type: "instruction", title: "Keep the export under 2 s for 10k invoices; stream it", status: "delivered", from: { by: "human" }, to: { worktree: api }, delivered: { at: new Date(now - 20 * 60_000).toISOString(), session: "5f1c2a9e-claude", agent: "claude", via: "UserPromptSubmit" } }, 25, now),
        ],
      },
      {
        id: "demo-web", name: "web-app", top: web,
        worktrees: [
          tree(web, "main", SHA("5"), [], null),
          tree(`${web}-wt/cart-total`, "feat/cart-total", SHA("6"), [cart], null),
          tree(`${web}-wt/flaky-login`, "fix/flaky-login", SHA("7"), [login], { id: "flaky-login", kind: "outcome", base: SHA("0") }, { lastRuns: { "flaky-login": { at: new Date(now - 18 * 60_000).toISOString(), input: SHA("7"), passed: false, failures: ["check test failed (exit 1)", "    login.spec: timeout after 5000 ms (run 7 of 20)"] } } }),
        ],
        sessions: [
          session("9a8b-claude", "claude", web, null, 0.5, now, { type: "prompt.submitted" }, "live"),
          session("77aa-claude", "claude", `${web}-wt/flaky-login`, "flaky-login", 17, now, { type: "agent.stopped" }, "stopped"),
        ],
        inbox: [],
      },
    ];
    this.timer = setInterval(() => this.work(), 4000);
    this.timer.unref();
  }

  /** A live agent does something every few seconds. */
  private work(): void {
    const tools = ["Edit", "Bash", "Read", "Write"];
    const target = this.repos[0]!.sessions[0]!;
    const ts = new Date().toISOString();
    this.tick += 1;
    target.lastTs = ts;
    target.activeTs = ts;
    target.last = { type: "tool.finished", hook: "PostToolUse", tool: tools[this.tick % tools.length]!, result: "ok", ts };
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async state(): Promise<BoardState> {
    const state = deriveBoard(this.repos);
    return state;
  }

  private find(id: string): InboxItem {
    for (const repo of this.repos) {
      const found = repo.inbox.find((entry) => entry.id === id);
      if (found) return found;
    }
    throw new NotFound(`No inbox item ${id}`);
  }

  async answer(id: string, input: { text?: string; choice?: string }): Promise<void> {
    const at = new Date().toISOString();
    if (id.startsWith("a-")) {
      if (input.choice !== "approve") throw new Error("A work's approval is answered with \"approve\"");
      for (const repo of this.repos) {
        for (const worktree of repo.worktrees) {
          for (const entry of worktree.records) {
            if (id === `a-${repo.id}-${entry.id}`) {
              entry.approval = { by: "demo", at, input: entry.evidence!.input.commit, digest: "demo", reasons: [], via: "board" };
              entry.closed = { at };
              worktree.active = null;
              return;
            }
          }
        }
      }
      throw new NotFound(`Nothing to approve for ${id}`);
    }
    const entry = this.find(id);
    if (entry.status !== "open" && entry.status !== "answered") throw new Error(`${id} is ${entry.status}`);
    const choice = input.choice ?? (entry.options?.includes(input.text ?? "") ? input.text : undefined);
    Object.assign(entry, { status: "answered", updatedAt: at, answer: { text: choice === input.text ? "" : input.text ?? "", ...(choice ? { choice } : {}), by: "human", via: "ui", at } });
    entry.history.push({ at, status: "answered", by: "human" });
  }

  async close(id: string, reason?: string): Promise<void> {
    const entry = this.find(id);
    const at = new Date().toISOString();
    Object.assign(entry, { status: "closed", updatedAt: at, closed: { at, by: "human", ...(reason ? { reason } : {}) } });
    entry.history.push({ at, status: "closed", by: "human" });
  }

  async tell(input: { repo: string; text: string; worktree?: string; session?: string; work?: string }): Promise<void> {
    const repo = this.repos.find((entry) => entry.id === input.repo);
    if (!repo) throw new NotFound(`No repository ${input.repo}`);
    repo.inbox.push(item(`i-demo${String(repo.inbox.length + 10).padStart(2, "0")}-${Date.now().toString(16).slice(-8)}`, { type: "instruction", title: input.text, work: input.work ?? null, from: { by: "human" }, to: { ...(input.worktree ? { worktree: input.worktree } : {}), ...(input.session ? { session: input.session } : {}) } }, 0, Date.now()));
  }

  watched(): string[] {
    return [];
  }
}
