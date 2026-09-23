import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewResult, WorkState } from "../domain/types.js";
import { validateReview, validationDetails } from "../domain/validation.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import { loadState } from "../state/store.js";
import { attemptNumber, attemptReviewPath } from "./attempt.js";
import { implementationDigest } from "./digest.js";
import { outcomeReviewDigest, outcomeReviewPath } from "./outcome.js";
import { submittedReviewerFailure } from "./outcome-evaluation-policy.js";

export function reviewBlocks(result: ReviewResult): string[] {
  const blockers: string[] = [];
  for (const finding of result.findings) {
    if ((finding.severity === "critical" || finding.severity === "high") && finding.disposition !== "fixed") blockers.push(finding.id);
    if ((finding.severity === "medium" || finding.severity === "low") && finding.disposition === "open") blockers.push(finding.id);
  }
  if (result.verdict !== "pass") blockers.push("verdict");
  return [...new Set(blockers)];
}

function reviewAttemptFailure(value: ReviewResult, state: WorkState): string | undefined {
  if (attemptNumber(value.attempt) !== attemptNumber(state.attempt)) return "Review attempt does not match the active remediation attempt";
  return undefined;
}

export async function submitReview(cwd: string, inputPath: string): Promise<ReviewResult> {
  const state = await loadState(cwd);
  const outcome = state?.mode === "outcome" && state.stage === "evaluate";
  if (!state || (!outcome && (state.mode !== "sdd" || state.phase !== "review"))) throw new Error("Reviews are accepted only during the review phase or outcome evaluation");
  const value: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (!validateReview(value)) throw new Error(`Invalid review: ${validationDetails("review", value).errors.join("; ")}`);
  if (value.workId !== state.id) throw new Error("Review work id does not match active work");
  if (!value.reviewer.trim()) throw new Error("Independent reviewer identity is required");
  const attemptFailure = reviewAttemptFailure(value, state);
  if (attemptFailure) throw new Error(attemptFailure);
  const digest = outcome ? await outcomeReviewDigest(cwd, state) : await implementationDigest(cwd, state);
  if (value.digest !== digest) throw new Error(`Review digest ${value.digest.slice(0, 12)} does not match the current diff ${digest.slice(0, 12)}; review the current content and obtain it with \`ways review digest\``);
  const provenance = outcome ? await submittedReviewerFailure(cwd, state.id, value.reviewer) : undefined;
  if (provenance) throw new Error(provenance[0]!.toUpperCase() + provenance.slice(1));
  await writeAtomic(join(cwd, outcome ? outcomeReviewPath(state.id, state.attempt) : attemptReviewPath(state.id, state.attempt)), stableJson(value));
  return value;
}

/** Digest of the complete implementation cycle a reviewer must have looked at. */
export async function reviewDigest(cwd: string): Promise<string> {
  const state = await loadState(cwd);
  if (state?.mode === "outcome" && state.stage === "evaluate") return outcomeReviewDigest(cwd, state);
  if (!state || state.mode !== "sdd" || state.phase !== "review") throw new Error("Review digests exist only during the review phase or outcome evaluation");
  return implementationDigest(cwd, state);
}

export async function assertReviewPassed(cwd: string, state: WorkState): Promise<void> {
  const path = join(cwd, attemptReviewPath(state.id, state.attempt));
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("A delegated review result is required");
  }
  if (!validateReview(value)) throw new Error("Latest review is invalid");
  const attemptFailure = reviewAttemptFailure(value, state);
  if (attemptFailure) throw new Error(attemptFailure);
  const blockers = reviewBlocks(value);
  if (blockers.length > 0) throw new Error(`Review gate blocked by: ${blockers.join(", ")}`);
  if (value.digest !== await implementationDigest(cwd, state)) throw new Error("Review is stale: content changed after it was submitted; obtain a fresh review");
}
