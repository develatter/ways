import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, ONBOARDING_PATH } from "../domain/constants.js";
import type { OnboardingPolicy } from "../domain/types.js";
import { writeFileAtomic } from "../runtime/runtime.js";

/**
 * `.ways/onboarding.json`: whether this repository had its first-session
 * onboarding, committed so a fresh clone does not ask again. `bootstrap`
 * writes `pending`; `ways onboard` writes `done` with what it generated and
 * what is left unverified. The hooks read it on every session start, so it
 * is read without ajv or yaml.
 */
export interface OnboardingSummary {
  /** The agent that wrote the notes and facts, or `none` when only the deterministic part ran. */
  agent: string;
  mapNotes: number;
  facts: string[];
  unverified: string[];
  checks: string[];
  rejected: Array<{ check: string; command: string[]; reason: string }>;
  /** What could not be done, in words: no agent, a rejected fact... */
  missing: string[];
  /** Additions proposed for AGENTS.md, moved there as one marked block. */
  agentsProposal: boolean;
}

export interface OnboardingState {
  schemaVersion: 1;
  status: "pending" | "done";
  /** When bootstrap left it pending, or onboarding finished. */
  at: string;
  /** Present when done. */
  summary?: OnboardingSummary;
}

export function readOnboarding(top: string): OnboardingState | undefined {
  try {
    const value = JSON.parse(readFileSync(join(top, ONBOARDING_PATH), "utf8")) as Partial<OnboardingState>;
    if (value.status === "pending" || value.status === "done") return { schemaVersion: 1, status: value.status, at: typeof value.at === "string" ? value.at : "", ...(value.summary ? { summary: value.summary } : {}) };
  } catch {
    // Not bootstrapped by this version, or unreadable: nothing to say.
  }
  return undefined;
}

export function writeOnboarding(top: string, state: OnboardingState): void {
  writeFileAtomic(join(top, ONBOARDING_PATH), `${JSON.stringify(state, null, 2)}\n`);
}

export function pendingOnboarding(): OnboardingState {
  return { schemaVersion: 1, status: "pending", at: new Date().toISOString() };
}

/** The policy from the config, without validating it (hook path). */
export function onboardingPolicy(top: string): OnboardingPolicy {
  try {
    const value = (JSON.parse(readFileSync(join(top, CONFIG_PATH), "utf8")) as { onboarding?: unknown }).onboarding;
    return value === "auto" || value === "off" ? value : "ask";
  } catch {
    return "ask";
  }
}
