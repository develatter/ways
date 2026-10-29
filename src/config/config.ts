import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_PATH, DEFAULT_VERIFIER_PATHS } from "../domain/constants.js";
import type { Enforcement, HarnessConfig, ReviewPolicy } from "../domain/types.js";
import { validateConfig, validationDetails } from "../domain/validation.js";
import { normalizeGlob } from "../memory/glob.js";

export async function loadConfig(cwd: string): Promise<HarnessConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(cwd, CONFIG_PATH), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${CONFIG_PATH} is missing; run \`ways bootstrap\` first`);
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === 1) {
    throw new Error(`${CONFIG_PATH} was written by ways 0.2; run \`ways upgrade --apply\` to move it to this version`);
  }
  if (!validateConfig(value)) throw new Error(`Invalid ${CONFIG_PATH}: ${validationDetails("config", value).errors.join("; ")}`);
  for (const pattern of value.verifierPaths ?? []) normalizeGlob(pattern);
  for (const marker of value.testMarkers ?? []) {
    try {
      new RegExp(marker);
    } catch (error) {
      throw new Error(`Invalid ${CONFIG_PATH}: testMarkers has "${marker}", which is not a regular expression (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return value;
}

export function enforcementOf(config: Pick<HarnessConfig, "enforcement">): Enforcement {
  return config.enforcement ?? "observe";
}

export function defaultReview(config: Pick<HarnessConfig, "review">): ReviewPolicy {
  return config.review ?? "required";
}

export function verifierPaths(config: Pick<HarnessConfig, "verifierPaths">): readonly string[] {
  return config.verifierPaths ?? DEFAULT_VERIFIER_PATHS;
}
