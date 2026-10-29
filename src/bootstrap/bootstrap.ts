import { chmod, lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_VERSION } from "../version.js";
import { AGENT_HOOK_PATH, CONFIG_PATH, HOOKS_DIR, KNOWLEDGE_DIR, MANIFEST_PATH } from "../domain/constants.js";
import type { HarnessConfig, ManagedManifest, NamedChecksConfig } from "../domain/types.js";
import { validateConfig, validationDetails } from "../domain/validation.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { installAdapter, providerById } from "../adapters/install.js";
import { CLAUDE_MD_CONTENT, CLAUDE_MD_PATH, withAgentsImport } from "./claude-md.js";

/** First-class agents, installed unless `--agents` says otherwise; codex and cursor are opt-in. */
export const DEFAULT_AGENTS = ["claude", "pi"] as const;

export interface BootstrapOptions {
  cwd: string;
  testCommand: string[];
  commands?: NamedChecksConfig;
  force?: boolean;
  /** Adapters to install; defaults to Claude Code and pi. An empty list installs none. */
  agents?: readonly string[];
}

export interface BootstrapResult {
  manifest: ManagedManifest;
  /** Every file bootstrap wrote or merged, repository-relative. */
  files: string[];
}

/** Files ways owns and hashes: integrity reports any edit, `ways upgrade` re-renders them. */
export const MANAGED_ASSETS: Array<[string, string, number?]> = [
  ["scripts/check.sh", "check.sh", 0o755],
  [`${HOOKS_DIR}/prepare-commit-msg`, "prepare-commit-msg", 0o755],
  [`${HOOKS_DIR}/commit-msg`, "commit-msg", 0o755],
  [AGENT_HOOK_PATH, "agent-hook", 0o755],
];

/** Files ways writes once when missing and then leaves to the project. */
export const SEEDED_ASSETS: Array<[string, string]> = [
  ["AGENTS.md", "AGENTS.md"],
  [`${KNOWLEDGE_DIR}/index.md`, "knowledge-index.md"],
];

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

async function installManaged(root: string, target: string, asset: string, force: boolean, mode?: number): Promise<string> {
  const targetPath = join(root, target);
  const content = await readFile(assetPath(asset));
  if (!force && await exists(targetPath)) {
    const current = await readFile(targetPath);
    if (!current.equals(content)) throw new Error(`Refusing to overwrite ${target}, which ways manages; move your changes elsewhere or rerun with --force`);
  } else {
    await writeAtomic(targetPath, content.toString("utf8"), mode);
  }
  if (mode !== undefined) await chmod(targetPath, mode);
  return sha256(content);
}

export async function installHooks(git: GitRepository): Promise<void> {
  await git.run(["config", "core.hooksPath", HOOKS_DIR]);
}

async function seedClaudeMd(root: string, force: boolean): Promise<boolean> {
  const claudePath = join(root, CLAUDE_MD_PATH);
  if (!await exists(claudePath)) {
    await writeAtomic(claudePath, CLAUDE_MD_CONTENT);
    return true;
  }
  if ((await lstat(claudePath)).isSymbolicLink()) {
    // A symlink from an earlier bootstrap keeps working; only a foreign target is replaced, and only with --force.
    if (await readlink(claudePath) === "AGENTS.md") return false;
    if (!force) throw new Error("CLAUDE.md is a symlink to something other than AGENTS.md; rerun with --force to replace it, or point it at AGENTS.md");
    await rm(claudePath, { force: true });
    await writeAtomic(claudePath, CLAUDE_MD_CONTENT);
    return true;
  }
  // The user's own notes stay; ways only adds the import line.
  const current = await readFile(claudePath, "utf8");
  const next = withAgentsImport(current);
  if (next === current) return false;
  await writeAtomic(claudePath, next);
  return true;
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const root = await realpath(resolve(options.cwd));
  const git = new GitRepository(root);
  if (await realpath(await git.root()) !== root) throw new Error("Bootstrap must run at the Git repository root");
  if (!Array.isArray(options.testCommand) || options.testCommand.length === 0 || options.testCommand.some((part) => typeof part !== "string" || !part)) {
    throw new Error("A non-empty test command is required, e.g. --test-command='[\"npm\",\"test\"]'");
  }
  const agents = [...new Set(options.agents ?? DEFAULT_AGENTS)];
  for (const agent of agents) providerById(agent);
  const force = options.force ?? false;
  const config: HarnessConfig = {
    schemaVersion: 2,
    harnessVersion: HARNESS_VERSION,
    enforcement: "observe",
    testCommand: [...options.testCommand],
    ...(options.commands ? { commands: structuredClone(options.commands) } : {}),
  };
  if (!validateConfig(config)) throw new Error(`Invalid checks configuration: ${validationDetails("config", config).errors.join("; ")}`);

  const written: string[] = [];
  const managedFiles: Record<string, string> = {};
  for (const [target, asset, mode] of MANAGED_ASSETS) {
    managedFiles[target] = await installManaged(root, target, asset, force, mode);
    written.push(target);
  }
  for (const [target, asset] of SEEDED_ASSETS) {
    if (await exists(join(root, target))) continue;
    await writeAtomic(join(root, target), await readFile(assetPath(asset), "utf8"));
    written.push(target);
  }
  if (agents.includes("claude") && await seedClaudeMd(root, force)) written.push(CLAUDE_MD_PATH);

  const configContent = stableJson(config);
  if (!force && await exists(join(root, CONFIG_PATH))) {
    if (await readFile(join(root, CONFIG_PATH), "utf8") !== configContent) throw new Error(`Refusing to overwrite ${CONFIG_PATH}; edit it, or rerun with --force. A repository installed with ways 0.2 is moved with \`ways upgrade --apply\``);
  } else {
    await writeAtomic(join(root, CONFIG_PATH), configContent);
    written.push(CONFIG_PATH);
  }
  await installHooks(git);

  let existingAdapters: ManagedManifest["adapters"];
  try {
    existingAdapters = (JSON.parse(await readFile(join(root, MANIFEST_PATH), "utf8")) as ManagedManifest).adapters;
  } catch {
    // A first or interrupted bootstrap has no manifest yet.
  }
  const manifest: ManagedManifest = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    generatedAt: new Date().toISOString(),
    managedFiles,
    ...(existingAdapters ? { adapters: existingAdapters } : {}),
  };
  await writeAtomic(join(root, MANIFEST_PATH), stableJson(manifest));
  written.push(MANIFEST_PATH);

  for (const agent of agents) {
    const result = await installAdapter(root, agent, force);
    written.push(...result.files, ...result.merged);
  }
  const final = JSON.parse(await readFile(join(root, MANIFEST_PATH), "utf8")) as ManagedManifest;
  return { manifest: final, files: [...new Set(written)].sort() };
}
