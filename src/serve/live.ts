import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isWorkId, WORK_DIR } from "../domain/constants.js";
import type { WorkRecord } from "../domain/types.js";
import { eventsDir, parseEvents } from "../events/bus.js";
import { answerItem, closeItem, createItem, inboxDir, listItems } from "../inbox/inbox.js";
import { fastHash } from "../runtime/lazy.js";
import { currentBranchOf, gitDirs, headCommitOf, readLastRun, type GitDirs, type LastRun } from "../runtime/runtime.js";
import { deriveBoard, DONE_MS, foldEvent, type BoardState, type RepoSnapshot, type SessionSummary, type WorktreeSnapshot } from "./board.js";

const exec = promisify(execFile);

/** What the server needs from where the board comes from: the live repositories, or the demo. */
export interface BoardSource {
  state(): Promise<BoardState>;
  answer(id: string, input: { text?: string; choice?: string }): Promise<void>;
  close(id: string, reason?: string): Promise<void>;
  tell(input: { repo: string; text: string; worktree?: string; session?: string; work?: string }): Promise<void>;
  /** Directories whose changes should refresh the board at once (the rest is polled). */
  watched(): string[];
}

/** Session files older than this are not read at all. */
const SESSION_HORIZON_MS = 7 * 24 * 3600 * 1000;
/** On first sight of a session file, only its tail is read: the board needs the latest state, not the history. */
const FIRST_READ_BYTES = 128 * 1024;

/**
 * Follows the event bus incrementally: each refresh reads only what was
 * appended since the last one, so a busy bus costs the board almost nothing.
 */
export class SessionTracker {
  private readonly offsets = new Map<string, number>();
  private readonly sessions = new Map<string, SessionSummary>();

  constructor(private readonly dir: string) {}

  update(now = Date.now()): SessionSummary[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      // No events yet.
    }
    const present = new Set(names);
    for (const name of [...this.offsets.keys()]) if (!present.has(name)) this.offsets.delete(name);
    for (const name of names) {
      const path = join(this.dir, name);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(path, "r");
        const stats = fstatSync(descriptor);
        const known = this.offsets.get(name);
        if (known === undefined && now - stats.mtimeMs > SESSION_HORIZON_MS) continue;
        // A file that shrank was replaced: read it again from its tail.
        const start = known !== undefined && known <= stats.size ? known : Math.max(0, stats.size - FIRST_READ_BYTES);
        if (start === stats.size) continue;
        const buffer = Buffer.alloc(stats.size - start);
        readSync(descriptor, buffer, 0, buffer.length, start);
        let text = buffer.toString("utf8");
        // A tail that starts mid-line drops that partial line; a line still being written waits for the next refresh.
        if (known === undefined && start > 0) text = text.slice(text.indexOf("\n") + 1);
        const end = text.lastIndexOf("\n") + 1;
        this.offsets.set(name, stats.size - (Buffer.byteLength(text) - Buffer.byteLength(text.slice(0, end))));
        for (const event of parseEvents(text.slice(0, end))) this.sessions.set(event.session, foldEvent(this.sessions.get(event.session), event));
      } catch {
        // Removed or unreadable meanwhile.
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    for (const [id, session] of this.sessions) if (now - Date.parse(session.lastTs) > SESSION_HORIZON_MS) this.sessions.delete(id);
    return [...this.sessions.values()];
  }
}

function stamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "-";
  }
}

/** A worktree's own active pointer: unlike `readActive`, never the main worktree's. */
function ownActive(dirs: GitDirs): WorktreeSnapshot["active"] {
  try {
    const value = JSON.parse(readFileSync(join(dirs.gitDir, "ways", "active.json"), "utf8")) as { id?: unknown; kind?: unknown; base?: unknown };
    if (typeof value.id === "string" && isWorkId(value.id) && typeof value.kind === "string" && typeof value.base === "string") return { id: value.id, kind: value.kind, base: value.base };
  } catch {
    // None.
  }
  return null;
}

/** One repository on the board: its worktrees, records, runs, sessions and inbox. Git runs only when the worktrees or a HEAD changed. */
export class RepoWatcher {
  readonly id: string;
  readonly name: string;
  readonly dirs: GitDirs;
  private readonly tracker: SessionTracker;
  private worktreeKey = "";
  private worktreeList: Array<{ path: string }> = [];
  private readonly records = new Map<string, { stamp: string; record: WorkRecord | undefined }>();
  private readonly freshness = new Map<string, boolean>();

  constructor(top: string) {
    this.dirs = gitDirs(top);
    this.id = fastHash(this.dirs.common).slice(0, 8);
    // Named after the main worktree, whichever worktree registered it.
    this.name = basename(basename(this.dirs.common) === ".git" ? dirname(this.dirs.common) : this.dirs.top);
    this.tracker = new SessionTracker(eventsDir(this.dirs));
  }

  private async worktrees(): Promise<Array<{ path: string }>> {
    const key = stamp(join(this.dirs.common, "worktrees"));
    if (key === this.worktreeKey) return this.worktreeList;
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: this.dirs.top, encoding: "utf8" });
    const list: Array<{ path: string }> = [];
    let current: { path: string; bare?: boolean } | undefined;
    for (const line of `${stdout}\n`.split("\n")) {
      if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
      else if (line === "bare" && current) current.bare = true;
      else if (line === "" && current) {
        if (!current.bare) list.push({ path: current.path });
        current = undefined;
      }
    }
    this.worktreeKey = key;
    this.worktreeList = list;
    return list;
  }

  private recordsIn(path: string, now: number): WorkRecord[] {
    let names: string[];
    try {
      names = readdirSync(join(path, WORK_DIR)).filter((name) => name.endsWith(".json") && isWorkId(name.slice(0, -5)));
    } catch {
      return [];
    }
    const records: WorkRecord[] = [];
    for (const name of names) {
      const file = join(path, WORK_DIR, name);
      const key = stamp(file);
      let cached = this.records.get(file);
      if (!cached || cached.stamp !== key) {
        let record: WorkRecord | undefined;
        try {
          const value = JSON.parse(readFileSync(file, "utf8")) as WorkRecord;
          if (typeof value.id === "string" && Array.isArray(value.criteria) && value.policy) record = value;
        } catch {
          // Not a record.
        }
        cached = { stamp: key, record };
        this.records.set(file, cached);
      }
      const record = cached.record;
      if (record && !record.cancelled && (!record.closed || now - Date.parse(record.closed.at) <= DONE_MS)) records.push(record);
    }
    return records;
  }

  /** Same rule as `ways done`: the evidence certifies HEAD when no commit since its input changed anything but the record. */
  private async fresh(path: string, record: WorkRecord, head: string | null): Promise<boolean> {
    const input = record.evidence?.input.commit;
    if (!input || !head) return false;
    if (input === head) return true;
    const key = `${path}\0${input}\0${head}`;
    const known = this.freshness.get(key);
    if (known !== undefined) return known;
    let value = false;
    try {
      const { stdout } = await exec("git", ["diff", "--name-only", "--no-renames", input, head, "--"], { cwd: path, encoding: "utf8" });
      value = stdout.split("\n").filter(Boolean).every((file) => file === `${WORK_DIR}/${record.id}.json`);
    } catch {
      value = false;
    }
    if (this.freshness.size > 500) this.freshness.clear();
    this.freshness.set(key, value);
    return value;
  }

  async snapshot(now = Date.now()): Promise<RepoSnapshot> {
    const snapshot: RepoSnapshot = { id: this.id, name: this.name, top: this.dirs.top, worktrees: [], sessions: this.tracker.update(now), inbox: listItems(this.dirs, { all: true, now }) };
    let list: Array<{ path: string }>;
    try {
      list = await this.worktrees();
    } catch (error) {
      snapshot.problem = `git worktree list failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      list = [{ path: this.dirs.top }];
    }
    for (const { path } of list) {
      let dirs: GitDirs;
      try {
        dirs = gitDirs(path);
      } catch {
        continue;
      }
      const head = headCommitOf(dirs) ?? null;
      const records = this.recordsIn(path, now);
      const fresh: Record<string, boolean> = {};
      const lastRuns: Record<string, LastRun> = {};
      const active = ownActive(dirs);
      for (const id of new Set([...records.map((record) => record.id), ...(active ? [active.id] : [])])) {
        const record = records.find((entry) => entry.id === id);
        if (record && !record.closed) fresh[id] = await this.fresh(path, record, head);
        const run = readLastRun(path, id);
        if (run) lastRuns[id] = run;
      }
      snapshot.worktrees.push({ path, branch: currentBranchOf(dirs) ?? null, head, active, records, fresh, lastRuns });
    }
    return snapshot;
  }
}

/** The board of the registered repositories. */
export class LiveSource implements BoardSource {
  private readonly repos: RepoWatcher[];

  constructor(tops: readonly string[]) {
    const seen = new Set<string>();
    this.repos = [];
    for (const top of tops) {
      let watcher: RepoWatcher;
      try {
        watcher = new RepoWatcher(top);
      } catch {
        continue;
      }
      if (seen.has(watcher.dirs.common)) continue;
      seen.add(watcher.dirs.common);
      this.repos.push(watcher);
    }
  }

  get count(): number {
    return this.repos.length;
  }

  async state(): Promise<BoardState> {
    const now = Date.now();
    return deriveBoard(await Promise.all(this.repos.map((repo) => repo.snapshot(now))), now);
  }

  private repoOf(id: string): RepoWatcher {
    const repo = this.repos.find((entry) => listItems(entry.dirs, { all: true }).some((item) => item.id === id));
    if (!repo) throw new NotFound(`No inbox item ${id}`);
    return repo;
  }

  async answer(id: string, input: { text?: string; choice?: string }): Promise<void> {
    if (id.startsWith("a-")) return this.approve(id, input);
    answerItem(this.repoOf(id).dirs, id, input, "human", "ui");
  }

  /** A work's approval, derived from its record: recorded by ways as an approval via the board, when the policy allows it. */
  private async approve(id: string, input: { choice?: string }): Promise<void> {
    if (input.choice !== "approve") throw new Error("A work's approval is answered with \"approve\"; to refuse, tell the agent what to change instead");
    const entry = (await this.state()).inbox.find((item) => item.id === id);
    if (!entry?.binding) throw new NotFound(`Nothing to approve for ${id} any more`);
    if (entry.binding.signature) throw new Error(`This repository requires SSH-signed approvals. In a terminal: ${entry.binding.command}`);
    const { approveFromBoard } = await import("../work/work.js");
    await approveFromBoard(entry.binding.worktree, { id: entry.binding.work, input: entry.binding.input });
  }

  async close(id: string, reason?: string): Promise<void> {
    if (id.startsWith("a-")) throw new Error("A work's approval cannot be dismissed here: approve it, or tell the agent what to change");
    closeItem(this.repoOf(id).dirs, id, "human", reason);
  }

  async tell(input: { repo: string; text: string; worktree?: string; session?: string; work?: string }): Promise<void> {
    const repo = this.repos.find((entry) => entry.id === input.repo);
    if (!repo) throw new NotFound(`No repository ${input.repo} on this board`);
    let worktree: string | undefined;
    if (input.worktree) {
      // Only a worktree of that repository: the path comes from the page.
      const known = (await repo.snapshot()).worktrees.map((entry) => entry.path);
      if (!known.includes(input.worktree)) throw new Error(`${input.worktree} is not a worktree of ${repo.name}`);
      worktree = input.worktree;
    }
    if (!worktree && !input.session && !input.work) worktree = repo.dirs.top;
    createItem(repo.dirs, {
      type: "instruction",
      title: input.text,
      work: input.work ?? null,
      from: { by: "human" },
      to: { ...(input.session ? { session: input.session } : {}), ...(worktree ? { worktree } : {}), ...(input.work ? { work: input.work } : {}) },
    });
  }

  watched(): string[] {
    return this.repos.flatMap((repo) => [eventsDir(repo.dirs), inboxDir(repo.dirs)]);
  }
}

export class NotFound extends Error {}
