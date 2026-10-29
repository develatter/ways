import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { isWikiPath, KNOWLEDGE_DIR, slugify } from "../domain/constants.js";
import { writeAtomic } from "../fs/files.js";
import { GitRepository, type GitTreeEntry } from "../git/git.js";
import { conceptPaths, inspectOkf, isCurrentConcept, MAX_CONCEPT_LINES, type OkfDocument, type OkfIssue } from "../knowledge/okf.js";
import { matchesAny, normalizeGlob } from "./glob.js";

/**
 * Memory is a set of short OKF concepts. A concept may declare `paths:` globs;
 * that ties it to the code it is about, so `ways done` and `ways status` can
 * point at the memory of the area being changed, and freshness can be judged
 * by content: a concept is possibly stale when the files under its paths now
 * hash differently from when the concept was last committed.
 */

export const MEMORY_TYPES = {
  convention: "conventions",
  decision: "decisions",
  pitfall: "pitfalls",
  howto: "howto",
} as const;
export type MemoryType = keyof typeof MEMORY_TYPES;

export interface RelevantConcept {
  path: string;
  title: string;
  paths: string[];
  /** Files under its paths changed since the concept was last committed. */
  stale: boolean;
}

function title(document: OkfDocument): string {
  return typeof document.frontmatter.title === "string" ? document.frontmatter.title : document.id.split("/").at(-1) ?? document.id;
}

/** sha256 over the path and blob id of every tracked file under `globs`. */
export function pathsFingerprint(entries: readonly GitTreeEntry[], globs: readonly string[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (!matchesAny(entry.path, globs)) continue;
    hash.update(`${entry.path}\0${entry.object}\n`);
  }
  return hash.digest("hex");
}

class TreeCache {
  private readonly trees = new Map<string, Promise<GitTreeEntry[]>>();
  constructor(private readonly git: GitRepository) {}
  entries(ref: string): Promise<GitTreeEntry[]> {
    let found = this.trees.get(ref);
    if (!found) {
      // Neither the memory itself nor the wiki for humans is code a concept can go stale against.
      found = this.git.treeEntries(ref).then((entries) => entries.filter((entry) => !entry.path.startsWith(`${KNOWLEDGE_DIR}/`) && !isWikiPath(entry.path)));
      this.trees.set(ref, found);
    }
    return found;
  }
}

async function lastCommitOf(git: GitRepository, path: string): Promise<string | undefined> {
  try {
    return (await git.run(["log", "-1", "--format=%H", "--", path])) || undefined;
  } catch {
    return undefined;
  }
}

async function isStale(git: GitRepository, cache: TreeCache, document: OkfDocument, globs: readonly string[]): Promise<boolean> {
  const last = await lastCommitOf(git, `${KNOWLEDGE_DIR}/${document.path}`);
  if (!last) return false;
  try {
    return pathsFingerprint(await cache.entries(last), globs) !== pathsFingerprint(await cache.entries("HEAD"), globs);
  } catch {
    return false;
  }
}

/** Current concepts whose `paths` cover any of `changed`, with their freshness. */
export async function relevantConcepts(cwd: string, changed: readonly string[], documents?: readonly OkfDocument[]): Promise<RelevantConcept[]> {
  const concepts = documents ?? (await inspectOkf(cwd, { validateSources: false })).documents;
  const git = new GitRepository(cwd);
  const cache = new TreeCache(git);
  const relevant: RelevantConcept[] = [];
  for (const document of concepts.filter(isCurrentConcept)) {
    const globs = conceptPaths(document);
    if (globs.length === 0 || !changed.some((path) => !isWikiPath(path) && safeMatch(path, globs))) continue;
    relevant.push({ path: `${KNOWLEDGE_DIR}/${document.path}`, title: title(document), paths: globs, stale: await isStale(git, cache, document, globs) });
  }
  return relevant;
}

function safeMatch(path: string, globs: readonly string[]): boolean {
  try {
    return matchesAny(path, globs);
  } catch {
    return false;
  }
}

/** Concepts whose paths changed after they were last committed. */
export async function staleConcepts(cwd: string, documents: readonly OkfDocument[]): Promise<OkfIssue[]> {
  const git = new GitRepository(cwd);
  const cache = new TreeCache(git);
  const warnings: OkfIssue[] = [];
  for (const document of documents.filter(isCurrentConcept)) {
    const globs = conceptPaths(document);
    if (globs.length === 0) continue;
    try {
      if (await isStale(git, cache, document, globs)) {
        warnings.push({ code: "possibly-stale", path: document.path, message: `files under ${globs.join(", ")} changed since this concept was last committed; confirm it is still true (any edit refreshes it)` });
      }
    } catch {
      // Invalid globs are reported as issues by inspectOkf.
    }
  }
  return warnings;
}

export interface MemoryCheck {
  issues: OkfIssue[];
  warnings: OkfIssue[];
  concepts: number;
}

export async function checkMemory(cwd: string): Promise<MemoryCheck> {
  const inspection = await inspectOkf(cwd);
  const { seededIssues, seededWarnings } = await import("./verify.js");
  inspection.issues.push(...await seededIssues(cwd, inspection.documents));
  const warnings = [...inspection.warnings, ...await staleConcepts(cwd, inspection.documents), ...await seededWarnings(cwd, inspection.documents)];
  const { claudeInstalled, rulesDrift } = await import("../context/rules.js");
  if (await claudeInstalled(cwd)) {
    const drift = await rulesDrift(cwd, inspection.documents);
    for (const path of drift.outdated) warnings.push({ code: "rule-outdated", path, message: "the Claude Code rule no longer matches its concept; run `ways memory index` and commit the result" });
    for (const path of drift.orphaned) warnings.push({ code: "rule-orphaned", path, message: "no concept with paths generates this rule any more; run `ways memory index` and commit the result" });
  }
  return { issues: inspection.issues, warnings, concepts: inspection.documents.length };
}

export interface RememberOptions {
  paths?: readonly string[];
  type?: MemoryType;
  id?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes one short concept to `.ways/knowledge/<type>/<slug>.md` and returns
 * its path. It is not committed: it travels in the commit of the change that
 * taught it.
 */
export async function remember(cwd: string, fact: string, options: RememberOptions = {}): Promise<{ path: string; warnings: string[] }> {
  const text = fact.trim();
  if (!text) throw new Error("Nothing to remember: give the fact as text, e.g. ways remember \"Tokens refresh 60 s early\" --path=src/auth/**");
  const type = options.type ?? "convention";
  if (!Object.hasOwn(MEMORY_TYPES, type)) throw new Error(`--type must be one of ${Object.keys(MEMORY_TYPES).join(", ")}`);
  const paths = (options.paths ?? []).map((glob) => normalizeGlob(glob));
  const base = options.id ?? slugify(text.split(/\s+/).slice(0, 8).join(" "));
  if (!base || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(base)) throw new Error("Could not derive a file name from the fact; pass --id=<slug>");
  const directory = MEMORY_TYPES[type];
  let slug = base;
  for (let suffix = 2; await exists(join(cwd, KNOWLEDGE_DIR, directory, `${slug}.md`)); suffix += 1) {
    if (options.id) throw new Error(`${KNOWLEDGE_DIR}/${directory}/${slug}.md already exists; edit it instead`);
    slug = `${base}-${suffix}`;
  }
  const firstLine = text.split("\n")[0]!.replace(/\s+/g, " ");
  const frontmatter: Record<string, unknown> = {
    type,
    title: firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine,
    ...(paths.length > 0 ? { paths } : {}),
    generated: { by: "process:ways-remember", at: new Date().toISOString().replace(/\.\d+Z$/, "Z") },
  };
  const relative = `${KNOWLEDGE_DIR}/${directory}/${slug}.md`;
  await writeAtomic(join(cwd, relative), `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${text}\n`);
  const lines = text.split("\n").filter((line) => line.trim()).length;
  const warnings = lines > MAX_CONCEPT_LINES ? [`${lines} lines: a memory is a short fact (≤ ${MAX_CONCEPT_LINES} lines)`] : [];
  if (paths.length === 0) warnings.push("no --path given: the concept will not be suggested when that code changes");
  return { path: relative, warnings };
}
