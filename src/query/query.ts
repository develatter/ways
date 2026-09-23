import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveMemoryConfig, loadConfig } from "../config/config.js";
import { KNOWLEDGE_DIR } from "../domain/constants.js";
import { loadIndexes, type KnowledgeIndexes } from "../knowledge/indexes.js";
import { inspectMemoryFreshness } from "../memory/freshness.js";
import type { MemoryState } from "../memory/model.js";
import { DISCOVERY_PATH, MEMORY_STATE_PATH } from "../memory/workflow.js";

export type QueryLabel = "draft" | "unverified" | "roadmap" | "debt";

export interface QueryHit {
  path: string;
  score: number;
  preview: string;
  labels: QueryLabel[];
}

export interface QueryResult {
  hits: QueryHit[];
  warnings: string[];
}

export interface QueryOptions {
  limit?: number;
  /** Supplied by the memory watermark owner to describe branch/code-tree drift. */
  freshness?: (cwd: string) => Promise<string[]>;
  /** Prebuilt indexes; read-only callers pass them so the on-disk cache is never rewritten. */
  indexes?: KnowledgeIndexes;
}

type CatalogDocument = KnowledgeIndexes["catalog"]["documents"][number];

function labels(document: CatalogDocument): QueryLabel[] {
  const result: QueryLabel[] = [];
  if (document.status === "draft") result.push("draft");
  if (document.trust === "unverified") result.push("unverified");
  if (document.type === "roadmap" || document.path.startsWith("roadmap/")) result.push("roadmap");
  if (document.type === "debt" || document.path.startsWith("debt/")) result.push("debt");
  return result;
}

function isDeprecated(document: CatalogDocument): boolean {
  return document.status === "deprecated" || document.path.startsWith("deprecated/");
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
}

async function preview(cwd: string, path: string): Promise<string> {
  const content = await readFile(join(cwd, KNOWLEDGE_DIR, path), "utf8");
  return content.replace(/^---[\s\S]*?---\s*/u, "").replace(/\s+/g, " ").trim().slice(0, 180);
}

async function defaultFreshnessWarnings(cwd: string): Promise<string[]> {
  try {
    const state = JSON.parse(await readFile(join(cwd, MEMORY_STATE_PATH), "utf8")) as MemoryState;
    const config = effectiveMemoryConfig(await loadConfig(cwd));
    return (await inspectMemoryFreshness(cwd, config, state)).warnings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await readFile(join(cwd, DISCOVERY_PATH), "utf8");
      return ["Memory baseline is incomplete: reviewed discovery and coverage are still required."];
    } catch (discoveryError) {
      if ((discoveryError as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw discoveryError;
    }
  }
}

export async function queryKnowledgeResult(cwd: string, query: string, options: QueryOptions = {}): Promise<QueryResult> {
  const terms = queryTerms(query);
  const warnings = await (options.freshness ?? defaultFreshnessWarnings)(cwd);
  if (terms.length === 0) return { hits: [], warnings };

  const indexes = options.indexes ?? await loadIndexes(cwd);
  const scores = new Map<string, number>();
  for (const term of terms) {
    const matching = new Set(Object.entries(indexes.search.terms)
      .filter(([indexed]) => indexed.includes(term))
      .flatMap(([, ids]) => ids));
    for (const id of matching) scores.set(id, (scores.get(id) ?? 0) + 1);
  }

  const documents = new Map(indexes.catalog.documents.map((document) => [document.id, document]));
  const ranked = [...scores.entries()]
    .map(([id, score]) => ({ document: documents.get(id), score }))
    .filter((item): item is { document: CatalogDocument; score: number } => Boolean(item.document) && !isDeprecated(item.document!))
    .sort((a, b) => b.score - a.score || (a.document.path < b.document.path ? -1 : a.document.path > b.document.path ? 1 : 0))
    .slice(0, options.limit ?? 10);

  const hits = await Promise.all(ranked.map(async ({ document, score }): Promise<QueryHit> => ({
    path: `${KNOWLEDGE_DIR}/${document.path}`,
    score,
    preview: await preview(cwd, document.path),
    labels: labels(document),
  })));
  return { hits, warnings };
}

/** Backwards-compatible hit-only API. Use queryKnowledgeResult when warnings are needed. */
export async function queryKnowledge(cwd: string, query: string, limit = 10): Promise<QueryHit[]> {
  return (await queryKnowledgeResult(cwd, query, { limit })).hits;
}
