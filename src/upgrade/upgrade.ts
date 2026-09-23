import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { installAdapter } from "../adapters/install.js";
import { assetPath, installHooks, MANAGED_ASSETS } from "../bootstrap/bootstrap.js";
import { GitRepository } from "../git/git.js";
import { loadConfig } from "../config/config.js";
import { MANIFEST_PATH } from "../domain/constants.js";
import type { ManagedManifest } from "../domain/types.js";
import { HARNESS_VERSION } from "../index.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import { validateManifest } from "../domain/validation.js";
import { diagnose } from "../repair/repair.js";
import { runMigrations } from "./migrations.js";

export interface UpgradePlan {
  from: string;
  to: string;
  modifiedManagedFiles: string[];
  /** Compatibility notes about the active work; upgrade never rewrites its state or history. */
  activeWork: string[];
  /** Active state the upgrade cannot safely proceed over; apply refuses while non-empty. */
  incompatible: string[];
}

async function manifest(cwd: string): Promise<ManagedManifest> {
  const value: unknown = JSON.parse(await readFile(join(cwd, MANIFEST_PATH), "utf8"));
  if (!validateManifest(value)) throw new Error("Installed manifest is invalid");
  return value;
}

/**
 * Upgrade never migrates work in flight: an active legacy SDD work completes
 * under its original workflow and assurance policies, and its certifications,
 * approvals and remediation records are left untouched. Divergent or unreadable
 * state is reported instead of being repaired implicitly.
 */
async function diagnoseActiveWork(cwd: string): Promise<Pick<UpgradePlan, "activeWork" | "incompatible">> {
  let result;
  try {
    result = await diagnose(cwd);
  } catch (error) {
    return { activeWork: [], incompatible: [`Active state is unreadable: ${error instanceof Error ? error.message : String(error)}; run ways repair diagnose`] };
  }
  const state = result.state;
  if (!state) return { activeWork: [], incompatible: [] };
  if (!result.consistent) return { activeWork: [], incompatible: [`Active ${state.mode} work ${state.id} diverges from Git: ${result.message}; run ways repair diagnose`] };
  if (state.mode === "sdd") {
    return {
      activeWork: [`Active SDD work ${state.id} (workflow v${state.workflowVersion ?? 1}, phase ${state.phase}) continues under its original SDD workflow and assurance policies; SDD is deprecated, so open new work with ways outcome open.`],
      incompatible: [],
    };
  }
  return { activeWork: [`Active ${state.mode} work ${state.id} is compatible and continues unchanged.`], incompatible: [] };
}

export async function planUpgrade(cwd: string): Promise<UpgradePlan> {
  const installed = await manifest(cwd);
  const modified: string[] = [];
  const tracked = Object.entries(installed.managedFiles);
  for (const files of Object.values(installed.adapters ?? {})) tracked.push(...Object.entries(files));
  for (const [path, expected] of tracked) {
    try {
      if (sha256(await readFile(join(cwd, path))) !== expected) modified.push(path);
    } catch {
      modified.push(path);
    }
  }
  return { from: installed.harnessVersion, to: HARNESS_VERSION, modifiedManagedFiles: modified.sort(), ...await diagnoseActiveWork(cwd) };
}

export async function applyUpgrade(cwd: string, overwrite: Set<string>): Promise<UpgradePlan> {
  const plan = await planUpgrade(cwd);
  if (plan.incompatible.length > 0) throw new Error(`Upgrade refused over incompatible active state:\n${plan.incompatible.map((issue) => `- ${issue}`).join("\n")}`);
  const refused = plan.modifiedManagedFiles.filter((path) => !overwrite.has(path) && !overwrite.has("*"));
  if (refused.length > 0) throw new Error(`Modified managed files require overwrite approval:\n${refused.map((path) => `- [ ] ${path}`).join("\n")}`);

  const config = await loadConfig(cwd);
  if (config.harnessVersion !== HARNESS_VERSION) await runMigrations({ cwd, config }, HARNESS_VERSION);
  config.harnessVersion = HARNESS_VERSION;
  await writeAtomic(join(cwd, ".ways/config.json"), stableJson(config));

  const managedFiles: Record<string, string> = {};
  for (const [target, asset, mode] of MANAGED_ASSETS) {
    const content = await readFile(assetPath(asset));
    await writeAtomic(join(cwd, target), content.toString("utf8"), mode);
    if (mode !== undefined) await chmod(join(cwd, target), mode);
    managedFiles[target] = sha256(content);
  }
  const installed = await manifest(cwd);
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
  for (const provider of Object.keys(installed.adapters ?? {})) await installAdapter(cwd, provider, true);
  await installHooks(new GitRepository(cwd));
  return plan;
}
