import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, posix, relative, resolve } from "node:path";
import { parse } from "yaml";
import { isWikiPath, KNOWLEDGE_DIR, WIKI_DIR } from "../domain/constants.js";
import { GitRepository } from "../git/git.js";
import { matchesGlob, normalizeGlob, normalizeRepoPath } from "../memory/glob.js";

export interface OkfDocument {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  links: string[];
}

export interface OkfIssue {
  code: string;
  path: string;
  message: string;
}

/** A concept body longer than this is a document, not a memory: it still passes, with a warning. */
export const MAX_CONCEPT_LINES = 15;

const ACTOR = /^(?:human:[^\s]+|process:[^\s]+|[^\s/]+\/[^\s/]+)$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const GLOB_MARKERS = /[*?]/;

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
    }
  }
  await walk(root);
  return found.sort();
}

export function parseOkfDocument(path: string, root: string, content: string): OkfDocument {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error("Missing YAML frontmatter");
  const value: unknown = parse(match[1] ?? "");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Frontmatter must be a mapping");
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const body = content.slice(match[0].length);
  const links = [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((item) => item[1] ?? "").filter(Boolean);
  return { id: relativePath.replace(/\.md$/, ""), path: relativePath, frontmatter: value as Record<string, unknown>, body, links };
}

/** The `paths:` globs a concept applies to; invalid entries are reported by `inspectOkf`. */
export function conceptPaths(document: OkfDocument): string[] {
  const value = document.frontmatter.paths;
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list.filter((entry): entry is string => typeof entry === "string");
}

export function isCurrentConcept(document: OkfDocument): boolean {
  return document.frontmatter.status !== "deprecated" && !document.path.startsWith("deprecated/");
}

function events(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  return typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function validEvent(event: Record<string, unknown>): boolean {
  return typeof event.by === "string" && ACTOR.test(event.by) && typeof event.at === "string" && DATE_TIME.test(event.at);
}

async function targetExists(root: string, documentPath: string, target: string): Promise<boolean> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return true;
  const clean = target.split("#", 1)[0];
  if (!clean) return true;
  const path = clean.startsWith("/") ? join(root, clean.slice(1)) : resolve(dirname(join(root, documentPath)), clean);
  if (!normalize(path).startsWith(normalize(root))) return false;
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The memory is the agents' source of truth and the wiki (docs/wiki) is for
 * people, derived from code and memory: the wiki cites the memory, never the
 * other way round. A concept whose `sources`, `paths` or links point into the
 * wiki would make a page, which nobody checks against the code the way a
 * concept is, a fact an agent acts on.
 */
function wikiCitations(document: OkfDocument): OkfIssue[] {
  const issues: OkfIssue[] = [];
  const fail = (what: string): void => {
    issues.push({ code: "okf-wiki-citation", path: document.path, message: `${what} points into ${WIKI_DIR}/, the wiki for humans; a memory is grounded in the code, tests and docs it is about, never in the wiki (the wiki cites the memory, not the reverse)` });
  };
  const sources = Array.isArray(document.frontmatter.sources) ? document.frontmatter.sources : [];
  for (const [index, item] of sources.entries()) {
    const resource = item && typeof item === "object" ? (item as Record<string, unknown>).resource : undefined;
    if (typeof resource === "string" && resource.startsWith("/") && isWikiPath(posix.normalize(resource.slice(1)).replace(/\/$/, ""))) fail(`sources[${index}] (${resource})`);
  }
  for (const glob of conceptPaths(document)) {
    const normalized = posix.normalize(glob.replaceAll("\\", "/").replace(/^\.\//, ""));
    if (isWikiPath(normalized.replace(/\/$/, ""))) fail(`paths (${glob})`);
  }
  for (const link of document.links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#")) continue;
    const target = link.split("#", 1)[0] ?? "";
    if (!target) continue;
    // Relative links resolve from the concept's own folder inside .ways/knowledge.
    const resolved = posix.normalize(posix.join(KNOWLEDGE_DIR, posix.dirname(document.path), target.replace(/^\//, "")));
    if (isWikiPath(resolved.replace(/\/$/, ""))) fail(`the link ${link}`);
  }
  return issues;
}

/** Repository-local sources (`/path` or `/glob`) must resolve in the working tree's HEAD. */
async function sourceIssues(cwd: string, documents: readonly OkfDocument[]): Promise<OkfIssue[]> {
  const issues: OkfIssue[] = [];
  let tracked: string[] | undefined;
  for (const document of documents) {
    const sources = document.frontmatter.sources;
    if (!Array.isArray(sources)) continue;
    for (const [index, item] of sources.entries()) {
      const resource = item && typeof item === "object" ? (item as Record<string, unknown>).resource : undefined;
      if (typeof resource !== "string" || !resource.startsWith("/") || resource.startsWith("//")) continue;
      const path = `${document.path}#sources[${index}]`;
      let normalized: string;
      try {
        normalized = GLOB_MARKERS.test(resource) ? normalizeGlob(resource.slice(1)) : normalizeRepoPath(resource.slice(1));
      } catch (error) {
        issues.push({ code: "invalid-source-path", path, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      try {
        tracked ??= (await new GitRepository(cwd).treeEntries("HEAD")).map((entry) => entry.path);
      } catch {
        return issues;
      }
      const resolves = GLOB_MARKERS.test(normalized)
        ? tracked.some((candidate) => matchesGlob(candidate, normalized))
        : tracked.includes(normalized) || tracked.some((candidate) => candidate.startsWith(`${normalized}/`));
      if (!resolves) issues.push({ code: "missing-source", path, message: `Local source does not resolve at HEAD: /${normalized}` });
    }
  }
  return issues;
}

export interface OkfInspection {
  documents: OkfDocument[];
  /** Broken memory: fails `ways memory check` and `ways done`. */
  issues: OkfIssue[];
  /** Worth a look, never blocking: long concepts, a passed `stale_after`. */
  warnings: OkfIssue[];
}

export async function inspectOkf(cwd: string, options: { validateSources?: boolean } = {}): Promise<OkfInspection> {
  const root = join(cwd, KNOWLEDGE_DIR);
  const documents: OkfDocument[] = [];
  const issues: OkfIssue[] = [];
  const warnings: OkfIssue[] = [];
  let markdown: string[];
  try {
    markdown = await files(root);
  } catch {
    return { documents, issues: [{ code: "missing-okf", path: KNOWLEDGE_DIR, message: "Knowledge directory is missing; run `ways bootstrap` or create .ways/knowledge/index.md" }], warnings };
  }

  for (const path of markdown) {
    const relativePath = relative(root, path).replaceAll("\\", "/");
    const name = relativePath.split("/").at(-1);
    const content = await readFile(path, "utf8");
    if (name === "index.md") {
      if (relativePath !== "index.md" && content.startsWith("---\n")) issues.push({ code: "okf-index-frontmatter", path: relativePath, message: "Only the root index may have frontmatter" });
      continue;
    }
    if (name === "log.md") {
      for (const heading of content.matchAll(/^##\s+(.+)$/gm)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(heading[1] ?? "")) issues.push({ code: "okf-log-date", path: relativePath, message: "Log dates must use YYYY-MM-DD" });
      }
      continue;
    }

    let document: OkfDocument;
    try {
      document = parseOkfDocument(path, root, content);
      documents.push(document);
    } catch (error) {
      issues.push({ code: "okf-frontmatter", path: relativePath, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const fm = document.frontmatter;
    if (typeof fm.type !== "string" || !fm.type.trim()) issues.push({ code: "okf-type", path: relativePath, message: "Concept requires a non-empty type" });
    if (fm.status !== undefined && !["draft", "stable", "deprecated"].includes(String(fm.status))) issues.push({ code: "okf-status", path: relativePath, message: "Status must be draft, stable, or deprecated" });
    if (fm.generated !== undefined && (!fm.generated || typeof fm.generated !== "object" || Array.isArray(fm.generated) || !validEvent(fm.generated as Record<string, unknown>))) {
      issues.push({ code: "okf-generated", path: relativePath, message: "generated requires valid by and at fields" });
    }
    const verified = events(fm.verified);
    if (fm.verified !== undefined && (verified.length === 0 || verified.some((event) => !validEvent(event)))) issues.push({ code: "okf-verified", path: relativePath, message: "verified events require valid actors and timestamps" });
    if (typeof fm.stale_after === "string" && (!DATE_TIME.test(fm.stale_after) || Date.parse(fm.stale_after) <= Date.now())) {
      warnings.push({ code: "stale-after-passed", path: relativePath, message: "stale_after has passed or is invalid; confirm the concept and update or remove the date" });
    }
    if (fm.sources !== undefined) {
      if (!Array.isArray(fm.sources) || fm.sources.some((source) => !source || typeof source !== "object" || typeof (source as Record<string, unknown>).resource !== "string")) {
        issues.push({ code: "okf-sources", path: relativePath, message: "Every source requires a resource" });
      }
    }
    if (fm.paths !== undefined) {
      const raw = typeof fm.paths === "string" ? [fm.paths] : fm.paths;
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
        issues.push({ code: "okf-paths", path: relativePath, message: "paths must be a list of repository-relative globs" });
      } else {
        for (const entry of raw as string[]) {
          try {
            normalizeGlob(entry);
          } catch (error) {
            issues.push({ code: "okf-paths", path: relativePath, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
    issues.push(...wikiCitations(document));
    const lines = document.body.split("\n").filter((line) => line.trim()).length;
    if (lines > MAX_CONCEPT_LINES) warnings.push({ code: "long-concept", path: relativePath, message: `${lines} lines; a memory is a short fact (≤ ${MAX_CONCEPT_LINES} lines): split it or move the detail to docs/` });
    for (const link of document.links) {
      if (!await targetExists(root, document.path, link)) issues.push({ code: "broken-okf-link", path: relativePath, message: `Missing link target: ${link}` });
    }
  }
  if (options.validateSources ?? true) issues.push(...await sourceIssues(cwd, documents.filter(isCurrentConcept)));
  return { documents, issues, warnings };
}
