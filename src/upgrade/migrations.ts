import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { CONFIG_PATH, isWorkId, KNOWLEDGE_DIR } from "../domain/constants.js";
import type { HarnessConfig } from "../domain/types.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { readActive, writeActive } from "../runtime/runtime.js";

/**
 * 0.2 → lean. What carries over: the check contract, the memory (coverage
 * globs become `paths:` on the concepts they covered) and an active quick
 * work (it becomes the active change). What goes: SDD and plan support, the
 * committed state file and its status mirror, discovery and reconciliation
 * artifacts, the coverage shards and watermark, derived indexes. Old
 * `.ways/outcomes/`, `.ways/sdd/` and `.ways/plans/` stay in place and in
 * history; ways ignores them and says once that they can be deleted.
 */
export interface MigrationReport {
  notes: string[];
}

const LEGACY_STATE = ".ways/state/current.json";
const LEGACY_STATUS = ".ways/status.json";
const LEGACY_DIRECTORIES = [".ways/memory", ".ways/indexes", ".ways/runtime", ".ways/reconciliations"];
/** 0.2 task worktrees may hold uncommitted work: they are reported, never deleted. */
const LEGACY_WORKTREES = ".ways/worktrees";
const LEGACY_HISTORY = [".ways/outcomes", ".ways/sdd", ".ways/plans"];
const LEGACY_DIRECTORY_INDEX = "# Concepts\n\nNo concepts recorded.\n";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 0.2 config keeps its checks and history anchor; the memory branch settings have no meaning any more. */
export function migrateConfig(value: unknown, version: string): { config: HarnessConfig; notes: string[] } {
  if (!isRecord(value) || !Array.isArray(value.testCommand)) throw new Error(`${CONFIG_PATH} is unreadable; fix it or rerun \`ways bootstrap --force\``);
  if (value.schemaVersion === 2) return { config: { ...(value as unknown as HarnessConfig), harnessVersion: version }, notes: [] };
  const notes: string[] = [];
  const config: HarnessConfig = {
    schemaVersion: 2,
    harnessVersion: version,
    enforcement: "observe",
    testCommand: value.testCommand as string[],
    ...(isRecord(value.commands) ? { commands: value.commands as unknown as NonNullable<HarnessConfig["commands"]> } : {}),
    ...(typeof value.historySince === "string" ? { historySince: value.historySince } : {}),
  };
  if (value.memory !== undefined) notes.push("Dropped the memory release/reconciliation settings: memory no longer needs discovery or reconciliation.");
  notes.push("enforcement is observe: commits are only refused when they hand-edit a work record. Set \"enforcement\": \"enforce\" in .ways/config.json to also refuse commits outside an active work.");
  return { config, notes };
}

async function migrateActiveState(cwd: string): Promise<string[]> {
  const path = join(cwd, LEGACY_STATE);
  const state = await readJson(path);
  const notes: string[] = [];
  if (isRecord(state) && typeof state.id === "string" && isWorkId(state.id)) {
    const git = new GitRepository(cwd);
    if (state.mode === "quick" && !readActive(cwd)) {
      const recorded = typeof state.baseCommit === "string" ? state.baseCommit : undefined;
      const base = recorded && await git.isAncestor(recorded) ? recorded : await git.head();
      await writeActive(cwd, { schemaVersion: 1, id: state.id, kind: "change", base, startedAt: typeof state.createdAt === "string" ? state.createdAt : new Date().toISOString(), origin: "start" });
      notes.push(`Active quick work ${state.id} continues as the active change; finish it with \`ways done\`.`);
    } else if (state.mode === "outcome") {
      const spec = await readJson(join(cwd, ".ways/outcomes", state.id, "outcome.json"));
      const goal = isRecord(spec) && typeof spec.goal === "string" ? spec.goal : "<goal>";
      const criteria = isRecord(spec) && Array.isArray(spec.criteria) ? spec.criteria.filter(isRecord).map((criterion) => `--criterion=${JSON.stringify(`${String(criterion.id)}:${String(criterion.text)}`)}`) : [];
      notes.push(`Active 0.2 outcome ${state.id} was not carried over (attempts and tasks no longer exist). Reopen it with: ways outcome open ${state.id} --goal=${JSON.stringify(goal)} ${criteria.join(" ")} (add --verify=<ID>:<command> per criterion).`);
    } else {
      notes.push(`Active ${String(state.mode)} work ${state.id} was dropped: SDD and plan are no longer supported. Its artifacts stay in .ways/ and in history.`);
    }
  }
  await rm(path, { force: true });
  await rm(join(cwd, ".ways/state"), { recursive: true, force: true });
  await rm(join(cwd, LEGACY_STATUS), { force: true });
  return notes;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  }
  await walk(directory);
  return found.sort();
}

/** Coverage areas map globs to concepts; the globs move onto the concepts as `paths:`. */
async function migrateCoverage(cwd: string): Promise<string[]> {
  const coverageDir = join(cwd, KNOWLEDGE_DIR, "coverage");
  const globsByConcept = new Map<string, Set<string>>();
  for (const file of await markdownFiles(coverageDir)) {
    if (!file.endsWith(".json")) continue;
    const area = await readJson(file);
    if (!isRecord(area) || !Array.isArray(area.globs) || !Array.isArray(area.concepts) || area.classification !== "concept-backed") continue;
    for (const concept of area.concepts) {
      if (typeof concept !== "string") continue;
      const set = globsByConcept.get(concept) ?? new Set<string>();
      for (const glob of area.globs) if (typeof glob === "string") set.add(glob);
      globsByConcept.set(concept, set);
    }
  }
  const notes: string[] = [];
  let moved = 0;
  for (const [concept, globs] of globsByConcept) {
    const path = join(cwd, KNOWLEDGE_DIR, `${concept}.md`);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) continue;
    const frontmatter = parse(match[1] ?? "") as Record<string, unknown>;
    if (!isRecord(frontmatter)) continue;
    const existing = Array.isArray(frontmatter.paths) ? frontmatter.paths.filter((entry): entry is string => typeof entry === "string") : [];
    frontmatter.paths = [...new Set([...existing, ...globs])];
    await writeAtomic(path, `---\n${stringify(frontmatter).trimEnd()}\n---\n${content.slice(match[0].length).startsWith("\n") ? "" : "\n"}${content.slice(match[0].length)}`);
    moved += 1;
  }
  if (await exists(coverageDir)) {
    await rm(coverageDir, { recursive: true, force: true });
    notes.push(`Moved coverage globs onto ${moved} concept(s) as \`paths:\` and removed .ways/knowledge/coverage/.`);
  }
  if (await exists(join(cwd, KNOWLEDGE_DIR, "state.json"))) {
    await rm(join(cwd, KNOWLEDGE_DIR, "state.json"), { force: true });
    notes.push("Removed the memory watermark .ways/knowledge/state.json: freshness is now judged per concept from its paths.");
  }
  // The empty per-type index files 0.2 seeded say nothing; edited ones stay.
  for (const file of await markdownFiles(join(cwd, KNOWLEDGE_DIR))) {
    if (!file.endsWith("/index.md") || file === join(cwd, KNOWLEDGE_DIR, "index.md")) continue;
    if (await readFile(file, "utf8") === LEGACY_DIRECTORY_INDEX) await rm(file, { force: true });
  }
  return notes;
}

export async function migrateFromLegacy(cwd: string): Promise<MigrationReport> {
  const notes = [...await migrateActiveState(cwd), ...await migrateCoverage(cwd)];
  for (const directory of LEGACY_DIRECTORIES) {
    if (!await exists(join(cwd, directory))) continue;
    await rm(join(cwd, directory), { recursive: true, force: true });
    notes.push(`Removed ${directory}/ (0.2 discovery, reconciliation, index or worktree data).`);
  }
  if (await exists(join(cwd, LEGACY_WORKTREES))) {
    notes.push(`${LEGACY_WORKTREES}/ holds 0.2 task worktrees; commit or move anything you need from them, then remove each with \`git worktree remove <path>\`.`);
  }
  const legacy: string[] = [];
  for (const directory of LEGACY_HISTORY) if (await exists(join(cwd, directory))) legacy.push(`${directory}/`);
  if (legacy.length > 0) notes.push(`${legacy.join(", ")} hold 0.2 work artifacts that ways no longer reads; they stay in history, so you can delete them.`);
  return { notes };
}

export async function writeConfig(cwd: string, config: HarnessConfig): Promise<void> {
  await writeAtomic(join(cwd, CONFIG_PATH), stableJson(config));
}
