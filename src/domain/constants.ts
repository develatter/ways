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

/** The project map `ways map` generates, and the purpose notes it merges in. */
export const MAP_PATH = "MAP.md";
export const MAP_NOTES_PATH = `${WAYS_DIR}/map-notes.json`;
/** Whether the first session's onboarding ran: `pending` after bootstrap, `done` after `ways onboard`. */
export const ONBOARDING_PATH = `${WAYS_DIR}/onboarding.json`;
/** The project's own eval corpus (`ways evals init`), its candidates and, ignored by Git, its results. */
export const EVALS_DIR = `${WAYS_DIR}/evals`;
export const PROJECT_CORPUS_PATH = `${EVALS_DIR}/corpus.json`;
/** Where the onboarder proposes additions to AGENTS.md; ways moves them into AGENTS.md as one marked block. */
export const AGENTS_PROPOSAL_PATH = `${WAYS_DIR}/agents-proposal.md`;
/** The role `ways onboard` gives the agent it launches. */
export const ONBOARDER_ROLE = "onboarder";

/** What the onboarder may write: the map notes (and MAP.md, which ways regenerates), the memory, the evals and its AGENTS.md proposal. */
export function isOnboarderPath(path: string): boolean {
  return path === MAP_PATH || path === MAP_NOTES_PATH || path === AGENTS_PROPOSAL_PATH
    || path.startsWith(`${KNOWLEDGE_DIR}/`) || path.startsWith(`${EVALS_DIR}/`);
}

/** A role ways launches an agent for, and the only paths that agent may write. */
export interface RoleScope {
  allowed(path: string): boolean;
  /** Where it may write, for messages. */
  where: string;
  /** What it is, for messages. */
  what: string;
}

export const ROLE_SCOPES: Readonly<Record<string, RoleScope>> = {
  [DOCUMENTALIST_ROLE]: { allowed: isWikiPath, where: `${WIKI_DIR}/`, what: "the documentalist: you write only the wiki for humans. Code, tests, configuration and .ways/knowledge (the agents' memory, a different thing) are not yours to change" },
  [ONBOARDER_ROLE]: { allowed: isOnboarderPath, where: `${MAP_NOTES_PATH}, ${KNOWLEDGE_DIR}/, ${EVALS_DIR}/ and ${AGENTS_PROPOSAL_PATH}`, what: "the onboarder: you write only the map notes, the memory, the project evals and the AGENTS.md proposal. Code, tests, configuration and AGENTS.md itself are not yours to change" },
};

/** The role of a session ways launched (environment `WAYS_ROLE`), when it is one ways knows. */
export function knownRole(value: string | undefined): string | undefined {
  return value !== undefined && Object.hasOwn(ROLE_SCOPES, value) ? value : undefined;
}
/** The coding-agent hook wrapper: `agent-hook <agent> <event>` runs `ways hook <event> --agent=<agent>`. */
export const AGENT_HOOK_PATH = `${HOOKS_DIR}/agent-hook`;

/** The verifier surface unless the config overrides it (dependency and build directories never count). */
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
  ".gitlab-ci.yml",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  "**/jest.config.*",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/karma.conf.*",
  "**/.mocharc*",
  "**/conftest.py",
  "**/pytest.ini",
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
