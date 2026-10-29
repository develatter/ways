import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GitDirs } from "../runtime/runtime.js";

/**
 * The local event bus: what coding-agent hooks saw, one JSON line per event,
 * in `<git-common-dir>/ways/events/<session>.jsonl`. It is shared by every
 * worktree and never part of Git history. It records metadata only (which
 * tool, which repository paths, how long, what ways answered), never prompts,
 * file contents or command output.
 *
 * Writes are one `appendFileSync` (O_APPEND, a single write) of a line capped
 * at MAX_LINE_BYTES, so concurrent hooks never interleave lines. A session
 * file past MAX_FILE_BYTES is rotated to `<session>.1.jsonl` (the previous
 * rotation is dropped); `pruneEvents` keeps the directory under MAX_FILES and
 * MAX_TOTAL_BYTES. Readers skip lines they cannot parse.
 *
 * Only Node built-ins: this runs on every hook.
 */
export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_TYPES = [
  "session.started",
  "prompt.submitted",
  "tool.started",
  "tool.denied",
  "tool.finished",
  "agent.stopped",
  "session.ended",
  "hook.error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** What ways answered: context injected, nothing to say, a refusal, a stop reminder, or an internal error. */
export type EventResult = "ok" | "injected" | "silent" | "denied" | "reminded" | "error";

export interface WaysEvent {
  v: typeof EVENT_SCHEMA_VERSION;
  /** ISO 8601 UTC timestamp. */
  ts: string;
  session: string;
  /** claude, pi, codex, cursor. */
  agent: string;
  type: EventType;
  /** The provider hook that produced it, e.g. PreToolUse. */
  hook: string;
  /** Absolute path of the worktree. */
  worktree: string;
  branch: string | null;
  /** The active ways work, if any. */
  work: string | null;
  tool?: string;
  /** Repository-relative paths the tool call names, normalized and confined to the worktree. */
  paths?: string[];
  result: EventResult;
  /** Short machine-oriented note (a denial code, an error message); never content. */
  detail?: string;
  /** Characters of context injected, when result is injected or reminded. */
  chars?: number;
  /** Time spent in the hook, in milliseconds. */
  ms: number;
}

export const MAX_LINE_BYTES = 4096;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 400;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export function eventsDir(dirs: Pick<GitDirs, "common">): string {
  return join(dirs.common, "ways", "events");
}

/** A file-name-safe session key: the id itself when it is plain, else a digest of it. */
export function sessionKey(session: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(session)) return session;
  return `s-${createHash("sha256").update(session).digest("hex").slice(0, 32)}`;
}

export function eventFile(dirs: Pick<GitDirs, "common">, session: string): string {
  return join(eventsDir(dirs), `${sessionKey(session)}.jsonl`);
}

/** Serializes an event into one line within MAX_LINE_BYTES, dropping paths and shortening the detail if needed. */
export function eventLine(event: WaysEvent): string {
  let candidate: WaysEvent = { ...event, ...(event.detail ? { detail: clip(event.detail, 300) } : {}) };
  let line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const paths = [...(candidate.paths ?? [])];
  while (paths.length > 0 && Buffer.byteLength(line) > MAX_LINE_BYTES) {
    paths.pop();
    candidate = { ...candidate, paths, detail: clip(`${candidate.detail ?? ""} (paths truncated)`.trim(), 300) };
    line = `${JSON.stringify(candidate)}\n`;
  }
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    const { paths: _paths, detail: _detail, ...rest } = candidate;
    line = `${JSON.stringify({ ...rest, detail: "truncated" })}\n`;
  }
  return line;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Appends one event; rotates the session file when it is full. Throws on I/O errors (callers fail open). */
export function appendEvent(dirs: Pick<GitDirs, "common">, event: WaysEvent): void {
  const path = eventFile(dirs, event.session);
  const line = eventLine(event);
  mkdirSync(eventsDir(dirs), { recursive: true });
  try {
    if (statSync(path).size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
      try {
        renameSync(path, path.replace(/\.jsonl$/, ".1.jsonl"));
      } catch {
        // Another hook rotated it first.
      }
    }
  } catch {
    // First event of the session.
  }
  appendFileSync(path, line, { encoding: "utf8", flag: "a" });
}

/** Parses JSONL text, skipping lines that are not version-1 events (a torn or foreign line). */
export function parseEvents(text: string): WaysEvent[] {
  const events: WaysEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<WaysEvent>;
      if (value.v === EVENT_SCHEMA_VERSION && typeof value.type === "string" && typeof value.session === "string" && typeof value.ts === "string") events.push(value as WaysEvent);
    } catch {
      // Skip it.
    }
  }
  return events;
}

/** The events of one session, oldest first (the rotated file, then the current one). */
export function readSessionEvents(dirs: Pick<GitDirs, "common">, session: string): WaysEvent[] {
  const path = eventFile(dirs, session);
  const events: WaysEvent[] = [];
  for (const file of [path.replace(/\.jsonl$/, ".1.jsonl"), path]) {
    try {
      events.push(...parseEvents(readFileSync(file, "utf8")));
    } catch {
      // Missing file.
    }
  }
  return events;
}

/** Every event in the bus, oldest first, for the board and the review provenance. */
export function readAllEvents(dirs: Pick<GitDirs, "common">): WaysEvent[] {
  const events: WaysEvent[] = [];
  let names: string[];
  try {
    names = readdirSync(eventsDir(dirs)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return events;
  }
  for (const name of names) {
    try {
      events.push(...parseEvents(readFileSync(join(eventsDir(dirs), name), "utf8")));
    } catch {
      // Removed meanwhile.
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Deletes the oldest session files until the directory is under MAX_FILES and MAX_TOTAL_BYTES. */
export function pruneEvents(dirs: Pick<GitDirs, "common">, limits: { files?: number; bytes?: number } = {}): number {
  const maxFiles = limits.files ?? MAX_FILES;
  const maxBytes = limits.bytes ?? MAX_TOTAL_BYTES;
  let entries: Array<{ path: string; size: number; mtime: number }>;
  try {
    entries = readdirSync(eventsDir(dirs)).filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
      const path = join(eventsDir(dirs), name);
      try {
        const stats = statSync(path);
        return [{ path, size: stats.size, mtime: stats.mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return 0;
  }
  entries.sort((a, b) => a.mtime - b.mtime);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  let removed = 0;
  while (entries.length > 0 && (entries.length > maxFiles || total > maxBytes)) {
    const oldest = entries.shift()!;
    rmSync(oldest.path, { force: true });
    total -= oldest.size;
    removed += 1;
  }
  return removed;
}
