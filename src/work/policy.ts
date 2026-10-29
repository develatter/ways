import type { Approval, Evidence, FindingSeverity, Review, WorkRecord } from "../domain/types.js";
import { sha256, stableJson } from "../fs/digest.js";

/**
 * What a record still needs before it closes, as pure functions over the
 * record. No schema validation here: the context brief loads this module on
 * agent hooks, where ajv would cost more than the whole hook budget.
 */

export function isOpen(record: WorkRecord): boolean {
  return !record.closed && !record.cancelled;
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
