import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { crypto } from "../runtime/lazy.js";
import { writeFileAtomic, type GitDirs } from "../runtime/runtime.js";

/**
 * The inbox: what agents expect from the human (questions, decisions,
 * approvals, blocks) and what the human tells an agent (instructions). One
 * JSON file per item in `<git-common-dir>/ways/inbox/`, shared by every
 * worktree, never in Git history: it is operational conversation. What must
 * last goes through its own channel (a work record's approval, a memory).
 *
 * Lifecycle: `open → answered → delivered → closed`, or `expired` when an
 * open item passes its `expiresAt` (with a default, it is answered with it
 * instead: nobody waits forever). An instruction needs no answer: it is
 * delivered while open. Delivery happens once, claimed by an exclusive
 * create of `.claims/<id>`, so two hooks never both inject the same answer.
 *
 * An answer here is advice to the agent, not a ways approval: a work's
 * approval is recorded only by `ways approve` (or by the board, where the
 * repository does not require signed approvals).
 *
 * Only Node built-ins and runtime helpers: the agent hooks load it.
 */
export const INBOX_TYPES = ["ask", "decision", "approval", "block", "instruction"] as const;
export type InboxType = (typeof INBOX_TYPES)[number];
export const INBOX_STATUSES = ["open", "answered", "delivered", "closed", "expired"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const PRIORITIES = ["low", "normal", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Who wrote an item, or who it is for. Every field is optional: a worktree or a work is enough to route it. */
export interface Party {
  agent?: string;
  session?: string;
  /** Absolute path of the worktree. */
  worktree?: string;
  branch?: string | null;
  work?: string | null;
}

export interface InboxAnswer {
  text: string;
  /** One of the item's options, when it has them. */
  choice?: string;
  by: string;
  via: "ui" | "cli" | "expiry";
  at: string;
}

export interface InboxItem {
  v: 1;
  id: string;
  type: InboxType;
  status: InboxStatus;
  /** One line. */
  title: string;
  body?: string;
  options?: string[];
  /** The option that applies when the item expires unanswered. */
  default?: string;
  priority: Priority;
  /** The ways work it is about, if any. */
  work: string | null;
  /** The author: the asking agent, or the human for an instruction. */
  from: Party & { by?: string };
  /** Who receives the answer (the asker) or the instruction. */
  to: Party;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  answer?: InboxAnswer;
  delivered?: { at: string; session: string; agent: string; via: string };
  closed?: { at: string; by: string; reason?: string };
  /** Every transition, oldest first. */
  history: Array<{ at: string; status: InboxStatus; by: string; note?: string }>;
}

export const MAX_TITLE = 300;
export const MAX_BODY = 4000;
export const MAX_ANSWER = 4000;
const MAX_OPTIONS = 8;
/** Closed, expired and delivered items older than this are pruned. */
const KEEP_MS = 30 * 24 * 3600 * 1000;
const ID = /^i-[a-z0-9]{6,12}-[0-9a-f]{8}$/;

export function inboxDir(dirs: Pick<GitDirs, "common">): string {
  return join(dirs.common, "ways", "inbox");
}

export function isInboxId(id: string): boolean {
  return ID.test(id);
}

function itemPath(dirs: Pick<GitDirs, "common">, id: string): string {
  if (!isInboxId(id)) throw new Error(`Not an inbox item id: "${id}". \`ways inbox\` lists them.`);
  return join(inboxDir(dirs), `${id}.json`);
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function bounded(text: string, max: number): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function asItem(value: unknown): InboxItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<InboxItem>;
  if (item.v !== 1 || typeof item.id !== "string" || !isInboxId(item.id) || !(INBOX_TYPES as readonly string[]).includes(item.type ?? "")
    || !(INBOX_STATUSES as readonly string[]).includes(item.status ?? "") || typeof item.title !== "string" || typeof item.createdAt !== "string"
    || !item.from || typeof item.from !== "object" || !item.to || typeof item.to !== "object" || !Array.isArray(item.history)) return undefined;
  return value as InboxItem;
}

export function readItem(dirs: Pick<GitDirs, "common">, id: string): InboxItem | undefined {
  try {
    return asItem(JSON.parse(readFileSync(itemPath(dirs, id), "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not an inbox item id")) throw error;
    return undefined;
  }
}

export function getItem(dirs: Pick<GitDirs, "common">, id: string): InboxItem {
  const item = readItem(dirs, id);
  if (!item) throw new Error(`No inbox item ${id}. \`ways inbox --all\` lists every item.`);
  return expire(dirs, item);
}

function save(dirs: Pick<GitDirs, "common">, item: InboxItem): InboxItem {
  writeFileAtomic(itemPath(dirs, item.id), `${JSON.stringify(item, null, 2)}\n`);
  return item;
}

function transition(item: InboxItem, status: InboxStatus, by: string, note?: string, at = new Date().toISOString()): InboxItem {
  return { ...item, status, updatedAt: at, history: [...item.history, { at, status, by, ...(note ? { note: oneLine(note, 200) } : {}) }] };
}

/** Applies expiry to an open item (answered with its default, or expired) and persists it. */
export function expire(dirs: Pick<GitDirs, "common">, item: InboxItem, now = Date.now()): InboxItem {
  if (item.status !== "open" || !item.expiresAt || Date.parse(item.expiresAt) > now) return item;
  const at = new Date(now).toISOString();
  const next = item.default !== undefined
    ? { ...transition(item, "answered", "expiry", `no answer in time; the default applies: ${item.default}`, at), answer: { text: "", choice: item.default, by: "expiry", via: "expiry" as const, at } }
    : transition(item, "expired", "expiry", "no answer in time", at);
  try {
    return save(dirs, next);
  } catch {
    return next;
  }
}

/** Every item, expiry applied, newest first. Old finished items are pruned. */
export function listItems(dirs: Pick<GitDirs, "common">, options: { all?: boolean; now?: number } = {}): InboxItem[] {
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = readdirSync(inboxDir(dirs)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const items: InboxItem[] = [];
  for (const name of names) {
    let item: InboxItem | undefined;
    try {
      item = asItem(JSON.parse(readFileSync(join(inboxDir(dirs), name), "utf8")));
    } catch {
      continue;
    }
    if (!item) continue;
    item = expire(dirs, item, now);
    const finished = item.status === "closed" || item.status === "expired" || item.status === "delivered";
    if (finished && now - Date.parse(item.updatedAt) > KEEP_MS) {
      rmSync(join(inboxDir(dirs), name), { force: true });
      rmSync(join(inboxDir(dirs), ".claims", item.id), { force: true });
      continue;
    }
    if (!options.all && (item.status === "closed" || item.status === "delivered" || (item.status === "expired" && item.delivered))) continue;
    items.push(item);
  }
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

function newId(): string {
  return `i-${Date.now().toString(36)}-${crypto().randomBytes(4).toString("hex")}`;
}

export interface NewItem {
  type: InboxType;
  title: string;
  body?: string;
  options?: readonly string[];
  default?: string;
  priority?: Priority;
  work?: string | null;
  from: Party & { by?: string };
  to: Party;
  /** Milliseconds until it expires. */
  expiresIn?: number;
}

/** Validates and writes a new item. */
export function createItem(dirs: Pick<GitDirs, "common">, input: NewItem): InboxItem {
  const title = oneLine(input.title, MAX_TITLE);
  if (!title) throw new Error("An inbox item needs a one-line title (the question, or the instruction)");
  const options = [...new Set((input.options ?? []).map((option) => oneLine(option, 80)).filter(Boolean))];
  if (options.length > MAX_OPTIONS) throw new Error(`At most ${MAX_OPTIONS} options`);
  if (input.type === "decision" && options.length < 2) throw new Error("A decision needs at least two --options=a,b");
  if (input.type === "approval" && options.length === 0) options.push("approve", "reject");
  if (input.type === "instruction" && options.length > 0) throw new Error("An instruction has no options");
  if (input.default !== undefined && !options.includes(input.default)) throw new Error(`--default must be one of the options (${options.join(", ") || "none given"})`);
  if (!input.to.session && !input.to.worktree && !input.to.work) throw new Error("An inbox item needs a recipient: a session, a worktree or a work");
  const at = new Date().toISOString();
  const item: InboxItem = {
    v: 1,
    id: newId(),
    type: input.type,
    status: "open",
    title,
    ...(input.body?.trim() ? { body: bounded(input.body, MAX_BODY) } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(input.default !== undefined ? { default: input.default } : {}),
    priority: input.priority ?? "normal",
    work: input.work ?? null,
    from: input.from,
    to: input.to,
    createdAt: at,
    updatedAt: at,
    ...(input.expiresIn !== undefined ? { expiresAt: new Date(Date.now() + input.expiresIn).toISOString() } : {}),
    history: [{ at, status: "open", by: input.from.by ?? input.from.agent ?? "unknown" }],
  };
  return save(dirs, item);
}

/** The human's (or the orchestrator's) answer. It can be changed until the agent has received it. */
export function answerItem(dirs: Pick<GitDirs, "common">, id: string, input: { text?: string; choice?: string }, by: string, via: "ui" | "cli"): InboxItem {
  const item = getItem(dirs, id);
  if (item.type === "instruction") throw new Error(`${id} is an instruction for an agent; there is nothing to answer. \`ways inbox close ${id}\` withdraws it.`);
  if (item.status !== "open" && item.status !== "answered") throw new Error(`${id} is ${item.status}; it can no longer be answered${item.status === "delivered" ? " (the agent already has the answer)" : ""}. Ask again with \`ways inbox tell "<text>"\`.`);
  const text = bounded(input.text ?? "", MAX_ANSWER);
  let choice = input.choice?.trim() || undefined;
  if (!choice && item.options && item.options.includes(text)) choice = text;
  if (choice && !(item.options ?? []).includes(choice)) throw new Error(`"${choice}" is not one of the options of ${id}: ${(item.options ?? []).join(", ") || "it has none; answer with text"}`);
  if (!choice && !text) throw new Error(`Give an answer: ${item.options ? `one of ${item.options.join(", ")}, or ` : ""}a text`);
  const at = new Date().toISOString();
  const answer: InboxAnswer = { text: choice === text ? "" : text, ...(choice ? { choice } : {}), by, via, at };
  return save(dirs, { ...transition(item, "answered", by, choice ?? text, at), answer });
}

/** Closes an item: withdrawn, dismissed, or resolved some other way. */
export function closeItem(dirs: Pick<GitDirs, "common">, id: string, by: string, reason?: string): InboxItem {
  const item = getItem(dirs, id);
  if (item.status === "closed") return item;
  const at = new Date().toISOString();
  return save(dirs, { ...transition(item, "closed", by, reason, at), closed: { at, by, ...(reason ? { reason: oneLine(reason, 300) } : {}) } });
}

/** Closes the open items that match, e.g. a work's block once a passing `ways done` resolved it. */
export function closeWhere(dirs: Pick<GitDirs, "common">, match: (item: InboxItem) => boolean, by: string, reason: string): number {
  let count = 0;
  for (const item of listItems(dirs)) {
    if (item.status !== "open" || !match(item)) continue;
    closeItem(dirs, item.id, by, reason);
    count += 1;
  }
  return count;
}

/** An agent session as the hooks see it. */
export interface Recipient {
  session: string;
  agent: string;
  worktree: string;
  work: string | null;
  /** SessionStart: a new session in a worktree also takes what was left for an earlier one there. */
  starting?: boolean;
}

export function addressedTo(item: InboxItem, who: Recipient): boolean {
  const to = item.to;
  if (to.session && to.session === who.session) return true;
  if (to.session && !who.starting) return false;
  if (to.worktree && to.worktree !== who.worktree) return false;
  if (to.work && to.work !== who.work) return false;
  return Boolean(to.worktree || to.work);
}

/** What reaches the agent: answers, the default of an expired decision, an unanswered expiry, and instructions. */
export function deliverable(item: InboxItem): boolean {
  if (item.delivered) return false;
  if (item.type === "instruction") return item.status === "open";
  return item.status === "answered" || item.status === "expired";
}

/** Claims an item for delivery: exactly one caller ever gets true. */
export function claim(dirs: Pick<GitDirs, "common">, id: string): boolean {
  const dir = join(inboxDir(dirs), ".claims");
  mkdirSync(dir, { recursive: true });
  try {
    closeSync(openSync(join(dir, id), "wx"));
    return true;
  } catch {
    return false;
  }
}

/** Marks a claimed item delivered. */
export function markDelivered(dirs: Pick<GitDirs, "common">, item: InboxItem, who: Pick<Recipient, "session" | "agent">, via: string): InboxItem {
  const at = new Date().toISOString();
  const next = item.status === "expired" ? { ...item, updatedAt: at } : transition(item, "delivered", `${who.agent}:${who.session}`, via, at);
  return save(dirs, { ...next, delivered: { at, session: who.session, agent: who.agent, via } });
}

export function renderForAgent(item: InboxItem): string {
  if (item.type === "instruction") return `- Instruction from the human (${item.id}): ${item.title}${item.body ? `\n  ${item.body.replace(/\n/g, "\n  ")}` : ""}`;
  const asked = `your ${item.type === "block" ? "block" : item.type === "approval" ? "approval request" : "question"} "${oneLine(item.title, 160)}" (${item.id})`;
  if (item.status === "expired") return `- Nobody answered ${asked} before it expired: decide for yourself, or ask again.`;
  const answer = item.answer!;
  if (answer.via === "expiry") return `- Nobody answered ${asked} in time; its default applies: ${answer.choice}.`;
  const parts = [answer.choice ? `"${answer.choice}"` : undefined, answer.text || undefined].filter(Boolean).join(" — ");
  return `- The human answered ${asked}: ${parts}`;
}

export const INBOX_HEADING = "From the human, through the ways inbox (said once):";

/**
 * What the hooks inject: every item for this session that is ready, claimed
 * and marked delivered. Nothing when the inbox does not exist (no file read).
 */
export function deliverTo(dirs: Pick<GitDirs, "common">, who: Recipient, via: string): string | undefined {
  if (!existsSync(inboxDir(dirs))) return undefined;
  const lines: string[] = [];
  for (const item of listItems(dirs).reverse()) {
    if (!deliverable(item) || !addressedTo(item, who) || !claim(dirs, item.id)) continue;
    lines.push(renderForAgent(item));
    markDelivered(dirs, item, who, via);
  }
  return lines.length > 0 ? [INBOX_HEADING, ...lines].join("\n") : undefined;
}

/** Polls an item until it is answered, expires or closes, or the time runs out. */
export async function waitFor(dirs: Pick<GitDirs, "common">, id: string, timeoutMs: number, intervalMs = 1000): Promise<InboxItem> {
  const deadline = Date.now() + timeoutMs;
  let lastStamp = "";
  let item = getItem(dirs, id);
  for (;;) {
    if (item.status !== "open") return item;
    const left = deadline - Date.now();
    if (left <= 0) return item;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
    let stamp = "";
    try {
      const stats = statSync(itemPath(dirs, id));
      stamp = `${stats.size}:${stats.mtimeMs}`;
    } catch {
      // Removed: read below reports it.
    }
    if (stamp !== lastStamp || (item.expiresAt && Date.parse(item.expiresAt) <= Date.now())) {
      lastStamp = stamp;
      item = getItem(dirs, id);
    }
  }
}

/** `30s`, `10m`, `2h`, `1d`; a bare number is seconds. */
export function parseDuration(value: string, flag: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`${flag} takes a duration like 30s, 10m, 2h or 1d, got "${value}"`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "s"]!;
  return Number(match[1]) * unit;
}
