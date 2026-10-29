import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { KNOWLEDGE_DIR } from "../domain/constants.js";
import { writeAtomic } from "../fs/files.js";
import { conceptPaths, isCurrentConcept, type OkfDocument, type OkfIssue } from "../knowledge/okf.js";
import { hashSources, repositoryFiles, sameHash } from "../wiki/sources.js";
import { matchesAny, normalizeRepoPath } from "./glob.js";

/**
 * Facts an agent seeded (`ways onboard`) are not trusted until a person
 * confirms them. Each carries `sources` (the files it was read from), and
 * ways, not the agent, writes the hash of each source: a fact whose source
 * changed is marked stale, never hidden. `ways memory check` refuses a
 * seeded fact without sources or with sources or paths that name nothing.
 * `ways memory confirm <id>` (a person at a terminal) marks it verified.
 *
 * Confirmation by use (a `ways done` that touched the fact's paths without
 * contradicting it) is not done: telling "did not contradict" apart from
 * "did not look" needs judgement ways does not have (ADR 0012).
 */
export const ONBOARD_ACTOR = "process:ways-onboard";

interface Source {
  resource: string;
  hash?: string;
}

function sources(document: Pick<OkfDocument, "frontmatter">): Source[] {
  const value = document.frontmatter.sources;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Source => Boolean(item) && typeof item === "object" && typeof (item as Source).resource === "string");
}

function localPath(resource: string): string | undefined {
  if (!resource.startsWith("/") || resource.startsWith("//")) return undefined;
  try {
    return normalizeRepoPath(resource.slice(1));
  } catch {
    return undefined;
  }
}

export function isSeeded(document: Pick<OkfDocument, "frontmatter">): boolean {
  const generated = document.frontmatter.generated;
  return Boolean(generated) && typeof generated === "object" && (generated as { by?: unknown }).by === ONBOARD_ACTOR;
}

function verified(document: Pick<OkfDocument, "frontmatter">): boolean {
  const value = document.frontmatter.verified;
  return Array.isArray(value) ? value.length > 0 : Boolean(value && typeof value === "object");
}

/** A seeded fact nobody confirmed yet. */
export function isUnverified(document: Pick<OkfDocument, "frontmatter">): boolean {
  return isSeeded(document) && !verified(document);
}

/** Sources whose recorded hash no longer matches the file (or whose file is gone). */
export async function changedSources(top: string, document: Pick<OkfDocument, "frontmatter">, files?: readonly string[]): Promise<string[]> {
  const recorded = sources(document).map((source) => ({ path: localPath(source.resource), hash: source.hash })).filter((entry): entry is { path: string; hash: string } => entry.path !== undefined && typeof entry.hash === "string");
  if (recorded.length === 0) return [];
  const current = await hashSources(top, recorded.map((entry) => entry.path), files);
  return recorded.filter((entry) => {
    const now = current.get(entry.path);
    return now === undefined || !sameHash(entry.hash, now);
  }).map((entry) => entry.path);
}

/**
 * What makes a seeded fact unusable: no sources, a source or a `paths` glob
 * that names nothing in the repository. Facts written by people or by `ways
 * remember` are not held to this (they travel in a reviewed commit).
 */
export async function seededIssues(top: string, documents: readonly OkfDocument[]): Promise<OkfIssue[]> {
  const seeded = documents.filter((document) => isSeeded(document) && isCurrentConcept(document));
  if (seeded.length === 0) return [];
  const files = await repositoryFiles(top);
  const issues: OkfIssue[] = [];
  for (const document of seeded) {
    const list = sources(document);
    if (list.length === 0) {
      issues.push({ code: "seeded-without-source", path: document.path, message: "an onboarded fact needs `sources` (the files it was read from), so it can be checked and go stale; add them or delete the fact" });
      continue;
    }
    for (const source of list) {
      const path = localPath(source.resource);
      if (path === undefined) continue;
      const exists = files.includes(path) || files.some((file) => file.startsWith(`${path.replace(/\/$/, "")}/`));
      if (!exists) issues.push({ code: "seeded-missing-source", path: document.path, message: `source /${path} does not exist in the repository` });
    }
    const globs = conceptPaths(document);
    let matches = true;
    try {
      matches = globs.length === 0 || files.some((file) => matchesAny(file, globs));
    } catch {
      matches = true;
    }
    if (!matches) issues.push({ code: "seeded-paths-match-nothing", path: document.path, message: `paths ${globs.join(", ")} match no file in the repository` });
  }
  return issues;
}

/** Warnings for seeded facts: unverified, and stale because a source changed. */
export async function seededWarnings(top: string, documents: readonly OkfDocument[]): Promise<OkfIssue[]> {
  const warnings: OkfIssue[] = [];
  const seeded = documents.filter((document) => isSeeded(document) && isCurrentConcept(document));
  if (seeded.length === 0) return warnings;
  const files = await repositoryFiles(top);
  for (const document of seeded) {
    const changed = await changedSources(top, document, files);
    if (changed.length > 0) warnings.push({ code: "source-changed", path: document.path, message: `its source changed since it was written (${changed.join(", ")}): check it against them, edit it if needed, then \`ways memory confirm ${document.id}\`` });
    else if (isUnverified(document)) warnings.push({ code: "unverified", path: document.path, message: `seeded by \`ways onboard\` and not confirmed yet: a person checks it and runs \`ways memory confirm ${document.id}\`` });
  }
  return warnings;
}

interface ConceptFile {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

async function readConcept(top: string, relative: string): Promise<ConceptFile> {
  const text = await readFile(join(top, relative), "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error(`${relative} has no frontmatter`);
  const frontmatter: unknown = parse(match[1] ?? "");
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error(`${relative}: frontmatter must be a mapping`);
  return { path: relative, frontmatter: frontmatter as Record<string, unknown>, body: text.slice(match[0].length) };
}

async function writeConcept(top: string, concept: ConceptFile): Promise<void> {
  await writeAtomic(join(top, concept.path), `---\n${stringify(concept.frontmatter).trimEnd()}\n---\n${concept.body.startsWith("\n") ? "" : "\n"}${concept.body}`);
}

async function withHashes(top: string, frontmatter: Record<string, unknown>): Promise<void> {
  const list = sources({ frontmatter });
  const paths = list.map((source) => localPath(source.resource)).filter((path): path is string => path !== undefined);
  const hashes = await hashSources(top, paths);
  frontmatter.sources = list.map((source) => {
    const path = localPath(source.resource);
    const hash = path === undefined ? undefined : hashes.get(path);
    const { hash: _old, ...rest } = source;
    return hash ? { ...rest, hash } : rest;
  });
}

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** After an onboarding run: mark the fact as seeded (unverified) and record its sources' hashes. Written by ways, not the agent. */
export async function stampSeeded(top: string, relative: string): Promise<void> {
  const concept = await readConcept(top, relative);
  concept.frontmatter.generated = { by: ONBOARD_ACTOR, at: now() };
  delete concept.frontmatter.verified;
  await withHashes(top, concept.frontmatter);
  await writeConcept(top, concept);
}

/** Resolves `conventions/x`, `conventions/x.md` or `.ways/knowledge/conventions/x.md` to the concept file. */
export function conceptFile(id: string): string {
  const clean = id.trim().replace(/^\.?\/*/, "").replace(new RegExp(`^${KNOWLEDGE_DIR.replace(".", "\\.")}/`), "").replace(/\.md$/, "");
  const path = normalizeRepoPath(`${clean}.md`);
  return `${KNOWLEDGE_DIR}/${path}`;
}

/** `ways memory confirm <id>`: a person checked the fact against its sources. Records who and when, and the sources' current hashes. */
export async function confirmConcept(top: string, id: string, by: string): Promise<{ path: string }> {
  const relative = conceptFile(id);
  let concept: ConceptFile;
  try {
    concept = await readConcept(top, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No concept ${id} (${relative}); \`ways memory check\` lists the unverified ones by id`);
    throw error;
  }
  const events = Array.isArray(concept.frontmatter.verified) ? concept.frontmatter.verified : concept.frontmatter.verified ? [concept.frontmatter.verified] : [];
  concept.frontmatter.verified = [...events, { by, at: now() }];
  await withHashes(top, concept.frontmatter);
  await writeConcept(top, concept);
  return { path: relative };
}
