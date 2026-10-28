import { chmod, lstat, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_VERSION } from "../index.js";
import { CONFIG_PATH, HOOKS_DIR, KNOWLEDGE_DIR, MANIFEST_PATH, PLAN_DIR, SDD_DIR, STATE_PATH, WAYS_DIR } from "../domain/constants.js";
import type { HarnessConfig, ManagedManifest, MemoryConfig, NamedChecksConfig } from "../domain/types.js";
import { validateConfig, validationDetails } from "../domain/validation.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { installAllAdapters } from "../adapters/install.js";
import { writeStatus } from "../state/status.js";
import { requestDiscovery } from "../memory/workflow.js";
import { CLAUDE_MD_CONTENT, CLAUDE_MD_PATH, withAgentsImport } from "./claude-md.js";

export interface BootstrapOptions {
  cwd: string;
  testCommand: string[];
  commands?: NamedChecksConfig;
  force?: boolean;
  adapters?: boolean;
  memory?: Partial<MemoryConfig>;
}

export const MANAGED_ASSETS: Array<[string, string, number?]> = [
  ["AGENTS.md", "AGENTS.md"],
  ["MAP.md", "MAP.md"],
  ["scripts/check.sh", "check.sh", 0o755],
  [`${HOOKS_DIR}/commit-msg`, "commit-msg", 0o755],
  [".ways/.gitignore", "ways.gitignore"],
];
const KNOWLEDGE_TYPES = ["system", "components", "conventions", "decisions", "faq", "roadmap", "debt", "deprecated"];

export function assetPath(relative: string): string {
  return fileURLToPath(new URL(`../../assets/bootstrap/${relative}`, import.meta.url));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function installFile(root: string, target: string, asset: string, force: boolean, mode?: number): Promise<string> {
  const targetPath = join(root, target);
  const content = await readFile(assetPath(asset));
  if (!force && await exists(targetPath)) {
    const current = await readFile(targetPath);
    if (!current.equals(content)) throw new Error(`Refusing to overwrite ${target}; use --force`);
    if (mode !== undefined) await chmod(targetPath, mode);
    return sha256(content);
  }
  await writeAtomic(targetPath, content.toString("utf8"), mode);
  if (mode !== undefined) await chmod(targetPath, mode);
  return sha256(content);
}

export async function installHooks(git: GitRepository): Promise<void> {
  await git.run(["config", "core.hooksPath", HOOKS_DIR]);
}
export async function bootstrap(options: BootstrapOptions): Promise<ManagedManifest> {
  const root = await realpath(resolve(options.cwd));
  const git = new GitRepository(root);
  if (await realpath(await git.root()) !== root) throw new Error("Bootstrap must run at the Git repository root");
  if (!Array.isArray(options.testCommand) || options.testCommand.length === 0 || options.testCommand.some((part) => typeof part !== "string")) {
    throw new Error("A non-empty test command is required");
  }
  if (options.commands !== undefined) {
    const candidate: HarnessConfig = { schemaVersion: 1, harnessVersion: HARNESS_VERSION, testCommand: [...options.testCommand], commands: options.commands };
    if (!validateConfig(candidate)) throw new Error(`Invalid commands configuration: ${validationDetails("config", candidate).errors.join("; ")}`);
  }
  const force = options.force ?? false;

  await Promise.all([
    mkdir(join(root, dirname(STATE_PATH)), { recursive: true }),
    mkdir(join(root, PLAN_DIR), { recursive: true }),
    mkdir(join(root, SDD_DIR), { recursive: true }),
    mkdir(join(root, KNOWLEDGE_DIR), { recursive: true }),
  ]);

  const managedFiles: Record<string, string> = {};
  for (const [target, asset, mode] of MANAGED_ASSETS) {
    managedFiles[target] = await installFile(root, target, asset, force, mode);
  }

  const claudePath = join(root, CLAUDE_MD_PATH);
  if (!await exists(claudePath)) {
    await writeAtomic(claudePath, CLAUDE_MD_CONTENT);
  } else if ((await lstat(claudePath)).isSymbolicLink()) {
    // A symlink from an earlier bootstrap keeps working; only a foreign target is replaced, and only with --force.
    if (await readlink(claudePath) !== "AGENTS.md") {
      if (!force) throw new Error("CLAUDE.md is a symlink to something other than AGENTS.md; rerun with --force to replace it, or point it at AGENTS.md");
      await rm(claudePath, { force: true });
      await writeAtomic(claudePath, CLAUDE_MD_CONTENT);
    }
  } else {
    // The user's own notes stay; the harness only adds the import line.
    const current = await readFile(claudePath, "utf8");
    const next = withAgentsImport(current);
    if (next !== current) await writeAtomic(claudePath, next);
  }

  await installFile(root, `${KNOWLEDGE_DIR}/index.md`, "knowledge-index.md", force);
  for (const type of KNOWLEDGE_TYPES) {
    await installFile(root, `${KNOWLEDGE_DIR}/${type}/index.md`, "knowledge-directory-index.md", force);
  }

  await mkdir(join(root, KNOWLEDGE_DIR, "coverage"), { recursive: true });

  const memory: MemoryConfig = {
    releaseBranch: options.memory?.releaseBranch ?? "main",
    ...(options.memory?.integrationBranch ? { integrationBranch: options.memory.integrationBranch } : {}),
    reconciliationBranchPattern: options.memory?.reconciliationBranchPattern ?? "reconcile/*",
    relevantPaths: options.memory?.relevantPaths ?? ["**/*"],
    excludedPaths: options.memory?.excludedPaths ?? [".git/**", ".ways/**", "dist/**", "node_modules/**"],
  };
  const config: HarnessConfig = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    testCommand: [...options.testCommand],
    ...(options.commands ? { commands: structuredClone(options.commands) } : {}),
    memory,
  };
  const configContent = stableJson(config);
  if (!force && await exists(join(root, CONFIG_PATH))) {
    if (await readFile(join(root, CONFIG_PATH), "utf8") !== configContent) throw new Error(`Refusing to overwrite ${CONFIG_PATH}; use --force`);
  } else {
    await writeAtomic(join(root, CONFIG_PATH), configContent);
  }
  await writeStatus(root, undefined);
  await installHooks(git);

  let existingAdapters: ManagedManifest["adapters"];
  try {
    existingAdapters = (JSON.parse(await readFile(join(root, MANIFEST_PATH), "utf8")) as ManagedManifest).adapters;
  } catch {
    // A first or interrupted bootstrap may not have a manifest yet.
  }
  const manifest: ManagedManifest = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    generatedAt: new Date().toISOString(),
    managedFiles,
    ...(existingAdapters ? { adapters: existingAdapters } : {}),
  };
  await writeAtomic(join(root, MANIFEST_PATH), stableJson(manifest));

  // Bootstrap is intentionally not a silent assertion that memory is current.
  // It always leaves a review-required discovery, even for an empty repository.
  await requestDiscovery(root);

  if (options.adapters ?? true) {
    await installAllAdapters(root, force);
    return JSON.parse(await readFile(join(root, MANIFEST_PATH), "utf8")) as ManagedManifest;
  }
  return manifest;
}

export const BOOTSTRAP_PATHS = { CONFIG_PATH, MANIFEST_PATH, STATE_PATH, WAYS_DIR };
