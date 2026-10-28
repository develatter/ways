import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessConfig, MemoryConfig } from "../domain/types.js";
import { INDEX_DIR, KNOWLEDGE_DIR } from "../domain/constants.js";
import { writeAtomic } from "../fs/files.js";
import { requestDiscovery } from "../memory/workflow.js";
import { compareVersions } from "../version.js";

export interface MigrationContext {
  cwd: string;
  config: HarnessConfig;
}

export interface Migration {
  from: string;
  to: string;
  run(context: MigrationContext): Promise<void>;
}

const LIFECYCLE_DIRECTORIES = ["coverage", "roadmap", "debt", "deprecated"] as const;

function legacyMemoryConfig(config: HarnessConfig): MemoryConfig {
  return {
    releaseBranch: config.defaultBranch ?? "main",
    reconciliationBranchPattern: "reconcile/*",
    relevantPaths: ["**/*"],
    excludedPaths: [".git/**", ".ways/**", "dist/**", "node_modules/**"],
  };
}

/**
 * v0.2 makes indexes disposable and requires a reviewed discovery watermark.
 * Existing work state and SDD history are deliberately untouched: in particular,
 * old reconcile-memory certifications retain their original meaning.
 */
export async function migrateLivingMemory(context: MigrationContext): Promise<void> {
  context.config.memory ??= legacyMemoryConfig(context.config);
  for (const directory of LIFECYCLE_DIRECTORIES) {
    await mkdir(join(context.cwd, KNOWLEDGE_DIR, directory), { recursive: true });
  }

  const ignorePath = join(context.cwd, ".ways/.gitignore");
  let ignore = "";
  try {
    ignore = await readFile(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!ignore.split(/\r?\n/).includes("indexes/")) {
    await writeAtomic(ignorePath, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}indexes/\n`);
  }
  await rm(join(context.cwd, INDEX_DIR), { recursive: true, force: true });

  // requestDiscovery is itself idempotent, including after an interrupted upgrade.
  try {
    await requestDiscovery(context.cwd);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("baseline already exists")) throw error;
  }
}

export const MIGRATIONS: Migration[] = [
  { from: "0.1.0", to: "0.2.0", run: migrateLivingMemory },
];

export async function runMigrations(context: MigrationContext, target: string): Promise<void> {
  let version = context.config.harnessVersion;
  const visited = new Set<string>();
  while (version !== target) {
    if (visited.has(version)) throw new Error(`Migration cycle at ${version}`);
    visited.add(version);
    const migration = MIGRATIONS.find((candidate) => candidate.from === version);
    if (!migration && compareVersions(version, target) < 0) {
      // No structural change between these versions: only the recorded version moves.
      context.config.harnessVersion = target;
      return;
    }
    if (!migration) throw new Error(`No migration path from ${version} to ${target}; this repository was written by a newer or unknown ways`);
    await migration.run(context);
    version = migration.to;
    context.config.harnessVersion = version;
  }
}
