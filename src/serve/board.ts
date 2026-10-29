import type { WorkRecord } from "../domain/types.js";
import type { EventType, WaysEvent } from "../events/bus.js";
import type { InboxItem } from "../inbox/inbox.js";
import type { LastRun } from "../runtime/runtime.js";
import { approvalsPolicy, isOpen, pending } from "../work/policy.js";

/**
 * The board: a projection, never dragged by hand. Each card is a work in a
 * worktree (or an agent session in a worktree with no work yet), placed in a
 * column by what the records, the last `ways done`, the hook events and the
 * inbox say. `deriveBoard` is pure over snapshots, so the rules are tested
 * from fixtures; `live.ts` takes the snapshots.
 */
export const COLUMNS = ["preparing", "working", "verifying", "blocked", "waiting", "done"] as const;
export type Column = (typeof COLUMNS)[number];

/** No hook event for this long, while the agent has not stopped: probably stuck. */
export const STALL_MS = 10 * 60 * 1000;
/** Closed works stay in Done this long. */
export const DONE_MS = 7 * 24 * 3600 * 1000;
/** A session with no work stays on the board this long after its last event. */
export const IDLE_SESSION_MS = 60 * 60 * 1000;

/** What the events say about one agent session. */
export interface SessionSummary {
  session: string;
  agent: string;
  worktree: string;
  branch: string | null;
  work: string | null;
  startedAt: string;
  lastTs: string;
  last: { type: EventType; hook: string; tool?: string; result: string; detail?: string; ts: string };
  /** Latest Stop that let the agent stop (not one where ways kept it going). */
  stopTs: string;
  /** Latest sign of a turn going on: a prompt, a session start, a tool call. */
  activeTs: string;
  endTs: string;
  errors: number;
}

const ACTIVITY: ReadonlySet<string> = new Set(["session.started", "prompt.submitted", "tool.started", "tool.denied", "subagent.started", "subagent.stopped", "review.recorded"]);
/** A tool result logged this long after a stop is a new turn (pi's results are synchronous; Claude's may trail the stop). */
const TRAILING_MS = 5000;

function later(a: string, b: string): string {
  return a > b ? a : b;
}

/** Folds one event into its session's summary. Events may arrive out of order (rotated files): timestamps decide. */
export function foldEvent(summary: SessionSummary | undefined, event: WaysEvent): SessionSummary {
  const last = { type: event.type, hook: event.hook, ...(event.tool ? { tool: event.tool } : {}), result: event.result, ...(event.detail ? { detail: event.detail } : {}), ts: event.ts };
  const next: SessionSummary = summary ? { ...summary } : {
    session: event.session, agent: event.agent, worktree: event.worktree, branch: event.branch, work: event.work,
    startedAt: event.ts, lastTs: event.ts, last, stopTs: "", activeTs: "", endTs: "", errors: 0,
  };
  if (event.ts < next.startedAt) next.startedAt = event.ts;
  if (!summary || event.ts >= next.lastTs) {
    next.lastTs = event.ts;
    next.last = last;
    next.worktree = event.worktree;
    next.branch = event.branch;
    next.work = event.work;
    next.agent = event.agent;
  }
  if (event.type === "agent.stopped") {
    // A stop ways turned into a reminder kept the agent working.
    if (event.result === "reminded") next.activeTs = later(next.activeTs, event.ts);
    else next.stopTs = later(next.stopTs, event.ts);
  } else if (event.type === "session.ended") {
    next.endTs = later(next.endTs, event.ts);
  } else if (ACTIVITY.has(event.type)) {
    next.activeTs = later(next.activeTs, event.ts);
  } else if (event.type === "tool.finished" && next.stopTs && Date.parse(event.ts) - Date.parse(next.stopTs) > TRAILING_MS) {
    next.activeTs = later(next.activeTs, event.ts);
  }
  if (event.type === "hook.error") next.errors += 1;
  return next;
}

export function summarizeSessions(events: readonly WaysEvent[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  for (const event of events) sessions.set(event.session, foldEvent(sessions.get(event.session), event));
  return [...sessions.values()];
}

export type SessionPhase = "live" | "stopped" | "ended" | "stalled";

export function phaseOf(session: SessionSummary, now: number): SessionPhase {
  if (session.endTs && session.endTs >= session.activeTs) return "ended";
  if (session.stopTs && session.stopTs >= session.activeTs) return "stopped";
  return now - Date.parse(session.lastTs) > STALL_MS ? "stalled" : "live";
}

export interface WorktreeSnapshot {
  path: string;
  branch: string | null;
  head: string | null;
  /** This worktree's own active pointer (not the main worktree's). */
  active: { id: string; kind: string; base: string } | null;
  /** Records in this worktree's tree: open ones and those closed recently. */
  records: WorkRecord[];
  /** Work id → its evidence still certifies HEAD (only the record changed since). */
  fresh: Record<string, boolean>;
  lastRuns: Record<string, LastRun>;
}

export interface RepoSnapshot {
  id: string;
  name: string;
  top: string;
  worktrees: WorktreeSnapshot[];
  sessions: SessionSummary[];
  inbox: InboxItem[];
  problem?: string;
}

export type CriterionState = "passed" | "failed" | "review" | "pending";

/** Why a card is in its column: a code the page translates, with a count or a text where one applies. */
export interface Reason {
  code: "closed" | "inbox" | "blocked" | "approval" | "approval-signed" | "problem" | "stalled" | "failing-idle" | "review" | "no-work" | "turn-ended-no-work" | "ended-no-work" | "fixing" | "no-commits" | "turn-ended" | "session-ended" | "no-agent";
  n?: number;
  text?: string;
}

export interface Card {
  /** Stable across refreshes: repo, worktree and work. */
  key: string;
  repo: string;
  repoName: string;
  column: Column;
  /** Why it is in that column. */
  reasons: Reason[];
  work: { id: string; kind: string; goal: string | null } | null;
  worktree: string;
  branch: string | null;
  head: string | null;
  agent: string | null;
  session: string | null;
  /** Sessions seen in this worktree that are still live. */
  liveSessions: number;
  phase: SessionPhase | null;
  last: SessionSummary["last"] | null;
  updatedAt: string | null;
  criteria: Array<{ id: string; text: string; strength: string; state: CriterionState }>;
  /** What the last `ways done` on HEAD failed on. */
  failing: string[];
  /** Open inbox items addressed to the human about this card. */
  inbox: number;
  approval: { reason: string; input: string; signature: boolean; command: string } | null;
  review: string | null;
  blocked: string | null;
  closedAt: string | null;
}

/** An inbox entry on the board: a stored item, or an approval derived from a work record. */
export type InboxEntry = InboxItem & {
  repo: string;
  repoName: string;
  /** Approvals of a work are not stored in the inbox: they come from the record, and answering one records a ways approval. */
  binding?: { work: string; input: string; worktree: string; signature: boolean; command: string };
};

export interface BoardState {
  v: 1;
  generatedAt: string;
  repos: Array<{ id: string; name: string; top: string; worktrees: number; problem?: string }>;
  cards: Card[];
  inbox: InboxEntry[];
  /** Live agent sessions across the repositories. */
  live: number;
}

const HUMAN_TYPES: ReadonlySet<string> = new Set(["ask", "decision", "approval", "block"]);

function since(now: number, iso: string): number {
  return Math.round((now - Date.parse(iso)) / 60000);
}

function criteriaOf(record: WorkRecord | undefined, fresh: boolean, lastRun: LastRun | undefined, head: string | null): Card["criteria"] {
  return (record?.criteria ?? []).map((criterion) => {
    const entry = fresh ? record!.evidence?.criteria[criterion.id] : undefined;
    let state: CriterionState = "pending";
    if (entry) state = entry.status === "review-only" ? "review" : entry.status;
    else if (lastRun && lastRun.input === head) {
      if (lastRun.failures.some((line) => line.startsWith(`criterion ${criterion.id} `))) state = "failed";
      else state = criterion.strength === "review-only" ? "review" : "passed";
    }
    return { id: criterion.id, text: criterion.text, strength: criterion.strength, state };
  });
}

function failingOf(lastRun: LastRun | undefined, head: string | null): string[] {
  if (!lastRun || lastRun.passed || lastRun.input !== head) return [];
  return lastRun.failures.filter((line) => !/^\s/.test(line)).slice(0, 6).map((line) => (line.length > 140 ? `${line.slice(0, 139)}…` : line));
}

function shellQuote(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

function cardFor(repo: RepoSnapshot, worktree: WorktreeSnapshot, record: WorkRecord | undefined, work: { id: string; kind: string; base?: string } | null, now: number): Card | undefined {
  const sessions = repo.sessions.filter((session) => (work && !record?.closed ? session.worktree === worktree.path : work ? session.work === work.id : session.worktree === worktree.path))
    .sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
  const latest = sessions[0];
  const phase = latest ? phaseOf(latest, now) : null;
  const fresh = work ? worktree.fresh[work.id] === true : false;
  const lastRun = work ? worktree.lastRuns[work.id] : undefined;
  const missing = record && fresh && isOpen(record) ? pending(record) : {};
  const sessionIds = new Set(sessions.map((session) => session.session));
  const inbox = repo.inbox.filter((item) => item.status === "open" && HUMAN_TYPES.has(item.type) && (work
    ? item.work === work.id
    : !item.work && (item.from.worktree === worktree.path || (item.from.session !== undefined && sessionIds.has(item.from.session))))).length;
  const signature = record?.evidence ? approvalsPolicy(record.evidence).signature === "required" : false;
  const card: Card = {
    key: `${repo.id}:${worktree.path}:${work?.id ?? "-"}`,
    repo: repo.id,
    repoName: repo.name,
    column: "working",
    reasons: [],
    work: work ? { id: work.id, kind: work.kind, goal: record?.goal ?? null } : null,
    worktree: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    agent: latest?.agent ?? null,
    session: latest?.session ?? null,
    liveSessions: sessions.filter((session) => phaseOf(session, now) === "live").length,
    phase,
    last: latest?.last ?? null,
    updatedAt: [latest?.lastTs, record?.closed?.at, record?.blocked?.at, record?.evidence?.ranAt, lastRun?.at].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
    criteria: criteriaOf(record, fresh, lastRun, worktree.head),
    failing: failingOf(lastRun, worktree.head),
    inbox,
    approval: missing.approval && record?.evidence ? {
      reason: missing.approval,
      input: record.evidence.input.commit,
      signature,
      command: `cd ${shellQuote(worktree.path)} && ways approve${signature ? " --key=<your SSH key>" : ""}`,
    } : null,
    review: missing.review ?? null,
    blocked: record?.blocked?.reason ?? null,
    closedAt: record?.closed?.at ?? null,
  };
  const [column, reasons] = place(card, record, work, repo.problem, now);
  if (!column) return undefined;
  card.column = column;
  card.reasons = reasons;
  return card;
}

/** The column rules, in order of precedence. Undefined: not worth a card. */
function place(card: Card, record: WorkRecord | undefined, work: { id: string; kind: string; base?: string } | null, problem: string | undefined, now: number): [Column | undefined, Reason[]] {
  if (record?.closed) return ["done", [{ code: "closed" }]];
  const waiting: Reason[] = [];
  if (card.inbox > 0) waiting.push({ code: "inbox", n: card.inbox });
  if (card.blocked) waiting.push({ code: "blocked", text: card.blocked });
  if (card.approval) waiting.push({ code: card.approval.signature ? "approval-signed" : "approval", text: card.approval.reason });
  if (waiting.length > 0) return ["waiting", waiting];
  if (problem) return ["blocked", [{ code: "problem", text: problem }]];
  const last = card.updatedAt ?? "";
  if (card.phase === "stalled") return ["blocked", [{ code: "stalled", n: since(now, card.last!.ts) }]];
  if (card.failing.length > 0 && card.phase !== "live") return ["blocked", [{ code: "failing-idle" }]];
  if (card.review) return ["verifying", [{ code: "review", text: card.review }]];
  if (!work) {
    // An agent in a worktree with no ways work yet.
    if (card.phase === "live") return ["preparing", [{ code: "no-work" }]];
    if (!last || now - Date.parse(last) > IDLE_SESSION_MS) return [undefined, []];
    return ["waiting", [{ code: card.phase === "ended" ? "ended-no-work" : "turn-ended-no-work" }]];
  }
  if (card.phase === "live") {
    if (card.failing.length > 0) return ["working", [{ code: "fixing" }]];
    if (work.base && card.head === work.base && !record?.evidence) return ["preparing", [{ code: "no-commits" }]];
    return ["working", []];
  }
  return ["waiting", [{ code: card.phase === "stopped" ? "turn-ended" : card.phase === "ended" ? "session-ended" : "no-agent" }]];
}

/** Cards, columns and inbox for every repository. */
export function deriveBoard(repos: readonly RepoSnapshot[], now = Date.now()): BoardState {
  const cards: Card[] = [];
  const inbox: InboxEntry[] = [];
  for (const repo of repos) {
    const done = new Map<string, { worktree: WorktreeSnapshot; record: WorkRecord }>();
    const active = new Set<string>();
    for (const worktree of repo.worktrees) {
      const open = worktree.records.filter(isOpen);
      // This worktree's work: its pointer, else its single open record.
      const record = worktree.active ? worktree.records.find((entry) => entry.id === worktree.active!.id && isOpen(entry)) : open.length === 1 ? open[0] : undefined;
      const work = worktree.active && (record || worktree.active.kind === "change") ? worktree.active : record ? { id: record.id, kind: record.kind } : null;
      if (work) active.add(work.id);
      const card = cardFor(repo, worktree, record, work, now);
      if (card) cards.push(card);
      for (const entry of worktree.records) {
        if (!entry.closed || now - Date.parse(entry.closed.at) > DONE_MS) continue;
        const seen = done.get(entry.id);
        if (!seen || (seen.record.closed!.at < entry.closed.at)) done.set(entry.id, { worktree, record: entry });
      }
      if (card?.approval && work) {
        inbox.push({
          v: 1, id: `a-${repo.id}-${work.id}`, type: "approval", status: "open",
          title: `Approve ${work.id}`, body: card.approval.reason, options: card.approval.signature ? [] : ["approve"],
          priority: "high", work: work.id, from: { worktree: worktree.path, branch: worktree.branch, work: work.id, ...(card.agent ? { agent: card.agent } : {}), ...(card.session ? { session: card.session } : {}) },
          to: { worktree: worktree.path, work: work.id }, createdAt: record?.evidence?.ranAt ?? new Date(now).toISOString(), updatedAt: record?.evidence?.ranAt ?? new Date(now).toISOString(), history: [],
          repo: repo.id, repoName: repo.name,
          binding: { work: work.id, input: card.approval.input, worktree: worktree.path, signature: card.approval.signature, command: card.approval.command },
        });
      }
    }
    for (const { worktree, record } of done.values()) {
      if (active.has(record.id)) continue;
      const card = cardFor(repo, worktree, record, { id: record.id, kind: record.kind }, now);
      if (card) cards.push(card);
    }
    for (const item of repo.inbox) inbox.push({ ...item, repo: repo.id, repoName: repo.name });
  }
  const order = new Map(COLUMNS.map((column, index) => [column, index]));
  cards.sort((a, b) => order.get(a.column)! - order.get(b.column)! || ((b.updatedAt ?? "") < (a.updatedAt ?? "") ? -1 : (b.updatedAt ?? "") > (a.updatedAt ?? "") ? 1 : 0));
  const priority = { high: 0, normal: 1, low: 2 } as const;
  inbox.sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || priority[a.priority] - priority[b.priority] || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1));
  const live = repos.reduce((total, repo) => total + repo.sessions.filter((session) => phaseOf(session, now) === "live").length, 0);
  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    repos: repos.map((repo) => ({ id: repo.id, name: repo.name, top: repo.top, worktrees: repo.worktrees.length, ...(repo.problem ? { problem: repo.problem } : {}) })),
    cards,
    inbox,
    live,
  };
}
