import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHECKS_PATH, CONFIG_PATH, MAP_NOTES_PATH, MAP_PATH } from "../domain/constants.js";
import { onboardingPolicy, readOnboarding } from "../onboard/state.js";
import { fastHash } from "../runtime/lazy.js";
import { headCommitOf, writeFileAtomic, type GitDirs } from "../runtime/runtime.js";
import { contextCachePath } from "./memory.js";

/**
 * Two facts about the repository's layers for the brief: onboarding is still
 * pending (with what it would cost), and MAP.md drifted from the repository.
 * Both are said, never enforced. The drift check needs `git ls-files` and the
 * detection, so it runs once per HEAD, index and map-file change and is
 * cached in the runtime directory.
 */
export const NOTICE_MAX_CHARS = 600;

interface MapState {
  key: string;
  files: number;
  drift: string[];
}

function stamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "-";
  }
}

/** Number of files and MAP.md's drift, cached by everything they depend on. */
export async function mapState(dirs: GitDirs): Promise<MapState> {
  const key = fastHash([headCommitOf(dirs) ?? "", stamp(join(dirs.gitDir, "index")), stamp(join(dirs.top, MAP_PATH)), stamp(join(dirs.top, MAP_NOTES_PATH)), stamp(join(dirs.top, CHECKS_PATH))].join("\n"));
  const path = contextCachePath(dirs, "map");
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as MapState;
    if (cached.key === key) return cached;
  } catch {
    // No cache yet.
  }
  const { mapDrift, mapFacts, mapFiles } = await import("../map/map.js");
  let state: MapState;
  try {
    const files = await mapFiles(dirs.top);
    let current: string | undefined;
    try {
      current = readFileSync(join(dirs.top, MAP_PATH), "utf8");
    } catch {
      current = undefined;
    }
    // A repository without MAP.md (installed before it existed, or a hand-written one) is not nagged about it.
    const drift = current === undefined ? { reasons: [] } : mapDrift(current, await mapFacts(dirs.top));
    state = { key, files: files.length, drift: drift.reasons };
  } catch {
    state = { key, files: 0, drift: [] };
  }
  try {
    writeFileAtomic(path, JSON.stringify(state));
  } catch {
    // The cache is an optimisation.
  }
  return state;
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code (`claude -p`)", pi: "pi (`pi -p`)" };

function onboarderModel(top: string): string | undefined {
  try {
    const model = (JSON.parse(readFileSync(join(top, CONFIG_PATH), "utf8")) as { onboarder?: { model?: unknown } }).onboarder?.model;
    return typeof model === "string" ? model : undefined;
  } catch {
    return undefined;
  }
}

/** The first-session notice, or nothing when onboarding is done, off, or this repository predates it. */
export function onboardingNotice(top: string, files: number, agent?: string): string | undefined {
  const state = readOnboarding(top);
  if (state?.status !== "pending") return undefined;
  const policy = onboardingPolicy(top);
  if (policy === "off") return undefined;
  const model = onboarderModel(top);
  const who = `${(agent && AGENT_NAMES[agent]) ?? "your coding agent"}${model ? ` with model ${model}` : ""}`;
  const what = `Onboarding: not done yet. \`ways onboard\` adds folder purposes to MAP.md, 8-15 short facts with their sources to .ways/knowledge (unverified until a person confirms them) and checks validated by running them. It starts ${who}, which may read the ${files} files and the history; it spends the human's agent quota and takes a few minutes.`;
  const how = policy === "auto"
    ? " Policy auto: run `npx ways onboard` now."
    : " Ask the human first (`npx ways ask \"Run ways onboard now?\" --options=yes,no`); if yes, run `npx ways onboard --yes`.";
  const text = `${what}${how}`;
  return text.length > NOTICE_MAX_CHARS ? `${text.slice(0, NOTICE_MAX_CHARS - 1)}…` : text;
}

export function mapNotice(drift: readonly string[]): string | undefined {
  return drift.length > 0 ? `MAP.md is out of date (${drift.join("; ")}): run \`npx ways map\` and commit it.` : undefined;
}
