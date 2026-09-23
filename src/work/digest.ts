import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTCOME_DIR, SDD_DIR, STATE_PATH, STATUS_PATH } from "../domain/constants.js";
import type { WorkState } from "../domain/types.js";
import { GitRepository } from "../git/git.js";
import { attemptNumber, remediationTransitionCommit } from "./attempt.js";

/** Paths the harness rewrites on its own; they never count as reviewed or approved content. */
const BOOKKEEPING = [STATUS_PATH, `${STATE_PATH}`];

function isBookkeeping(path: string): boolean {
  if (BOOKKEEPING.includes(path)) return true;
  return new RegExp(`^${SDD_DIR}/[^/]+/(?:attempts/[0-9]+/)?(approvals|reviews)/`).test(path)
    || new RegExp(`^${OUTCOME_DIR}/[^/]+/attempts/[0-9]+/reviews/`).test(path);
}

/**
 * Digest of everything that changed since `since`: the tracked diff against the
 * working tree plus every untracked file. Bookkeeping paths are excluded so the
 * digest survives the harness's own state updates but dies on any content edit.
 */
const DIGEST_EXCLUDES = [
  `:(exclude)${STATUS_PATH}`,
  `:(exclude)${STATE_PATH}`,
  `:(exclude,glob)${SDD_DIR}/*/approvals/**`,
  `:(exclude,glob)${SDD_DIR}/*/reviews/**`,
  `:(exclude,glob)${SDD_DIR}/*/attempts/*/approvals/**`,
  `:(exclude,glob)${SDD_DIR}/*/attempts/*/reviews/**`,
  `:(exclude,glob)${OUTCOME_DIR}/*/attempts/*/reviews/**`,
];

// Mnemonic prefixes differ between worktree and tree comparisons (c/w vs a/b),
// and diff.algorithm comes from the surrounding git config (histogram here,
// myers on fresh runners). Pin both without changing historical hunks so a
// digest recorded on one machine replays on any other.
const DIGEST_DIFF = [
  "diff", "--binary", "--no-color", "--no-ext-diff",
  "--src-prefix=a/", "--dst-prefix=b/",
  "--diff-algorithm=histogram",
];

/** Deterministic digest between two committed trees, with optional transition-only paths omitted. */
export async function committedWorkDigest(git: GitRepository, since: string, ref: string, omitted: readonly string[] = []): Promise<string> {
  const excludes = [...DIGEST_EXCLUDES, ...omitted.map((path) => `:(exclude)${path}`)];
  const hash = createHash("sha256");
  hash.update(await git.run([...DIGEST_DIFF, since, ref, "--", ".", ...excludes]));
  return hash.digest("hex");
}

export async function workDigest(cwd: string, since: string): Promise<string> {
  const git = new GitRepository(cwd);
  const hash = createHash("sha256");
  hash.update(await git.run([...DIGEST_DIFF, since, "--", ".", ...DIGEST_EXCLUDES]));
  const untracked = (await git.run(["ls-files", "--others", "--exclude-standard"])).split("\n").filter((path) => path && !isBookkeeping(path)).sort();
  for (const path of untracked) {
    hash.update(`\0${path}\0`);
    hash.update(await readFile(join(cwd, path)));
  }
  return hash.digest("hex");
}

/**
 * The review baseline starts before the implementation cycle, not at its final
 * integration. Remediation cycles begin immediately after their immutable
 * transition record; attempt zero begins after its decompose certification.
 */
export async function implementationCycleBaseline(cwd: string, state: WorkState): Promise<string> {
  const git = new GitRepository(cwd);
  const attempt = attemptNumber(state.attempt);
  if (attempt > 0) {
    if (!state.remediation || state.remediation.attempt !== attempt) {
      throw new Error(`Remediation attempt ${attempt} has no matching transition metadata`);
    }
    return remediationTransitionCommit(git, state.id, state.remediation);
  }

  const decompose = await git.findCertification(state.id, "decompose");
  if (!decompose) throw new Error("Review digest requires a completed decompose phase");
  return decompose.hash;
}

/** Digest the complete current implementation cycle for a review. */
export async function implementationDigest(cwd: string, state: WorkState): Promise<string> {
  return workDigest(cwd, await implementationCycleBaseline(cwd, state));
}
