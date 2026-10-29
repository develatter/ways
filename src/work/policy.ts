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

/** Criteria whose evidence is review-only: no verifier, or one that already passed on the base. */
export function reviewOnlyCriteria(record: WorkRecord): string[] {
  return record.criteria.filter((criterion) => {
    const entry = record.evidence?.criteria[criterion.id];
    return criterion.strength === "review-only" || entry?.effective === "review-only";
  }).map((criterion) => criterion.id);
}

export function reviewRequired(record: WorkRecord): boolean {
  return record.policy.review === "required" || reviewOnlyCriteria(record).length > 0;
}

/** The approval policy the evidence was evaluated under (the base's), with the defaults. */
export function approvalsPolicy(evidence: Evidence | undefined): Required<Pick<NonNullable<Evidence["approvals"]>, "signature" | "verifierChanges">> {
  return { signature: evidence?.approvals?.signature ?? "optional", verifierChanges: evidence?.approvals?.verifierChanges ?? "human-or-review" };
}

/** What the verifier checkpoint covers: changed existing verifier files, and `tests-ran` when fewer tests ran than on the base. */
export function verifierCheckpoint(evidence: Evidence): string[] {
  return [...evidence.verifierChanges, ...(evidence.tests?.dropped ? ["tests-ran"] : [])];
}

/** A review counts only with provenance ways recorded itself, for the evaluated commit; one from a terminal needs the human's approval too ({@link terminalReview}). */
export function attestedReview(record: WorkRecord): Review | undefined {
  const review = record.review;
  return review && review.provenance && review.commit === record.evidence?.input.commit ? review : undefined;
}

/**
 * Checkpoint entries an independent review explicitly accepted through a
 * finding's `accepts`. Only a reviewer ways launched or handed its prompt to
 * (`process`, `subagent`) can accept; a file typed in at a terminal cannot,
 * because a pseudo-terminal gives an agent one; that case is the human's
 * approval. Where the base requires signed approvals no review can stand in
 * for one: locally a review's provenance is only as strong as the hooks, and
 * the signature is the one anchor CI can check.
 */
export function acceptedByReview(record: WorkRecord): Set<string> {
  const review = attestedReview(record);
  if (!review || (review.provenance!.via !== "process" && review.provenance!.via !== "subagent")) return new Set();
  if (approvalsPolicy(record.evidence).signature === "required") return new Set();
  return new Set(review.findings.flatMap((finding) => finding.accepts ?? []));
}

function verifierReason(evidence: Evidence, entries: readonly string[]): string {
  const files = entries.filter((entry) => entry !== "tests-ran");
  const parts = [
    ...(files.length > 0 ? [`the change removes or changes lines of existing tests, disables or narrows tests, or changes check configuration: ${files.join(", ")}`] : []),
    ...(entries.includes("tests-ran") && evidence.tests?.baseline ? [`fewer tests ran than on the base (${evidence.tests.ran} < ${evidence.tests.baseline.ran} at ${evidence.tests.baseline.commit.slice(0, 12)})`] : []),
  ];
  return parts.join("; ");
}

/**
 * A review typed in at a terminal (`ways review submit`): ways cannot tell a
 * human there from an agent with a pseudo-terminal (`script -qc`), so where a
 * review is required it stands only together with the human's approval, which
 * then covers it (the approval digest includes the review) and can be signed.
 */
export function terminalReview(record: WorkRecord): boolean {
  return attestedReview(record)?.provenance?.via === "terminal" && reviewRequired(record);
}

const TERMINAL_REVIEW = "the required review was typed in at a terminal, which an agent can reach through a pseudo-terminal";

/** Why a human must approve. The verifier checkpoint drops out when an attested review accepted every entry and the policy allows it. */
export function approvalReasons(record: WorkRecord, evidence: Evidence): string[] {
  const reasons: string[] = [];
  if (record.policy.approval === "required") reasons.push("the work was opened with --approval=required");
  if (terminalReview({ ...record, evidence })) reasons.push(TERMINAL_REVIEW);
  const checkpoint = verifierCheckpoint(evidence);
  if (checkpoint.length > 0) {
    const accepted = approvalsPolicy(evidence).verifierChanges === "human-or-review" ? acceptedByReview({ ...record, evidence }) : new Set<string>();
    const open = checkpoint.filter((entry) => !accepted.has(entry));
    if (open.length > 0) reasons.push(verifierReason(evidence, open));
  }
  return reasons;
}

function approvalValid(record: WorkRecord, approval: Approval | undefined, evidence: Evidence): boolean {
  if (approval === undefined || approval.input !== evidence.input.commit || approval.digest !== approvalDigest(record)) return false;
  return approvalsPolicy(evidence).signature !== "required" || (approval.via === "ssh-signature" && approval.signature !== undefined);
}

/** What still stands between a passing evidence and close. */
export function pending(record: WorkRecord): Pending {
  const evidence = record.evidence;
  if (!evidence?.passed) return {};
  const result: Pending = {};
  const review = attestedReview(record);
  if (review && reviewBlockers(review).length > 0) {
    // A submitted review counts even when none was required.
    result.review = `the review blocks: ${reviewBlockers(review).join(", ")}`;
  } else if (!review && reviewRequired(record)) {
    const weak = reviewOnlyCriteria(record);
    result.review = record.policy.review === "required" ? "an independent review is required" : `${weak.join(", ")} ${weak.length === 1 ? "has" : "have"} no verifier that fails without the work (review-only)`;
  }
  const reasons = approvalReasons(record, evidence);
  if (reasons.length > 0 && !approvalValid(record, record.approval, evidence)) {
    result.approval = `${reasons.join("; ")}${approvalsPolicy(evidence).signature === "required" ? " (an SSH-signed approval: approvals.signature is required)" : ""}`;
  }
  return result;
}
