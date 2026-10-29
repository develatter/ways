import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_DIR } from "../domain/constants.js";
import { matchesAny } from "../memory/glob.js";
import { headCommitOf, type GitDirs } from "../runtime/runtime.js";

/**
 * The memory the context brief and the path rules use: every current concept
 * that declares `paths:`, with its fact and whether it is possibly stale.
 *
 * Parsing OKF needs `yaml` and freshness needs git, which together cost more
 * than a hook may take. So the result is cached in the runtime directory,
 * keyed by HEAD and the size and mtime of every concept file; a hook only
 * rebuilds it after a commit or a memory edit. Freshness has the semantics of
 * `ways memory check`: a concept is possibly stale when a file under its
 * paths changed between its last commit and HEAD.
 */
export interface MemoryFact {
  /** Repository-relative path of the concept, e.g. `.ways/knowledge/conventions/x.md`. */
  path: string;
  title: string;
  type: string;
  paths: string[];
  /** The concept body: a few non-empty lines. */
  fact: string;
  stale: boolean;
}

interface Snapshot {
  v: 1;
  key: string;
  concepts: MemoryFact[];
}

/** Lines and characters of a fact the brief and the rules carry; the concept file has the rest. */
export const FACT_LINES = 15;
export const FACT_CHARS = 900;

function conceptFiles(top: string): Array<{ path: string; size: number; mtime: number }> {
  const root = join(top, KNOWLEDGE_DIR);
  const found: Array<{ path: string; size: number; mtime: number }> = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md" && entry.name !== "log.md") {
        try {
          const stats = statSync(join(dir, entry.name));
          found.push({ path: relative, size: stats.size, mtime: stats.mtimeMs });
        } catch {
          // Removed meanwhile.
        }
      }
    }
  };
  walk(root, "");
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Changes whenever HEAD moves or a concept file is added, removed or edited. */
export function memoryKey(dirs: GitDirs): string {
  const hash = createHash("sha256").update(`${headCommitOf(dirs) ?? "unborn"}\n`);
  for (const file of conceptFiles(dirs.top)) hash.update(`${file.path}\0${file.size}\0${file.mtime}\n`);
  return hash.digest("hex");
}

function cachePath(dirs: GitDirs): string {
  const worktree = createHash("sha256").update(dirs.top).digest("hex").slice(0, 16);
  return join(dirs.common, "ways", "context", `memory-${worktree}.json`);
}

function git(top: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd: top, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** The last commit of every committed concept, from one `git log`. */
async function lastCommits(top: string): Promise<Map<string, string>> {
  const last = new Map<string, string>();
  let output: string;
  try {
    output = await git(top, ["log", "--format=commit %H", "--name-only", "--no-renames", "--", KNOWLEDGE_DIR]);
  } catch {
    return last;
  }
  let current = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("commit ")) current = line.slice("commit ".length).trim();
    else if (line && current && !last.has(line)) last.set(line, current);
  }
  return last;
}

export function factOf(body: string): string {
  const lines = body.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0).slice(0, FACT_LINES);
  const text = lines.join("\n");
  return text.length > FACT_CHARS ? `${text.slice(0, FACT_CHARS - 1)}…` : text;
}

async function rebuild(dirs: GitDirs): Promise<MemoryFact[]> {
  const { inspectOkf, conceptPaths, isCurrentConcept } = await import("../knowledge/okf.js");
  const { documents } = await inspectOkf(dirs.top, { validateSources: false });
  const current = documents.filter((document) => isCurrentConcept(document) && conceptPaths(document).length > 0);
  const head = headCommitOf(dirs);
  const last = head ? await lastCommits(dirs.top) : new Map<string, string>();
  const changedSince = new Map<string, Promise<string[]>>();
  const changed = (commit: string): Promise<string[]> => {
    let found = changedSince.get(commit);
    if (!found) {
      found = git(dirs.top, ["diff", "--name-only", "--no-renames", commit, "HEAD", "--"])
        .then((output) => output.split("\n").filter((path) => path && !path.startsWith(`${KNOWLEDGE_DIR}/`)))
        .catch(() => []);
      changedSince.set(commit, found);
    }
    return found;
  };
  const facts: MemoryFact[] = [];
  for (const document of current) {
    const path = `${KNOWLEDGE_DIR}/${document.path}`;
    const globs = conceptPaths(document);
    const commit = last.get(path);
    let stale = false;
    if (commit && commit !== head) {
      try {
        stale = (await changed(commit)).some((file) => matchesAny(file, globs));
      } catch {
        stale = false;
      }
    }
    const title = typeof document.frontmatter.title === "string" ? document.frontmatter.title : document.id.split("/").at(-1) ?? document.id;
    facts.push({ path, title, type: typeof document.frontmatter.type === "string" ? document.frontmatter.type : "concept", paths: globs, fact: factOf(document.body), stale });
  }
  return facts;
}

/**
 * Concepts with paths, from the cache when HEAD and the concept files are
 * unchanged, else rebuilt and cached. Never throws: broken memory is reported
 * by `ways memory check`, not by a hook.
 */
export async function loadMemory(dirs: GitDirs): Promise<MemoryFact[]> {
  const key = memoryKey(dirs);
  const path = cachePath(dirs);
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    if (snapshot.v === 1 && snapshot.key === key && Array.isArray(snapshot.concepts)) return snapshot.concepts;
  } catch {
    // No cache yet.
  }
  let concepts: MemoryFact[];
  try {
    concepts = await rebuild(dirs);
  } catch {
    return [];
  }
  try {
    mkdirSync(join(dirs.common, "ways", "context"), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ v: 1, key, concepts } satisfies Snapshot), "utf8");
    renameSync(temporary, path);
  } catch {
    // A read-only Git directory only costs the cache.
  }
  return concepts;
}

export function safeMatch(path: string, globs: readonly string[]): boolean {
  try {
    return matchesAny(path, globs);
  } catch {
    return false;
  }
}
