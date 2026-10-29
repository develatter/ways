import { chmod, lstat, readFile, readlink, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_VERSION } from "../version.js";
import { AGENT_HOOK_PATH, CHECKS_PATH, CONFIG_PATH, HOOKS_DIR, KNOWLEDGE_DIR, MANIFEST_PATH, MAP_PATH, ONBOARDING_PATH } from "../domain/constants.js";
import { CHECK_NAMES, type CheckName, type HarnessConfig, type ManagedManifest, type NamedChecksConfig } from "../domain/types.js";
import { detectProject, type Detection } from "../map/detect.js";
import { mapFiles, readMarker, writeMap } from "../map/map.js";
import { pendingOnboarding, readOnboarding, writeOnboarding } from "../onboard/state.js";
import { readChecksFile, sameCommand, writeChecksFile, type CheckEntry } from "../run/checks-file.js";
import { detectedCandidates, entryOf, validateCandidates, type Validation } from "../run/validate.js";
import { gitDirs } from "../runtime/runtime.js";
import { renderAgentsMd } from "./agents-md.js";
import { validateConfig, validationDetails } from "../domain/validation.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { installAdapter, providerById } from "../adapters/install.js";
import { CLAUDE_MD_CONTENT, CLAUDE_MD_PATH, withAgentsImport } from "./claude-md.js";

/** First-class agents, installed unless `--agents` says otherwise; codex and cursor are opt-in. */
export const DEFAULT_AGENTS = ["claude", "pi"] as const;

export interface BootstrapOptions {
  cwd: string;
  /** The test command the human chose; without it (and without `commands`) ways detects the checks and validates them by running them. */
  testCommand?: string[];
  commands?: NamedChecksConfig;
  force?: boolean;
  /** Adapters to install; defaults to Claude Code and pi. An empty list installs none. */
  agents?: readonly string[];
  /** Progress while detected checks run, for the human. */
  onProgress?: (line: string) => void;
}

export interface BootstrapResult {
  manifest: ManagedManifest;
  /** Every file bootstrap wrote or merged, repository-relative. */
  files: string[];
  /** What the human should fix for the installation to work in CI, each with the command. */
  warnings: string[];
  /** Detected checks ways ran: what it kept and what it rejected. Empty when the human gave the commands. */
  validation: Validation;
}

/** When nothing that runs was found: a test check that says how to configure one, so `ways done` cannot pass on nothing. */
export const NO_TEST_COMMAND = ["sh", "-c", "echo 'ways: no test command is configured; add one with: ways check add test -- <command>' >&2; exit 1"];

/**
 * The checks of a new installation. Given by the human: taken as they are.
 * Otherwise detected from manifests and CI and run once each: the first
 * candidate per check that works is kept with its line base, the rest are
 * reported. An existing config is kept (a second bootstrap re-detects nothing).
 */
async function chooseChecks(root: string, options: BootstrapOptions, detection: Detection): Promise<{ testCommand: string[]; commands?: NamedChecksConfig; validation: Validation; entries: Partial<Record<CheckName, CheckEntry>>; existing?: HarnessConfig }> {
  const none: Validation = { accepted: [], rejected: [] };
  if (options.testCommand || options.commands) {
    const testCommand = options.testCommand ?? options.commands?.test ?? NO_TEST_COMMAND;
    const entries: Partial<Record<CheckName, CheckEntry>> = {};
    const given = options.commands ?? { required: ["test"], test: testCommand };
    for (const name of CHECK_NAMES) if (given[name]) entries[name] = { command: [...given[name]!], source: "ways bootstrap (given)" };
    return { testCommand: [...testCommand], ...(options.commands ? { commands: structuredClone(options.commands) } : {}), validation: none, entries };
  }
  if (!options.force && await exists(join(root, CONFIG_PATH))) {
    const existing = JSON.parse(await readFile(join(root, CONFIG_PATH), "utf8")) as HarnessConfig;
    return { testCommand: existing.testCommand, ...(existing.commands ? { commands: existing.commands } : {}), validation: none, entries: readChecksFile(root).checks, existing };
  }
  const dirs = gitDirs(root);
  const validation = await validateCandidates(dirs, detectedCandidates(detection.candidates), { onRun: (candidate) => options.onProgress?.(`  running ${candidate.name}: ${candidate.command.join(" ")}`) });
  const entries: Partial<Record<CheckName, CheckEntry>> = {};
  for (const accepted of validation.accepted) entries[accepted.name] = entryOf(accepted);
  const test = validation.accepted.find((entry) => entry.name === "test")?.command;
  const testCommand = test ?? NO_TEST_COMMAND;
  const names = validation.accepted.map((entry) => entry.name);
  if (names.length === 0 || (names.length === 1 && test)) return { testCommand, validation, entries };
  // The named checks decide what runs; `testCommand` is only the fallback the schema keeps.
  const commands: NamedChecksConfig = { required: CHECK_NAMES.filter((name) => names.includes(name)) };
  for (const entry of validation.accepted) commands[entry.name] = [...entry.command];
  return { testCommand, commands, validation, entries };
}

export const INSTALL_COMMAND = "npm install --save-dev @develatter/ways --registry=https://npm.pkg.github.com";

/** The CI job runs `npx --no-install ways`, which needs ways in the repository's own dev dependencies. */
async function dependencyWarnings(root: string): Promise<string[]> {
  let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return [`There is no readable package.json, so the CI job (.github/workflows/ways.yml runs \`npx --no-install ways verify\`) cannot find ways. Run \`npm init -y && ${INSTALL_COMMAND}\` and commit package.json and the lockfile.`];
  }
  if (manifest.devDependencies?.["@develatter/ways"] !== undefined || manifest.dependencies?.["@develatter/ways"] !== undefined) return [];
  return [`package.json does not list @develatter/ways, so the CI job (.github/workflows/ways.yml runs \`npx --no-install ways verify\`) will fail. Run \`${INSTALL_COMMAND}\` and commit package.json and the lockfile.`];
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
  [`${KNOWLEDGE_DIR}/index.md`, "knowledge-index.md"],
  // The CI job that judges every pull request with `ways verify`.
  [".github/workflows/ways.yml", "ways.yml"],
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
  if (options.testCommand !== undefined && (!Array.isArray(options.testCommand) || options.testCommand.length === 0 || options.testCommand.some((part) => typeof part !== "string" || !part))) {
    throw new Error("The test command must be a non-empty JSON array of words, e.g. --test-command='[\"npm\",\"test\"]' (or leave it out: ways detects the checks and runs each once)");
  }
  const agents = [...new Set(options.agents ?? DEFAULT_AGENTS)];
  for (const agent of agents) providerById(agent);
  const force = options.force ?? false;
  const detection = detectProject(root, await mapFiles(root));
  const chosen = await chooseChecks(root, options, detection);
  const config: HarnessConfig = chosen.existing ?? {
    schemaVersion: 2,
    harnessVersion: HARNESS_VERSION,
    enforcement: "observe",
    testCommand: [...chosen.testCommand],
    ...(chosen.commands ? { commands: structuredClone(chosen.commands) } : {}),
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

  // The three layers' deterministic part: what ways observed of the checks, AGENTS.md, MAP.md; the rest waits for `ways onboard`.
  const checksFile = readChecksFile(root);
  const before = JSON.stringify(checksFile.checks);
  for (const [name, entry] of Object.entries(chosen.entries) as Array<[CheckName, CheckEntry]>) {
    if (!checksFile.checks[name] || !sameCommand(checksFile.checks[name]!.command, entry.command)) checksFile.checks[name] = entry;
  }
  if (!await exists(join(root, CHECKS_PATH)) || JSON.stringify(checksFile.checks) !== before) {
    writeChecksFile(root, checksFile);
    written.push(CHECKS_PATH);
  }
  if (!await exists(join(root, "AGENTS.md"))) {
    const checks: Partial<Record<CheckName, string[]>> = {};
    for (const name of CHECK_NAMES) {
      const command = config.commands ? config.commands[name] : name === "test" ? config.testCommand : undefined;
      if (command && (config.commands?.required.includes(name) ?? true) && !sameCommand(command, NO_TEST_COMMAND)) checks[name] = command;
    }
    await writeAtomic(join(root, "AGENTS.md"), renderAgentsMd({ detection, checks }));
    written.push("AGENTS.md");
  }
  if (!readOnboarding(root)) {
    writeOnboarding(root, pendingOnboarding());
    written.push(ONBOARDING_PATH);
  }
  const map = join(root, MAP_PATH);
  // A MAP.md the project wrote itself (no ways marker) is left alone.
  if (!await exists(map) || readMarker(await readFile(map, "utf8"))) {
    await writeMap(root);
    written.push(MAP_PATH);
  }
  const final = JSON.parse(await readFile(join(root, MANIFEST_PATH), "utf8")) as ManagedManifest;
  return { manifest: final, files: [...new Set(written)].sort(), warnings: await dependencyWarnings(root), validation: chosen.validation };
}
