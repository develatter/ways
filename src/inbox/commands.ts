import { currentBranchOf, gitDirs, readActive, type GitDirs } from "../runtime/runtime.js";
import { answerItem, claim, closeItem, createItem, getItem, INBOX_TYPES, listItems, markDelivered, MAX_TITLE, parseDuration, PRIORITIES, waitFor, type InboxItem, type InboxType, type Party, type Priority } from "./inbox.js";

/**
 * `ways ask` (an agent asks the human) and `ways inbox` (the human or an
 * orchestrating agent reads, answers, closes, or tells an agent something).
 * Every command takes `--json` and prints the item(s) as JSON, so an
 * orchestrator needs nothing but the CLI.
 */
export interface OptionHelpers {
  option(args: readonly string[], name: string): string | undefined;
  options(args: readonly string[], name: string, spaced?: boolean): string[];
}

/** Exit codes of `ways ask --wait`. */
export const WAIT_EXIT = { answered: 0, timeout: 2, unanswered: 3 } as const;
const DEFAULT_WAIT = "5m";

/** Positional words, skipping flags and the values of the given spaced flags. */
function words(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("--"));
}

/** Who is calling: the agent session the hooks exported (WAYS_SESSION, WAYS_AGENT), this worktree and its active work. */
export function caller(dirs: GitDirs, env: NodeJS.ProcessEnv = process.env, session?: string): Party {
  const party: Party = { worktree: dirs.top, branch: currentBranchOf(dirs) ?? null, work: readActive(dirs.top)?.id ?? null };
  const id = session ?? env.WAYS_SESSION;
  if (id) party.session = id;
  const agent = env.WAYS_AGENT ?? (env.CLAUDECODE === "1" ? "claude" : undefined);
  if (agent) party.agent = agent;
  return party;
}

/** A name for the trail: the agent session, else the human at a terminal, else the CLI. */
function actor(party: Party): string {
  if (party.session) return `${party.agent ?? "agent"}:${party.session}`;
  return process.stdin.isTTY ? "human" : "cli";
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function age(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function answerText(item: InboxItem): string {
  if (!item.answer) return "";
  return [item.answer.choice, item.answer.text].filter(Boolean).join(" — ");
}

function line(item: InboxItem): string {
  const where = [item.work ? `work ${item.work}` : undefined, item.from.agent ? `${item.from.agent}${item.from.session ? ` ${item.from.session.slice(0, 8)}` : ""}` : undefined].filter(Boolean).join(", ");
  const answer = item.answer ? ` → ${answerText(item)}` : "";
  return `${item.id}  ${item.status.padEnd(9)} ${item.type.padEnd(11)} ${item.priority === "high" ? "! " : ""}${item.title}${answer}${where ? `  (${where}, ${age(item.createdAt)} ago)` : `  (${age(item.createdAt)} ago)`}`;
}

function show(item: InboxItem): string {
  const lines = [`${item.id} · ${item.type} · ${item.status} · priority ${item.priority}`, `  ${item.title}`];
  if (item.body) lines.push(...item.body.split("\n").map((text) => `  ${text}`));
  if (item.options) lines.push(`  options: ${item.options.join(", ")}${item.default ? ` (default ${item.default})` : ""}`);
  if (item.work) lines.push(`  work: ${item.work}`);
  lines.push(`  from: ${[item.from.agent, item.from.session, item.from.by].filter(Boolean).join(" ") || "?"}${item.from.worktree ? ` in ${item.from.worktree}` : ""}`);
  if (item.expiresAt) lines.push(`  expires: ${item.expiresAt}`);
  if (item.answer) lines.push(`  answer: ${answerText(item) || "(empty)"} — by ${item.answer.by} via ${item.answer.via}`);
  if (item.delivered) lines.push(`  delivered to ${item.delivered.agent} ${item.delivered.session} (${item.delivered.via}) at ${item.delivered.at}`);
  if (item.closed) lines.push(`  closed by ${item.closed.by}${item.closed.reason ? `: ${item.closed.reason}` : ""}`);
  for (const step of item.history) lines.push(`  ${step.at} ${step.status} by ${step.by}${step.note ? `: ${step.note}` : ""}`);
  return `${lines.join("\n")}\n`;
}

function choiceOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${flag} must be ${allowed.join(", ")}, got "${value}"`);
  return value as T;
}

export async function runAsk(args: readonly string[], cwd: string, { option }: OptionHelpers): Promise<number> {
  const question = words(args).join(" ").trim();
  if (!question) throw new Error("Usage: ways ask \"<question>\" [--options=a,b] [--type=ask|decision|approval] [--wait[=5m]] [--work=<id>] [--json]");
  const dirs = gitDirs(cwd);
  const type = choiceOf(option(args, "--type"), INBOX_TYPES.filter((entry): entry is Exclude<InboxType, "block" | "instruction"> => entry !== "block" && entry !== "instruction"), "--type")
    ?? (option(args, "--default") !== undefined ? "decision" : "ask");
  const priority = choiceOf(option(args, "--priority"), PRIORITIES, "--priority");
  const expires = option(args, "--expires");
  const from = caller(dirs, process.env, option(args, "--session"));
  const work = option(args, "--work") ?? from.work ?? null;
  const optionList = option(args, "--options")?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const body = option(args, "--body");
  const fallback = option(args, "--default");
  const item = createItem(dirs, {
    type,
    title: question,
    ...(body ? { body } : {}),
    ...(optionList ? { options: optionList } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(priority ? { priority: priority as Priority } : {}),
    work,
    from: { ...from, by: actor(from) },
    // The answer goes back to whoever asked: the session when known, else whoever works in this worktree next.
    to: { ...(from.session ? { session: from.session } : {}), worktree: dirs.top, ...(work ? { work } : {}) },
    ...(expires ? { expiresIn: parseDuration(expires, "--expires") } : {}),
  });
  const waitArg = args.find((arg) => arg === "--wait" || arg.startsWith("--wait="));
  if (!waitArg) {
    if (args.includes("--json")) json(item);
    else console.log(`Asked the human: ${item.id}. The answer reaches this session through the ways hooks (or: \`ways inbox show ${item.id}\`). Keep working on what does not depend on it, or wait with \`ways ask ... --wait\`.`);
    return 0;
  }
  const timeout = parseDuration(waitArg === "--wait" ? DEFAULT_WAIT : waitArg.slice("--wait=".length), "--wait");
  if (!args.includes("--json")) console.error(`Asked the human: ${item.id}; waiting up to ${Math.round(timeout / 1000)} s for the answer…`);
  return finishWait(dirs, await waitFor(dirs, item.id, timeout, Number(process.env.WAYS_INBOX_POLL_MS) || 1000), from, args.includes("--json"));
}

/** Prints what the wait ended with; an answer printed here counts as delivered, so no hook repeats it. */
function finishWait(dirs: GitDirs, item: InboxItem, who: Party, asJson: boolean): number {
  let result = item;
  if ((item.status === "answered" || item.status === "expired") && claim(dirs, item.id)) {
    result = markDelivered(dirs, item, { session: who.session ?? "cli", agent: who.agent ?? "cli" }, "wait");
  }
  const code = item.status === "answered" ? WAIT_EXIT.answered : item.status === "open" ? WAIT_EXIT.timeout : WAIT_EXIT.unanswered;
  if (asJson) json(result);
  else if (item.status === "answered") console.log(item.answer?.via === "expiry" ? `No answer in time; the default applies: ${item.answer.choice}` : `Answer: ${answerText(item)}`);
  else if (item.status === "open") console.log(`No answer yet (${item.id} is still open). It will reach this session through the ways hooks; keep working on what does not depend on it.`);
  else console.log(`${item.id} was ${item.status} without an answer${item.closed?.reason ? ` (${item.closed.reason})` : ""}: decide for yourself, or ask again.`);
  return code;
}

export async function runInbox(args: readonly string[], cwd: string, { option }: OptionHelpers): Promise<number> {
  const [action = "list", ...rest] = args[0]?.startsWith("--") ? ["list", ...args] : args;
  const dirs = gitDirs(cwd);
  const asJson = rest.includes("--json");
  const positional = words(rest);
  const me = caller(dirs);
  const by = actor(me);

  if (action === "list") {
    const items = listItems(dirs, { all: rest.includes("--all") });
    if (asJson) json(items);
    else if (items.length === 0) console.log(rest.includes("--all") ? "The inbox is empty." : "Nothing open in the inbox. `ways inbox --all` shows answered, delivered and closed items too.");
    else for (const item of items) console.log(line(item));
    return 0;
  }
  if (action === "show") {
    const [id] = positional;
    if (!id) throw new Error("Usage: ways inbox show <id> [--json]");
    const item = getItem(dirs, id);
    if (asJson) json(item);
    else process.stdout.write(show(item));
    return 0;
  }
  if (action === "answer") {
    const [id, ...text] = positional;
    const choice = option(rest, "--choice");
    if (!id || (text.length === 0 && !choice)) throw new Error("Usage: ways inbox answer <id> \"<answer>\" [--choice=<option>] [--json]");
    const item = answerItem(dirs, id, { text: text.join(" "), ...(choice ? { choice } : {}) }, by, "cli");
    if (asJson) json(item);
    else console.log(`Answered ${id}; the agent gets it at its next prompt, stop or session start (once).`);
    return 0;
  }
  if (action === "close") {
    const [id] = positional;
    if (!id) throw new Error("Usage: ways inbox close <id> [--reason=<text>] [--json]");
    const reason = option(rest, "--reason");
    const item = closeItem(dirs, id, by, reason);
    if (asJson) json(item);
    else console.log(`Closed ${id}.`);
    return 0;
  }
  if (action === "tell") {
    const text = positional.join(" ").trim();
    const session = option(rest, "--session");
    const work = option(rest, "--work");
    const worktreeOption = option(rest, "--worktree");
    if (!text) throw new Error("Usage: ways inbox tell \"<instruction>\" [--session=<id>] [--work=<id>] [--worktree=<path>] [--json]");
    const worktree = worktreeOption ? gitDirs(worktreeOption.startsWith("/") ? worktreeOption : `${cwd}/${worktreeOption}`).top : (session || work ? undefined : dirs.top);
    const priority = choiceOf(option(rest, "--priority"), PRIORITIES, "--priority");
    const item = createItem(dirs, {
      type: "instruction",
      title: text,
      ...(priority ? { priority } : {}),
      work: work ?? null,
      from: { ...me, by },
      to: { ...(session ? { session } : {}), ...(worktree ? { worktree } : {}), ...(work ? { work } : {}) },
    });
    if (asJson) json(item);
    else console.log(`Instruction ${item.id} queued; the agent ${session ? `session ${session}` : worktree ? `in ${worktree}` : `on ${work}`} gets it at its next prompt, stop or session start (once).`);
    return 0;
  }
  throw new Error("Usage: ways inbox [list] [--all] [--json] | show <id> | answer <id> \"<answer>\" [--choice=<option>] | close <id> [--reason=<text>] | tell \"<instruction>\" [--session=<id>|--work=<id>|--worktree=<path>]");
}

/** For `ways block`: the block also lands in the inbox, so the human's answer reaches the agent. */
export function blockItem(dirs: GitDirs, work: string, reason: string): InboxItem | undefined {
  const from = caller(dirs);
  const text = reason.replace(/\s+/g, " ").trim();
  const open = listItems(dirs).filter((item) => item.type === "block" && item.work === work && item.status === "open");
  const same = open.find((item) => (item.body ?? item.title) === text);
  if (same) return same;
  for (const item of open) closeItem(dirs, item.id, actor(from), "superseded by a new block");
  return createItem(dirs, {
    type: "block",
    title: text,
    ...(text.length > MAX_TITLE ? { body: text } : {}),
    priority: "high",
    work,
    from: { ...from, work, by: actor(from) },
    to: { ...(from.session ? { session: from.session } : {}), worktree: dirs.top, work },
  });
}
