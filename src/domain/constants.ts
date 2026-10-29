export const WAYS_DIR = ".ways";
export const CONFIG_PATH = `${WAYS_DIR}/config.json`;
export const MANIFEST_PATH = `${WAYS_DIR}/manifest.json`;
export const KNOWLEDGE_DIR = `${WAYS_DIR}/knowledge`;
/** Committed work records, one JSON file per outcome (and per change that needed an approval). */
export const WORK_DIR = `${WAYS_DIR}/work`;
export const HOOKS_DIR = `${WAYS_DIR}/hooks`;
/** The wiki for humans (Markdown, no generator). It is not part of the agents' memory: nothing in `.ways/knowledge` or the hooks reads it. */
export const WIKI_DIR = "docs/wiki";
export const WIKI_CONFIG_PATH = `${WAYS_DIR}/wiki.json`;
/** The role `ways wiki update` gives the agent it launches (environment `WAYS_ROLE`, trailer `Harness-Role`). */
export const DOCUMENTALIST_ROLE = "documentalist";

/** True for `docs/wiki` and everything under it. */
export function isWikiPath(path: string): boolean {
  return path === WIKI_DIR || path.startsWith(`${WIKI_DIR}/`);
}
/** The coding-agent hook wrapper: `agent-hook <agent> <event>` runs `ways hook <event> --agent=<agent>`. */
export const AGENT_HOOK_PATH = `${HOOKS_DIR}/agent-hook`;

/** Existing files here count as the verifier surface unless the config overrides it. */
export const DEFAULT_VERIFIER_PATHS: readonly string[] = [
  "test/**",
  "tests/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test_*.py",
  "**/*_test.go",
  ".ways/config.json",
  ".ways/allowed_signers",
  "package.json",
  ".github/workflows/**",
  "vitest.config.*",
  "**/conftest.py",
  "jest.config.*",
  "playwright.config.*",
];

const WORK_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isWorkId(value: string): boolean {
  return WORK_ID.test(value);
}

export function assertWorkId(value: string): void {
  if (!isWorkId(value)) throw new Error(`Work id must be a 2-63 character lowercase slug (a-z, 0-9, -), got "${value}"`);
}

export function workRecordPath(id: string): string {
  assertWorkId(id);
  return `${WORK_DIR}/${id}.json`;
}

/** Turns a branch name or commit subject into a work id, or undefined when nothing usable is left. */
export function slugify(value: string): string | undefined {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
  return isWorkId(slug) ? slug : undefined;
}
