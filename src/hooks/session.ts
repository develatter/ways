import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../events/bus.js";
import { fastHash } from "../runtime/lazy.js";
import { writeFileAtomic, type GitDirs } from "../runtime/runtime.js";

/**
 * What ways already told one agent session, so hooks stay quiet when nothing
 * changed: a digest per brief section, the memory concepts injected, and the
 * stop reminders given. Runtime only, in `<git-common-dir>/ways/sessions/`.
 * Concurrent hooks of one session are rare (parallel tool calls only log
 * events); the last writer wins, which at worst repeats a note once.
 */
export interface SessionState {
  v: 1;
  session: string;
  agent: string;
  worktree: string;
  /** Section id → digest of the text last injected. */
  sections: Record<string, string>;
  /** Concept paths whose fact was injected. */
  memory: string[];
  /** Blocker keys already reminded at Stop. */
  reminded: string[];
  /** `ways run` was suggested in this session (once at most). */
  runHint?: boolean;
  /** Reviewer subagents this session started, by agent id: the commit and the prompt ways gave each. */
  reviews?: Record<string, { commit: string; promptSha256: string; at: string }>;
  updatedAt: string;
}

export function sessionPath(dirs: Pick<GitDirs, "common">, session: string): string {
  return join(dirs.common, "ways", "sessions", `${sessionKey(session)}.json`);
}

export function emptySession(session: string, agent: string, worktree: string): SessionState {
  return { v: 1, session, agent, worktree, sections: {}, memory: [], reminded: [], updatedAt: new Date().toISOString() };
}

export function readSession(dirs: Pick<GitDirs, "common">, session: string, agent: string, worktree: string): SessionState {
  try {
    const value = JSON.parse(readFileSync(sessionPath(dirs, session), "utf8")) as Partial<SessionState>;
    if (value.v === 1 && value.sections && typeof value.sections === "object" && Array.isArray(value.memory) && Array.isArray(value.reminded)) {
      return { ...emptySession(session, agent, worktree), ...value, agent, worktree } as SessionState;
    }
  } catch {
    // A new session.
  }
  return emptySession(session, agent, worktree);
}

export function writeSession(dirs: Pick<GitDirs, "common">, state: SessionState): void {
  writeFileAtomic(sessionPath(dirs, state.session), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() })}\n`);
}

export function digest(text: string): string {
  return fastHash(text).slice(0, 16);
}
