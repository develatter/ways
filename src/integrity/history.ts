import { committedContract, sameContract } from "../check/contract.js";
import { enforcementOf, loadConfig } from "../config/config.js";
import { MANIFEST_PATH, WORK_DIR } from "../domain/constants.js";
import type { IntegrityIssue, WorkRecord } from "../domain/types.js";
import { validateWorkRecord } from "../domain/validation.js";
import { stableJson } from "../fs/files.js";
import { GitRepository, type CommitInfo } from "../git/git.js";
import { baseConfig } from "../work/evaluate.js";
import { pending } from "../work/record.js";

export interface HistoryOptions {
  since?: string;
  to?: string;
}

const HARNESS_STATES = new Set(["opened", "verifying", "reviewed", "approved", "blocked", "closed", "cancelled"]);

export async function manifestIntroduction(git: GitRepository): Promise<string | undefined> {
  const hashes = (await git.run(["log", "--format=%H", "--diff-filter=A", "--", MANIFEST_PATH])).split("\n").filter(Boolean);
  return hashes.at(-1);
}

export async function commitsAfter(git: GitRepository, anchor: string, to = "HEAD"): Promise<CommitInfo[]> {
  const output = await git.run(["rev-list", "--topo-order", "--reverse", `${anchor}..${to}`]);
  const commits: CommitInfo[] = [];
  for (const hash of output.split("\n").filter(Boolean)) commits.push(await git.commitInfo(hash));
  return commits;
}

async function parents(git: GitRepository, hash: string): Promise<string[]> {
  return (await git.run(["show", "-s", "--format=%P", hash])).split(" ").filter(Boolean);
}

/** A merge that adds nothing beyond its parents is an integration event, not authored work. */
async function isCleanMerge(git: GitRepository, commit: CommitInfo): Promise<boolean> {
  if ((await parents(git, commit.hash)).length < 2) return false;
  return (await git.run(["show", "--cc", "--format=", commit.hash])) === "";
}

async function recordAt(git: GitRepository, ref: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await git.run(["show", `${ref}:${path}`]));
  } catch {
    return undefined;
  }
}

function definition(record: WorkRecord): string {
  return stableJson({ id: record.id, kind: record.kind, goal: record.goal ?? null, criteria: record.criteria, policy: record.policy, openedAt: record.openedAt });
}

/**
 * Checks one commit that changed a work record against what only ways can
 * produce: the definition fixed when the record appeared, evidence bound to
 * the commit it sits on, and a close whose tree is exactly the evaluated one.
 * It does not re-run anything; CI runs the checks on the merged result.
 */
async function recordVersionIssues(git: GitRepository, commit: CommitInfo, path: string): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  const at = commit.hash.slice(0, 12);
  const fail = (code: string, message: string): void => {
    issues.push({ code, path: `${at} ${path}`, message });
  };
  const id = path.slice(WORK_DIR.length + 1, -".json".length);
  const [parent] = await parents(git, commit.hash);
  const value = await recordAt(git, commit.hash, path);
  if (value === undefined) {
    fail("history-record-deleted", `work record ${id} was deleted; records are the audit trail and stay`);
    return issues;
  }
  if (!validateWorkRecord(value) || value.id !== id) {
    fail("history-record-invalid", `work record ${id} does not match its schema`);
    return issues;
  }
  const record = value;
  if (commit.trailers.work !== id || !HARNESS_STATES.has(commit.trailers.state ?? "")) {
    fail("history-record-hand-made", `work record ${id} was changed by "${commit.subject}", a commit ways did not make`);
  }
  const touched = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", commit.hash])).split("\n").filter(Boolean);
  if (touched.some((candidate) => candidate !== path)) fail("history-record-mixed", `the commit that changed ${id}'s record also changed ${touched.filter((candidate) => candidate !== path).join(", ")}`);

  const previous = parent ? await recordAt(git, parent, path) : undefined;
  const introduced = (await git.run(["log", "--format=%H", "--diff-filter=A", commit.hash, "--", path])).split("\n").filter(Boolean).at(0);
  const original = introduced ? await recordAt(git, introduced, path) : undefined;
  if (validateWorkRecord(original) && definition(original) !== definition(record)) {
    fail("history-criteria-changed", `the goal, criteria or policy of ${id} changed after it was opened`);
  }
  const evidence = record.evidence;
  const evidenceChanged = evidence !== undefined && stableJson(evidence) !== stableJson((previous as WorkRecord | undefined)?.evidence ?? null);
  if (evidence && evidenceChanged) {
    if (evidence.input.commit !== parent) fail("history-evidence-unbound", `evidence of ${id} is for ${evidence.input.commit.slice(0, 12)}, not for the commit it was recorded on`);
    else if (await git.treeId(parent) !== evidence.input.tree) fail("history-evidence-unbound", `evidence of ${id} names another tree than its input commit`);
    if (!evidence.passed) fail("history-evidence-failed", `evidence of ${id} records a failure; ways records only passing evidence`);
    // The checks run with the base's configuration; only a base without one falls back to the input's.
    const contract = await committedContract(git, evidence.base) ?? await committedContract(git, evidence.input.commit);
    if (contract && !sameContract(contract, evidence.contract)) fail("history-evidence-contract", `evidence of ${id} ran other commands than the check configuration of its base ${evidence.base.slice(0, 12)}`);
    const policy = ((await baseConfig(git, evidence.base)) ?? await baseConfig(git, evidence.input.commit))?.approvals as { signature?: string; verifierChanges?: string } | undefined;
    if (evidence.approvals && (evidence.approvals.signature !== (policy?.signature === "required" ? "required" : "optional") || evidence.approvals.verifierChanges !== (policy?.verifierChanges === "human" ? "human" : "human-or-review"))) {
      fail("history-evidence-policy", `evidence of ${id} names another approval policy than the configuration of its base`);
    }
    for (const criterion of record.criteria) {
      const entry = evidence.criteria[criterion.id];
      const expected = criterion.verify ? "passed" : "review-only";
      if (entry?.status !== expected || (criterion.verify && stableJson(entry.command ?? null) !== stableJson(criterion.verify))) {
        fail("history-evidence-criterion", `criterion ${criterion.id} of ${id} lacks a passing run of its own verifier`);
      }
    }
  }
  if (record.closed && !(previous as WorkRecord | undefined)?.closed) {
    if (!evidence?.passed) fail("history-close-unproven", `${id} closed without passing evidence`);
    else {
      const drift = (await git.run(["diff", "--name-only", evidence.input.commit, commit.hash, "--"])).split("\n").filter((candidate) => candidate && candidate !== path);
      if (drift.length > 0) fail("history-close-drift", `${id} closed with changes its evidence never saw: ${drift.join(", ")}`);
      const missing = pending(record);
      if (missing.review) fail("history-close-review", `${id} closed although ${missing.review}`);
      if (missing.approval) fail("history-close-approval", `${id} closed without a valid human approval (${missing.approval})`);
    }
  }
  return issues;
}

async function blobAt(git: GitRepository, ref: string, path: string): Promise<string | undefined> {
  try {
    return await git.run(["rev-parse", "-q", "--verify", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

async function mergeMadeRecords(git: GitRepository, merge: string, mergeParents: readonly string[]): Promise<string[]> {
  const touched = new Set<string>();
  for (const parent of mergeParents) {
    for (const path of (await git.run(["diff", "--name-only", parent, merge, "--", `${WORK_DIR}/`])).split("\n")) if (path.endsWith(".json")) touched.add(path);
  }
  const made: string[] = [];
  for (const path of touched) {
    const version = await blobAt(git, merge, path);
    const fromParents = await Promise.all(mergeParents.map((parent) => blobAt(git, parent, path)));
    if (!fromParents.includes(version)) made.push(path);
  }
  return made.sort();
}

export async function auditHistory(git: GitRepository, commits: readonly CommitInfo[], options: { untraced: boolean }): Promise<IntegrityIssue[]> {
  const issues: IntegrityIssue[] = [];
  for (const commit of commits) {
    const commitParents = await parents(git, commit.hash);
    if (commitParents.length > 1) {
      // Merged branches are audited commit by commit; a merge with its own changes still needs a trailer in enforce.
      if (options.untraced && !commit.trailers.work && !await isCleanMerge(git, commit)) {
        issues.push({ code: "history-untraced", path: commit.hash.slice(0, 12), message: `Merge "${commit.subject}" adds its own changes without a Harness-Work trailer` });
      }
      // A record version equal to one of the parents' came from that branch; any other was written by the merge itself.
      for (const path of await mergeMadeRecords(git, commit.hash, commitParents)) {
        issues.push({ code: "history-record-hand-made", path: `${commit.hash.slice(0, 12)} ${path}`, message: `the merge "${commit.subject}" wrote its own version of a work record; resolve record conflicts by taking one side and running \`ways done\` again` });
      }
      continue;
    }
    if (options.untraced && !commit.trailers.work) {
      issues.push({ code: "history-untraced", path: commit.hash.slice(0, 12), message: `Commit "${commit.subject}" lacks a Harness-Work trailer (enforcement: enforce)` });
    }
    const records = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", commit.hash, "--", `${WORK_DIR}/`])).split("\n").filter((path) => path.endsWith(".json"));
    for (const path of records) issues.push(...await recordVersionIssues(git, commit, path));
  }
  return issues;
}

async function resolveAnchor(cwd: string, git: GitRepository, since?: string): Promise<string | undefined> {
  if (since) return git.run(["rev-parse", "--verify", `${since}^{commit}`]);
  try {
    const config = await loadConfig(cwd);
    if (config.historySince) return git.run(["rev-parse", "--verify", `${config.historySince}^{commit}`]);
  } catch {
    // A missing config is reported by checkIntegrity.
  }
  return manifestIntroduction(git);
}

/** `ways check --history`: work records in the range, and in enforce mode untraced commits. */
export async function checkHistory(cwd: string, options: HistoryOptions = {}): Promise<IntegrityIssue[]> {
  const git = new GitRepository(cwd);
  const anchor = await resolveAnchor(cwd, git, options.since);
  if (!anchor) return [];
  let untraced = false;
  try {
    untraced = enforcementOf(await loadConfig(cwd)) === "enforce";
  } catch {
    // Integrity reports the configuration.
  }
  return auditHistory(git, await commitsAfter(git, anchor, options.to), { untraced });
}
