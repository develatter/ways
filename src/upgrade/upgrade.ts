import { chmod, lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { installAdapter, renderProvider, providerById } from "../adapters/install.js";
import { assetPath, installHooks, MANAGED_ASSETS, SEEDED_ASSETS } from "../bootstrap/bootstrap.js";
import { CONFIG_PATH, MANIFEST_PATH } from "../domain/constants.js";
import type { ManagedManifest } from "../domain/types.js";
import { validateManifest } from "../domain/validation.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { compareVersions, HARNESS_VERSION } from "../version.js";
import { migrateConfig, migrateFromLegacy, writeConfig } from "./migrations.js";

export interface UpgradePlan {
  from: string;
  to: string;
  /** Files ways will rewrite that differ from what it installed; each needs `--overwrite=<path>`. */
  modifiedManagedFiles: string[];
  notes: string[];
}

async function manifest(cwd: string): Promise<ManagedManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(cwd, MANIFEST_PATH), "utf8"));
  } catch {
    throw new Error(`${MANIFEST_PATH} is missing; this repository has no ways installation to upgrade. Run \`ways bootstrap\``);
  }
  if (!validateManifest(value)) throw new Error(`${MANIFEST_PATH} is invalid; restore it from Git or rerun \`ways bootstrap --force\``);
  return value;
}

async function hashOf(cwd: string, path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(join(cwd, path)));
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every path ways will own after the upgrade: managed assets plus the re-rendered adapters. */
async function nextOwned(installed: ManagedManifest): Promise<Set<string>> {
  const owned = new Set(MANAGED_ASSETS.map(([target]) => target));
  for (const provider of Object.keys(installed.adapters ?? {})) {
    for (const file of await renderProvider(providerById(provider))) owned.add(file.path);
  }
  return owned;
}

export async function planUpgrade(cwd: string): Promise<UpgradePlan> {
  const installed = await manifest(cwd);
  if (compareVersions(installed.harnessVersion, HARNESS_VERSION) > 0) {
    throw new Error(`This repository was installed by ways ${installed.harnessVersion}, newer than ${HARNESS_VERSION}; upgrade the package instead`);
  }
  const owned = await nextOwned(installed);
  const tracked: Array<[string, string]> = Object.entries(installed.managedFiles);
  for (const files of Object.values(installed.adapters ?? {})) tracked.push(...Object.entries(files));
  const modified: string[] = [];
  const notes: string[] = [];
  for (const [path, expected] of tracked) {
    const actual = await hashOf(cwd, path);
    if (actual === undefined || actual === expected) continue;
    if (owned.has(path)) modified.push(path);
    else notes.push(`${path} is no longer managed by ways and you edited it, so it is kept as is${path === "AGENTS.md" ? "; replace its ways bullets with the short \"Working with ways\" section of the new template (see the README)" : ""}.`);
  }
  const config = await readFile(join(cwd, CONFIG_PATH), "utf8").then((text) => JSON.parse(text) as { schemaVersion?: number }).catch(() => undefined);
  if (config?.schemaVersion === 1) notes.push("Moves the 0.2 model (SDD, plan, quick, tasks, attempts, discovery) to start/done and outcomes with verifiable criteria; see docs/decisions/0003-what-stays-and-what-goes.md.");
  return { from: installed.harnessVersion, to: HARNESS_VERSION, modifiedManagedFiles: modified.sort(), notes };
}

export async function applyUpgrade(cwd: string, overwrite: Set<string>): Promise<UpgradePlan> {
  const plan = await planUpgrade(cwd);
  const refused = plan.modifiedManagedFiles.filter((path) => !overwrite.has(path) && !overwrite.has("*"));
  if (refused.length > 0) {
    throw new Error(`These files differ from what ways installed and would be overwritten:\n${refused.map((path) => `- ${path}`).join("\n")}\nKeep a copy of your edits, then rerun with ${refused.map((path) => `--overwrite=${path}`).join(" ")} (or --overwrite-all).`);
  }
  const installed = await manifest(cwd);
  const notes = [...plan.notes];

  const migrated = migrateConfig(JSON.parse(await readFile(join(cwd, CONFIG_PATH), "utf8")), HARNESS_VERSION);
  await writeConfig(cwd, migrated.config);
  notes.push(...migrated.notes);
  notes.push(...(await migrateFromLegacy(cwd)).notes);

  // Files 0.2 managed that ways no longer owns: removed when untouched, kept when edited.
  const owned = await nextOwned(installed);
  for (const [path, expected] of Object.entries(installed.managedFiles)) {
    if (owned.has(path)) continue;
    if (await hashOf(cwd, path) !== expected) continue;
    const seeded = SEEDED_ASSETS.find(([target]) => target === path);
    if (seeded) {
      // An untouched 0.2 AGENTS.md is the old harness manual: it becomes the new project map template.
      await writeAtomic(join(cwd, path), await readFile(assetPath(seeded[1]), "utf8"));
      notes.push(`${path} replaced with the new template (it was untouched); describe your project in it.`);
    } else {
      await rm(join(cwd, path), { force: true });
      notes.push(`Removed ${path}, which ways no longer installs.`);
    }
  }
  for (const [target, asset] of SEEDED_ASSETS) {
    if (!await exists(join(cwd, target))) await writeAtomic(join(cwd, target), await readFile(assetPath(asset), "utf8"));
  }

  const managedFiles: Record<string, string> = {};
  for (const [target, asset, mode] of MANAGED_ASSETS) {
    const content = await readFile(assetPath(asset));
    await writeAtomic(join(cwd, target), content.toString("utf8"), mode);
    if (mode !== undefined) await chmod(join(cwd, target), mode);
    managedFiles[target] = sha256(content);
  }
  const unchanged = installed.harnessVersion === HARNESS_VERSION && stableJson(installed.managedFiles) === stableJson(managedFiles);
  const next: ManagedManifest = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    // Re-applying an upgrade that changes nothing must not churn the manifest.
    generatedAt: unchanged ? installed.generatedAt : new Date().toISOString(),
    managedFiles,
    ...(installed.adapters ? { adapters: installed.adapters } : {}),
  };
  await writeAtomic(join(cwd, MANIFEST_PATH), stableJson(next));
  for (const provider of Object.keys(installed.adapters ?? {})) {
    const result = await installAdapter(cwd, provider, true);
    notes.push(...result.notes.map((note) => `${provider}: ${note}`));
  }
  await installHooks(new GitRepository(cwd));
  return { ...plan, notes };
}
