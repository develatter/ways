import type { OutcomeSpec, ReviewResult } from "../domain/types.js";
import { validateReview } from "../domain/validation.js";
import { GitRepository, parseTrailers } from "../git/git.js";
import { outcomeOpenCommit, outcomeSpecPath } from "./outcome.js";
import { reviewBlocks } from "./review.js";

/**
 * Evaluation policy of an outcome work, chosen at open and committed in its
 * immutable spec. `independent` (default) requires a fresh, passing review
 * bound to the evaluated increment by a reviewer who is not a known
 * implementer; `self` lets close rely on the passing evaluation alone.
 *
 * Identities here are the self-asserted Git author/committer fields and the
 * reviewer string; they catch honest mistakes, not a determined impostor.
 */
export type EvaluationMode = "independent" | "self";
export const EVALUATION_MODES: readonly EvaluationMode[] = ["independent", "self"];
/** Accepted spec values; absent reads as required. */
export const INDEPENDENT_EVALUATION: readonly unknown[] = [undefined, "required", "optional"];

export function evaluationPolicy(mode: EvaluationMode): "required" | "optional" {
  return mode === "self" ? "optional" : "required";
}

/** Specs without the field predate the choice and keep the conservative default. */
export function independentEvaluationRequired(spec: OutcomeSpec): boolean {
  return (spec.policy.independentEvaluation ?? "required") === "required";
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Author and committer names and emails of the task commits, and direct commits under optional isolation, that implemented the increment. */
export async function implementerIdentities(git: GitRepository, workId: string, openCommit: string, input: string): Promise<Set<string>> {
  const identities = new Set<string>();
  const hashes = (await git.run(["rev-list", `${openCommit}..${input}`])).split("\n").filter(Boolean);
  for (const hash of hashes) {
    const [author = "", authorEmail = "", committer = "", committerEmail = "", body = ""] = (await git.run(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%b", hash])).split("\0");
    const trailers = parseTrailers(body);
    if (trailers.work !== workId || (!trailers.task && (trailers.phase?.startsWith("outcome-") ?? false))) continue;
    for (const identity of [author, authorEmail, committer, committerEmail]) if (identity.trim()) identities.add(normalize(identity));
  }
  return identities;
}

/** The reviewer string, or its name and email when written as `Name <email>`, must not name a known implementer. */
export function reviewerProvenanceFailure(reviewer: string, identities: ReadonlySet<string>): string | undefined {
  const tokens = [reviewer];
  const match = /^(.*)<([^>]+)>\s*$/.exec(reviewer);
  if (match) tokens.push(match[1]!, match[2]!);
  const matched = tokens.map(normalize).find((token) => token && identities.has(token));
  return matched ? `reviewer "${reviewer.trim()}" matches an implementer of the increment; independent evaluation is required` : undefined;
}

export interface EvaluationContext {
  spec: OutcomeSpec;
  workId: string;
  attempt: number;
  openCommit: string;
  /** The evaluated input: parent of the certified execution. */
  input: string;
  /** Digest of the evaluated increment, which covers the committed spec and so its criteria. */
  digest: () => Promise<string>;
}

/**
 * Verifies the recorded review against the committed evaluation policy.
 * Required: a valid review of this work, attempt and increment, without
 * blocking findings, by a reviewer who is not a known implementer. Optional:
 * no review is needed, but a recorded one must still bind and pass.
 */
export async function outcomeEvaluationFailure(git: GitRepository, context: EvaluationContext, review: unknown): Promise<string | undefined> {
  const required = independentEvaluationRequired(context.spec);
  if (review === undefined && !required) return undefined;
  if (!validateReview(review)) return required ? "an independent review is required" : "the recorded review is invalid";
  const bound = reviewBindingFailure(review, context.workId, context.attempt);
  if (bound) return bound;
  const blockers = reviewBlocks(review);
  if (blockers.length > 0) return `review blocked by: ${blockers.join(", ")}`;
  if (review.digest !== await context.digest()) return "review is stale: it does not match the evaluated increment";
  if (!required) return undefined;
  return reviewerProvenanceFailure(review.reviewer, await implementerIdentities(git, context.workId, context.openCommit, context.input));
}

/** Submission-time provenance check while the work is in evaluate: HEAD is the certified execution. */
export async function submittedReviewerFailure(cwd: string, workId: string, reviewer: string): Promise<string | undefined> {
  const git = new GitRepository(cwd);
  const open = await outcomeOpenCommit(git, workId);
  if (!open) return "outcome work has no opening commit";
  const spec = JSON.parse(await git.run(["show", `${open.hash}:${outcomeSpecPath(workId)}`])) as OutcomeSpec;
  if (!independentEvaluationRequired(spec)) return undefined;
  return reviewerProvenanceFailure(reviewer, await implementerIdentities(git, workId, open.hash, await git.parent("HEAD")));
}

function reviewBindingFailure(review: ReviewResult, workId: string, attempt: number): string | undefined {
  return review.workId !== workId || (review.attempt ?? 0) !== attempt || !review.reviewer.trim() ? "review does not belong to this work and attempt" : undefined;
}
