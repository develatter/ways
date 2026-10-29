import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORK_DIR, workRecordPath } from "../domain/constants.js";
import type { Approval, Evidence, FindingSeverity, Review, WorkRecord } from "../domain/types.js";
import { validateWorkRecord, validationDetails } from "../domain/validation.js";
import { sha256, stableJson, writeAtomic } from "../fs/files.js";
import type { GitRepository } from "../git/git.js";

export async function committedRecord(git: GitRepository, id: string, ref = "HEAD"): Promise<WorkRecord | undefined> {
  let content: string;
  try {
    content = await git.run(["show", `${ref}:${workRecordPath(id)}`]);
  } catch {
    return undefined;
  }
  const value: unknown = JSON.parse(content);
  if (!validateWorkRecord(value)) throw new Error(`${workRecordPath(id)} at ${ref.slice(0, 12)} is invalid: ${validationDetails("work", value).errors.join("; ")}`);
  return value;
}

export async function writeRecord(cwd: string, record: WorkRecord): Promise<string> {
  if (!validateWorkRecord(record)) throw new Error(`Refusing to write an invalid work record: ${validationDetails("work", record).errors.join("; ")}`);
  const path = workRecordPath(record.id);
  await writeAtomic(join(cwd, path), stableJson(record));
  return path;
}

export async function workingRecordText(cwd: string, id: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, workRecordPath(id)), "utf8");
  } catch {
    return undefined;
  }
}

export function isOpen(record: WorkRecord): boolean {
  return !record.closed && !record.cancelled;
}

/** Records in `ref` that are neither closed nor cancelled. */
export async function openRecords(git: GitRepository, ref = "HEAD"): Promise<WorkRecord[]> {
  let names: string[];
  try {
    names = (await git.run(["ls-tree", "--name-only", `${ref}:${WORK_DIR}`])).split("\n").filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const records: WorkRecord[] = [];
  for (const name of names) {
    const record = await committedRecord(git, name.slice(0, -5), ref).catch(() => undefined);
    if (record && isOpen(record)) records.push(record);
  }
  return records;
}

/** The commit that added the record, which for an outcome is its opening. */
export async function recordIntroduction(git: GitRepository, id: string, ref = "HEAD"): Promise<string | undefined> {
  const hashes = (await git.run(["log", "--format=%H", "--diff-filter=A", ref, "--", workRecordPath(id)])).split("\n").filter(Boolean);
  return hashes[0];
}

const BLOCKING: ReadonlySet<FindingSeverity> = new Set(["critical", "high"]);

/** Only an unfixed critical or high finding, or a verdict other than pass, blocks. */
export function reviewBlockers(review: Pick<Review, "verdict" | "findings">): string[] {
  const blockers = review.findings.filter((finding) => BLOCKING.has(finding.severity) && finding.disposition !== "fixed").map((finding) => finding.id);
  if (review.verdict !== "pass") blockers.push("verdict");
  return [...new Set(blockers)];
}

export function reviewNotes(review: Pick<Review, "findings">): string[] {
  return review.findings.filter((finding) => !BLOCKING.has(finding.severity)).map((finding) => `${finding.id} (${finding.severity}${finding.disposition ? `, ${finding.disposition}` : ""}): ${finding.summary}`);
}

/** What a human approval covers: the definition of done, the evidence and the review. */
export function approvalDigest(record: WorkRecord): string {
  const { id, kind, goal, criteria, policy, evidence, review } = record;
  return sha256(stableJson({ id, kind, goal: goal ?? null, criteria, policy, evidence: evidence ?? null, review: review ?? null }));
}

export interface Pending {
  /** Review still needed before close, with why. */
  review?: string;
  /** Human approval still needed before close, with why. */
  approval?: string;
}

export function reviewRequired(record: WorkRecord): boolean {
  return record.policy.review === "required" || record.criteria.some((criterion) => criterion.strength === "review-only");
}

export function approvalReasons(record: WorkRecord, evidence: Evidence): string[] {
  const reasons: string[] = [];
  if (record.policy.approval === "required") reasons.push("the work was opened with --approval=required");
  if (evidence.verifierChanges.length > 0) reasons.push(`the change modifies or deletes existing tests or check configuration: ${evidence.verifierChanges.join(", ")}`);
  return reasons;
}

function approvalValid(record: WorkRecord, approval: Approval | undefined, evidence: Evidence): boolean {
  return approval !== undefined && approval.input === evidence.input.commit && approval.digest === approvalDigest(record);
}

/** What still stands between a passing evidence and close. */
export function pending(record: WorkRecord): Pending {
  const evidence = record.evidence;
  if (!evidence?.passed) return {};
  const result: Pending = {};
  const review = record.review?.commit === evidence.input.commit ? record.review : undefined;
  if (review && reviewBlockers(review).length > 0) {
    // A submitted review counts even when none was required.
    result.review = `the review blocks: ${reviewBlockers(review).join(", ")}`;
  } else if (!review && reviewRequired(record)) {
    result.review = record.policy.review === "required" ? "an independent review is required" : "a criterion has no executable verifier (review-only)";
  }
  const reasons = approvalReasons(record, evidence);
  if (reasons.length > 0 && !approvalValid(record, record.approval, evidence)) result.approval = reasons.join("; ");
  return result;
}
