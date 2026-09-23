import { CONFIG_PATH } from "../domain/constants.js";
import type { CheckContract, HarnessConfig } from "../domain/types.js";
import { validateConfig } from "../domain/validation.js";
import { stableJson } from "../fs/files.js";
import type { GitRepository } from "../git/git.js";

/**
 * The command contract an execution boundary runs: the legacy test command
 * plus the optional named checks. SDD failure records and outcome evaluations
 * both bind to it, so a changed configuration invalidates what they certified.
 */
export function effectiveContract(config: HarnessConfig): CheckContract {
  return { testCommand: [...config.testCommand], ...(config.commands ? { commands: structuredClone(config.commands) } : {}) };
}

export function sameContract(left: CheckContract, right: CheckContract): boolean {
  return stableJson({ testCommand: left.testCommand, commands: left.commands ?? null })
    === stableJson({ testCommand: right.testCommand, commands: right.commands ?? null });
}

/** The contract configured in a committed tree, or undefined when its configuration is unreadable. */
export async function committedContract(git: GitRepository, ref: string): Promise<CheckContract | undefined> {
  try {
    const config: unknown = JSON.parse(await git.run(["show", `${ref}:${CONFIG_PATH}`]));
    return validateConfig(config) ? effectiveContract(config) : undefined;
  } catch {
    return undefined;
  }
}
