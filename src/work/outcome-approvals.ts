import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTCOME_DIR } from "../domain/constants.js";
import { OUTCOME_CHECKPOINTS, type OutcomeCheckpoint, type WorkState } from "../domain/types.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import { GitRepository } from "../git/git.js";
import { loadState } from "../state/store.js";
import { approverIdentity, processTerminal, type Terminal } from "./approve.js";
import { attemptFailureCommit, outcomeMemoryReviewPath, outcomeOpenCommit, outcomeReviewPath, outcomeSpecPath } from "./outcome.js";

/**
 * Human approvals of outcome transitions. The policy is fixed in the spec
 * committed at open; each approval is written only through an interactive
 * terminal and binds work, checkpoint, attempt, the committed input and the
 * content the transition records, so any later edit invalidates it.
 */
export interface OutcomeApprovalRecord {
  schemaVersion: 1;
  workId: string;
  checkpoint: OutcomeCheckpoint;
  attempt: number;
  inputCommit: string;
  digest: string;
  approvedBy: string;
  approvedAt: string;
}

/** Reads JSON content at a path from the working tree, the index or a commit. */
export type ContentReader = (path: string) => Promise<unknown>;

/** Parses `--approvals=none|close|<checkpoint,...>` into the canonical policy list. */
export function parseApprovalPolicy(value: string): OutcomeCheckpoint[] {
  if (value.trim() === "none") return [];
  const policy = canonical(value.split(",").map((name) => name.trim()));
  if (approvalPolicyFailure(policy)) {
    throw new Error(`--approvals must be none or a comma-separated list of ${OUTCOME_CHECKPOINTS.join(", ")}; got "${value}"`);
  }
  return policy as OutcomeCheckpoint[];
}

function canonical(names: readonly string[]): string[] {
  return [...names].sort((left, right) => rank(left) - rank(right));
}

function rank(name: string): number {
  const index = (OUTCOME_CHECKPOINTS as readonly string[]).indexOf(name);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/** Specs without the field read as none; a present list is non-empty, supported, unique and canonical. */
export function approvalPolicyFailure(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return "approval policy must be a non-empty list of checkpoints";
  if (value.some((name) => !(OUTCOME_CHECKPOINTS as readonly unknown[]).includes(name))) return `approval checkpoints must be among ${OUTCOME_CHECKPOINTS.join(", ")}`;
  if (new Set(value).size !== value.length || stableJson(canonical(value as string[])) !== stableJson(value)) return "approval checkpoints must be unique and in canonical order";
  return undefined;
}

export function outcomeApprovalPath(workId: string, attempt: number, checkpoint: OutcomeCheckpoint): string {
  return `${OUTCOME_DIR}/${workId}/approvals/${attempt}/${checkpoint}.json`;
}

function validateRecord(value: unknown): value is OutcomeApprovalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && typeof record.workId === "string" && (OUTCOME_CHECKPOINTS as readonly unknown[]).includes(record.checkpoint)
    && Number.isInteger(record.attempt) && (record.attempt as number) >= 0 && typeof record.inputCommit === "string" && /^[0-9a-f]{40,64}$/.test(record.inputCommit)
    && typeof record.digest === "string" && /^[0-9a-f]{64}$/.test(record.digest) && typeof record.approvedBy === "string" && record.approvedBy.trim() !== ""
    && typeof record.approvedAt === "string" && !Number.isNaN(Date.parse(record.approvedAt));
}

async function showJson(git: GitRepository, ref: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await git.run(["show", `${ref}:${path}`]));
  } catch {
    return undefined;
  }
}

export function commitReader(git: GitRepository, ref: string): ContentReader {
  return (path) => showJson(git, ref, path);
}

/** The staged index, as the commit-msg hook sees it. */
export function indexReader(git: GitRepository): ContentReader {
  return (path) => showJson(git, "", path);
}

export function workingReader(cwd: string): ContentReader {
  return async (path) => {
    try {
      return JSON.parse(await readFile(join(cwd, path), "utf8"));
    } catch {
      return undefined;
    }
  };
}

/** The approval policy as committed when the work opened; later edits to the spec cannot downgrade it. */
export async function committedApprovalPolicy(git: GitRepository, workId: string, ref = "HEAD"): Promise<OutcomeCheckpoint[]> {
  const open = await outcomeOpenCommit(git, workId, ref);
  if (!open) return [];
  const spec = await showJson(git, open.hash, outcomeSpecPath(workId)) as { policy?: { approvals?: unknown } } | undefined;
  const approvals = spec?.policy?.approvals;
  return approvalPolicyFailure(approvals) || approvals === undefined ? [] : approvals as OutcomeCheckpoint[];
}

/** Content a checkpoint approval covers: the committed input plus the reviews the transition records. */
export async function outcomeApprovalDigest(workId: string, checkpoint: OutcomeCheckpoint, attempt: number, inputCommit: string, read: ContentReader): Promise<string> {
  const paths = checkpoint === "close" ? [outcomeReviewPath(workId, attempt), outcomeMemoryReviewPath(workId, attempt)] : [outcomeReviewPath(workId, attempt)];
  const hash = createHash("sha256");
  const parts = ["ways-outcome-approval-v1", workId, checkpoint, String(attempt), inputCommit];
  for (const path of paths) {
    const value = await read(path);
    parts.push(path, value === undefined ? "" : stableJson(value));
  }
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}\0${part}`);
  return hash.digest("hex");
}

export function approvalAction(checkpoint: OutcomeCheckpoint): string {
  return `the human runs \`ways approve ${checkpoint}\` in their own terminal`;
}

/**
 * Verifies the approval a transition needs, when the committed policy requires
 * one. `input` is the commit the transition sits on; `read` yields the content
 * the transition records (working tree, index or the transition commit).
 */
export async function outcomeApprovalFailure(git: GitRepository, workId: string, checkpoint: OutcomeCheckpoint, attempt: number, input: string, read: ContentReader): Promise<string | undefined> {
  if (!(await committedApprovalPolicy(git, workId, input)).includes(checkpoint)) return undefined;
  const path = outcomeApprovalPath(workId, attempt, checkpoint);
  const record = await read(path);
  if (record === undefined) return `${checkpoint} requires human approval at ${path}; ${approvalAction(checkpoint)}`;
  if (!validateRecord(record)) return `approval at ${path} is invalid; ${approvalAction(checkpoint)}`;
  if (await showJson(git, input, path) !== undefined) return `approval at ${path} was already recorded and cannot be reused; ${approvalAction(checkpoint)}`;
  if (record.workId !== workId || record.checkpoint !== checkpoint || record.attempt !== attempt) {
    return `approval at ${path} belongs to another work, checkpoint or attempt; ${approvalAction(checkpoint)}`;
  }
  if (record.inputCommit !== input) return `approval of ${checkpoint} was given on another commit; ${approvalAction(checkpoint)} again`;
  if (record.digest !== await outcomeApprovalDigest(workId, checkpoint, attempt, input, read)) {
    return `content changed after approval of ${checkpoint}; ${approvalAction(checkpoint)} again`;
  }
  return undefined;
}

/** Throws with the exact human action when the active work lacks a valid approval for `checkpoint`. */
export async function assertOutcomeApproval(cwd: string, state: WorkState, checkpoint: OutcomeCheckpoint): Promise<void> {
  const git = new GitRepository(cwd);
  const failure = await outcomeApprovalFailure(git, state.id, checkpoint, state.attempt ?? 0, await git.head(), workingReader(cwd));
  if (failure) throw new Error(`Human approval missing: ${failure}`);
}

/** Checkpoints the active work could take now. */
async function reachableCheckpoints(git: GitRepository, state: WorkState): Promise<OutcomeCheckpoint[]> {
  if (state.stage === "evaluate") return ["close", "remediate"];
  const attempt = state.attempt ?? 0;
  const failed = await attemptFailureCommit(git, state.id, attempt);
  return failed && failed.hash === await git.head() ? ["remediate"] : [];
}

export interface OutcomeApprovalStatus {
  policy: OutcomeCheckpoint[] | "none";
  checkpoints: Array<{ checkpoint: OutcomeCheckpoint; status: "approved" | "required"; action?: string; reason?: string }>;
}

/** Approval state of the active outcome work for status and diagnostics. */
export async function outcomeApprovalStatus(cwd: string, state: WorkState): Promise<OutcomeApprovalStatus> {
  const git = new GitRepository(cwd);
  const policy = await committedApprovalPolicy(git, state.id);
  const status: OutcomeApprovalStatus = { policy: policy.length === 0 ? "none" : policy, checkpoints: [] };
  const head = await git.head();
  for (const checkpoint of await reachableCheckpoints(git, state)) {
    if (!policy.includes(checkpoint)) continue;
    const failure = await outcomeApprovalFailure(git, state.id, checkpoint, state.attempt ?? 0, head, workingReader(cwd));
    status.checkpoints.push(failure
      ? { checkpoint, status: "required", action: `ways approve ${checkpoint}`, reason: failure }
      : { checkpoint, status: "approved" });
  }
  return status;
}

/**
 * Interactive approval of an outcome checkpoint. Refuses without a real
 * terminal so an agent driving the CLI cannot approve on the human's behalf.
 */
export async function approveOutcomeInteractively(cwd: string, requested: string | undefined, terminal: Terminal = processTerminal()): Promise<OutcomeApprovalRecord> {
  if (!terminal.interactive) throw new Error("Approval requires an interactive terminal; the human must run `ways approve` themselves");
  const state = await loadState(cwd);
  if (!state || state.mode !== "outcome") throw new Error("No active outcome work");
  const git = new GitRepository(cwd);
  const policy = await committedApprovalPolicy(git, state.id);
  const reachable = (await reachableCheckpoints(git, state)).filter((checkpoint) => policy.includes(checkpoint));
  let checkpoint: OutcomeCheckpoint;
  if (requested !== undefined) {
    if (!(OUTCOME_CHECKPOINTS as readonly string[]).includes(requested)) throw new Error(`Unknown checkpoint ${requested}; use one of ${OUTCOME_CHECKPOINTS.join(", ")}`);
    checkpoint = requested as OutcomeCheckpoint;
    if (!policy.includes(checkpoint)) throw new Error(`Outcome ${state.id} does not require approval of ${checkpoint} (policy: ${policy.length > 0 ? policy.join(", ") : "none"})`);
    if (!reachable.includes(checkpoint)) throw new Error(`Outcome ${state.id} cannot take ${checkpoint} from ${state.stage}; nothing to approve yet`);
  } else if (reachable.length === 1) {
    checkpoint = reachable[0]!;
  } else if (reachable.length === 0) {
    throw new Error(`Outcome ${state.id} has no checkpoint awaiting approval (policy: ${policy.length > 0 ? policy.join(", ") : "none"})`);
  } else {
    throw new Error(`Choose the checkpoint to approve: ${reachable.map((name) => `ways approve ${name}`).join(" or ")}`);
  }
  const attempt = state.attempt ?? 0;
  const input = await git.head();
  const digest = await outcomeApprovalDigest(state.id, checkpoint, attempt, input, workingReader(cwd));
  terminal.say(`Outcome ${state.id}, checkpoint ${checkpoint}, attempt ${attempt}, input ${input.slice(0, 12)}, digest ${digest.slice(0, 12)}`);
  terminal.say(`Read ${outcomeSpecPath(state.id)}, the evaluation and review of attempt ${attempt} and the diff since opening before approving.`);
  const answer = await terminal.ask(`Type "${checkpoint}" to approve: `);
  if (answer.trim() !== checkpoint) throw new Error("Approval cancelled");
  const record: OutcomeApprovalRecord = {
    schemaVersion: 1, workId: state.id, checkpoint, attempt, inputCommit: input, digest,
    approvedBy: await approverIdentity(cwd), approvedAt: new Date().toISOString(),
  };
  await writeAtomic(join(cwd, outcomeApprovalPath(state.id, attempt, checkpoint)), stableJson(record));
  return record;
}
