import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { defaultReview, loadConfig } from "../config/config.js";
import { assertWorkId, slugify, WAYS_DIR, workRecordPath } from "../domain/constants.js";
import { STRENGTHS, type ActiveWork, type ApprovalPolicy, type Criterion, type Evidence, type Review, type ReviewPolicy, type Strength, type WorkRecord } from "../domain/types.js";
import { validationDetails } from "../domain/validation.js";
import { GitRepository, parseTrailers } from "../git/git.js";
import { relevantConcepts, type RelevantConcept } from "../memory/memory.js";
import { appendRun, clearActive, clearRuns, gitDirs, readActive, readRuns, writeActive } from "../runtime/runtime.js";
import { formatCommandLine, parseCommandLine } from "./argv.js";
import { evaluate, evidenceFailures } from "./evaluate.js";
import { approvalDigest, approvalReasons, committedRecord, isOpen, openRecords, pending, recordIntroduction, reviewBlockers, reviewNotes, writeRecord, type Pending } from "./record.js";

const CRITERION_ID = /^[A-Z][A-Z0-9-]{0,31}$/;
const DEFAULT_BRANCHES = new Set(["main", "master", "trunk"]);

function repo(cwd: string): { top: string; git: GitRepository } {
  const { top } = gitDirs(cwd);
  return { top, git: new GitRepository(top) };
}

async function currentBranch(git: GitRepository): Promise<string | undefined> {
  try {
    return (await git.run(["symbolic-ref", "--quiet", "--short", "HEAD"])) || undefined;
  } catch {
    return undefined;
  }
}

/** A work id from the branch name, unless HEAD is detached or on a default branch. */
export async function idFromBranch(git: GitRepository): Promise<string | undefined> {
  const branch = await currentBranch(git);
  return branch && !DEFAULT_BRANCHES.has(branch) ? slugify(branch) : undefined;
}

export interface Resolved {
  active: ActiveWork;
  /** The committed record at HEAD; always present for an outcome. */
  record?: WorkRecord;
}

/**
 * The active work: the runtime pointer of this worktree (or the main one), or
 * else the single open record at HEAD, so a fresh clone or another worktree
 * finds an open outcome from Git alone. A pointer whose record was closed or
 * cancelled is cleared.
 */
export async function resolveActive(cwd: string): Promise<Resolved | undefined> {
  const { top, git } = repo(cwd);
  const pointer = readActive(top);
  if (pointer) {
    const record = await committedRecord(git, pointer.id);
    if (record && !isOpen(record)) {
      clearActive(top, pointer.id);
      return undefined;
    }
    if (pointer.kind === "outcome" && !record) {
      throw new Error(`Active outcome ${pointer.id} has no record at HEAD (${workRecordPath(pointer.id)}); switch back to its branch, or run \`ways cancel\` to forget it here`);
    }
    return { active: pointer, ...(record ? { record } : {}) };
  }
  const open = await openRecords(git);
  if (open.length === 0) return undefined;
  if (open.length > 1) throw new Error(`Several works are open at HEAD (${open.map((record) => record.id).join(", ")}); run \`ways start <id>\` with the one to continue`);
  const record = open[0]!;
  const introduced = await recordIntroduction(git, record.id);
  const base = record.evidence?.base ?? (introduced ? await git.parent(introduced) : await git.head());
  const active: ActiveWork = { schemaVersion: 1, id: record.id, kind: record.kind, base, startedAt: record.openedAt, origin: "outcome" };
  await writeActive(top, active);
  return { active, record };
}

async function assertBaseInHistory(git: GitRepository, active: ActiveWork): Promise<void> {
  if (!await git.isAncestor(active.base)) {
    throw new Error(`Work ${active.id} started at ${active.base.slice(0, 12)}, which is not in the history of HEAD (did you switch branch?); switch back, or run \`ways cancel\` and start again`);
  }
}

export async function startChange(cwd: string, requested?: string): Promise<ActiveWork> {
  const { top, git } = repo(cwd);
  const id = requested ?? await idFromBranch(git);
  if (!id) throw new Error("Give the work an id: `ways start <id>` (it is derived from the branch name only off main/master)");
  assertWorkId(id);
  const current = await resolveActive(top);
  if (current) {
    if (current.active.id === id) return current.active;
    throw new Error(`Work ${current.active.id} is already active; finish it with \`ways done\` or drop it with \`ways cancel\``);
  }
  if (await committedRecord(git, id)) throw new Error(`${workRecordPath(id)} already exists; choose another id`);
  const active: ActiveWork = { schemaVersion: 1, id, kind: "change", base: await git.head(), startedAt: new Date().toISOString(), origin: "start" };
  await writeActive(top, active);
  clearRuns(top, id);
  return active;
}

export interface CriterionInput {
  criteria: readonly string[];
  verify: readonly string[];
  strength: readonly string[];
}

function splitPrefixed(value: string, flag: string): [string, string] {
  const separator = value.indexOf(":");
  const id = value.slice(0, separator).trim();
  const rest = value.slice(separator + 1).trim();
  if (separator < 1 || !CRITERION_ID.test(id) || !rest) throw new Error(`${flag} must look like ${flag}=AC1:<value>, got "${value}"`);
  return [id, rest];
}

/** One-line criteria, each with its executable verifier and strength. */
export function buildCriteria(input: CriterionInput): Criterion[] {
  const criteria = new Map<string, Criterion>();
  for (const value of input.criteria) {
    const [id, text] = splitPrefixed(value, "--criterion");
    if (criteria.has(id)) throw new Error(`Criterion ${id} is given twice`);
    if (text.includes("\n")) throw new Error(`Criterion ${id} must fit on one line`);
    criteria.set(id, { id, text, strength: "review-only" });
  }
  if (criteria.size === 0) throw new Error("An outcome needs at least one --criterion=AC1:<one line that says what done means>");
  const known = (id: string, flag: string): Criterion => {
    const criterion = criteria.get(id);
    if (!criterion) throw new Error(`${flag} names ${id}, which is not a --criterion`);
    return criterion;
  };
  for (const value of input.verify) {
    const [id, command] = splitPrefixed(value, "--verify");
    const criterion = known(id, "--verify");
    if (criterion.verify) throw new Error(`Criterion ${id} has two --verify`);
    criterion.verify = parseCommandLine(command);
    criterion.strength = "test";
  }
  for (const value of input.strength) {
    const [id, strength] = splitPrefixed(value, "--strength");
    const criterion = known(id, "--strength");
    if (!(STRENGTHS as readonly string[]).includes(strength)) throw new Error(`--strength for ${id} must be one of ${STRENGTHS.join(", ")}`);
    if (strength === "review-only" && criterion.verify) throw new Error(`Criterion ${id} has a verifier, so it cannot be review-only`);
    if (strength !== "review-only" && !criterion.verify) throw new Error(`Criterion ${id} is ${strength} but has no --verify=${id}:<command>`);
    criterion.strength = strength as Strength;
  }
  return [...criteria.values()];
}

export interface OpenOptions extends CriterionInput {
  goal: string;
  review?: ReviewPolicy;
  approval?: ApprovalPolicy;
}

export async function openOutcome(cwd: string, id: string, options: OpenOptions): Promise<WorkRecord> {
  assertWorkId(id);
  const { top, git } = repo(cwd);
  const goal = options.goal.trim();
  if (!goal) throw new Error("An outcome needs --goal=<one line>");
  const criteria = buildCriteria(options);
  const current = await resolveActive(top);
  if (current) throw new Error(`Work ${current.active.id} is already active; finish it with \`ways done\` or drop it with \`ways cancel\` first`);
  if (await committedRecord(git, id)) throw new Error(`${workRecordPath(id)} already exists; choose another id`);
  const config = await loadConfig(top);
  const record: WorkRecord = {
    schemaVersion: 2,
    id,
    kind: "outcome",
    goal,
    criteria,
    policy: { review: options.review ?? defaultReview(config), approval: options.approval ?? "none" },
    openedAt: new Date().toISOString(),
  };
  const base = await git.head();
  const path = await writeRecord(top, record);
  await git.harnessCommit([path], `chore(ways): open ${id}`, { work: id, state: "opened" });
  await writeActive(top, { schemaVersion: 1, id, kind: "outcome", base, startedAt: record.openedAt, origin: "outcome" });
  clearRuns(top, id);
  return record;
}

/**
 * The evidence still certifies HEAD: no commit changed anything but the record
 * since its input. Uncommitted edits are not part of what closes; `done`
 * refuses them on its own.
 */
async function evidenceFresh(git: GitRepository, record: WorkRecord): Promise<boolean> {
  const evidence = record.evidence;
  if (!evidence) return false;
  try {
    const changed = (await git.run(["diff", "--name-only", evidence.input.commit, "HEAD", "--"])).split("\n").filter(Boolean);
    return changed.every((path) => path === workRecordPath(record.id));
  } catch {
    return false;
  }
}

export type DoneStatus = "failed" | "verifying" | "closed";

export interface DoneResult {
  id: string;
  kind: ActiveWork["kind"];
  status: DoneStatus;
  evidence: Evidence;
  pending: Pending;
  failures: string[];
  /** Commit the harness made for the record, if any. */
  commit?: string;
  commits: number;
  memory: RelevantConcept[];
}

async function changedPaths(git: GitRepository, base: string, head: string): Promise<string[]> {
  return (await git.run(["diff", "--name-only", base, head, "--"])).split("\n").filter((path) => path && !path.startsWith(`${WAYS_DIR}/`));
}

/**
 * Records the outcome of the latest passing evaluation and closes the work
 * when nothing is pending: one harness commit, or none for a change that
 * needs no approval.
 */
async function settle(top: string, git: GitRepository, active: ActiveWork, record: WorkRecord | undefined, evidence: Evidence): Promise<{ status: Exclude<DoneStatus, "failed">; pending: Pending; commit?: string; record?: WorkRecord }> {
  let next = record;
  if (!next) {
    // A change only gets a record when it must keep a human approval.
    const probe: WorkRecord = { schemaVersion: 2, id: active.id, kind: "change", criteria: [], policy: { review: "none", approval: "none" }, openedAt: active.startedAt, evidence };
    if (approvalReasons(probe, evidence).length === 0) {
      clearActive(top, active.id);
      return { status: "closed", pending: {} };
    }
    next = probe;
  }
  next = { ...next, evidence };
  if (next.review && next.review.commit !== evidence.input.commit) delete next.review;
  if (next.approval && next.approval.input !== evidence.input.commit) delete next.approval;
  const missing = pending(next);
  const closing = !missing.review && !missing.approval;
  if (closing) next.closed = { at: new Date().toISOString() };
  const previous = await committedRecord(git, active.id);
  let commit: string | undefined;
  if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
    const path = await writeRecord(top, next);
    commit = await git.harnessCommit([path], `chore(ways): ${closing ? "close" : "evidence for"} ${active.id}`, { work: active.id, state: closing ? "closed" : "verifying" });
  }
  if (closing) clearActive(top, active.id);
  return { status: closing ? "closed" : "verifying", pending: missing, ...(commit ? { commit } : {}), record: next };
}

/**
 * Finishes the active work: optionally commits what is left, runs integrity,
 * the checks and the criteria once on HEAD, records the evidence, and closes
 * when nothing is pending. After a failure the agent fixes and runs it again.
 */
export async function done(cwd: string, options: { message?: string } = {}): Promise<DoneResult> {
  const { top, git } = repo(cwd);
  let resolved = await resolveActive(top);
  const dirty = await git.dirtyPaths();
  if (!resolved) {
    const id = (options.message && dirty.length > 0) ? (await idFromBranch(git) ?? slugify(options.message)) : undefined;
    if (!id) throw new Error("No active work. Start one with `ways start <id>` (or just commit: in observe mode the first commit starts it), or open a delivery with `ways outcome open <id> --goal=... --criterion=AC1:...`");
    resolved = { active: await startChange(top, id) };
  }
  const { active } = resolved;
  await assertBaseInHistory(git, active);
  if (dirty.includes(workRecordPath(active.id))) throw new Error(`${workRecordPath(active.id)} has uncommitted edits; only ways writes it. Restore it with \`git checkout -- ${workRecordPath(active.id)}\``);
  if (dirty.length > 0) {
    if (!options.message?.trim()) {
      throw new Error(`Uncommitted changes:\n${dirty.map((path) => `  ${path}`).join("\n")}\nCommit them (the hook adds Harness-Work), or run \`ways done --message="<subject>"\` to commit them now.`);
    }
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", options.message.trim(), "-m", `Harness-Work: ${active.id}`]);
  }
  const record = await committedRecord(git, active.id);
  const commits = Number(await git.run(["rev-list", "--count", `${active.base}..HEAD`]));
  let evidence: Evidence;
  if (record?.evidence?.passed && await evidenceFresh(git, record)) {
    evidence = record.evidence;
  } else {
    if (active.kind === "change" && commits === 0) throw new Error(`Work ${active.id} has no commits yet; commit the change first, or \`ways cancel\` it`);
    evidence = await evaluate({ cwd: top, git, base: active.base, criteria: record?.criteria ?? [] });
    const failures = evidenceFailures(evidence);
    evidence.earlierRuns = readRuns(top, active.id);
    appendRun(top, active.id, { at: evidence.ranAt, input: evidence.input.commit, passed: evidence.passed, failed: failedNames(evidence) });
    if (!evidence.passed) {
      return { id: active.id, kind: active.kind, status: "failed", evidence, pending: {}, failures, commits, memory: [] };
    }
  }
  const settled = await settle(top, git, active, record, evidence);
  const changed = await changedPaths(git, active.base, evidence.input.commit);
  const touchedMemory = new Set((await git.run(["diff", "--name-only", active.base, evidence.input.commit, "--", `${WAYS_DIR}/knowledge`])).split("\n").filter(Boolean));
  const memory = (await relevantConcepts(top, changed)).filter((concept) => !touchedMemory.has(concept.path));
  return { id: active.id, kind: active.kind, status: settled.status, evidence, pending: settled.pending, failures: [], ...(settled.commit ? { commit: settled.commit } : {}), commits, memory };
}

function failedNames(evidence: Evidence): string[] {
  return [
    ...evidence.integrity.map((issue) => `integrity:${issue.code}`),
    ...(evidence.environment ?? []).filter((entry) => entry.status !== "passed").map((entry) => `${entry.kind}:${entry.name}`),
    ...evidence.checks.filter((check) => check.status !== "passed" && check.status !== "skipped").map((check) => `check:${check.name}`),
    ...Object.entries(evidence.criteria).filter(([, entry]) => entry.status === "failed").map(([id]) => id),
  ];
}

/** The verifying work: an open record whose passing evidence still certifies HEAD. */
async function verifyingRecord(cwd: string, action: string): Promise<{ top: string; git: GitRepository; active: ActiveWork; record: WorkRecord & { evidence: Evidence } }> {
  const { top, git } = repo(cwd);
  const resolved = await resolveActive(top);
  if (!resolved) throw new Error(`No active work to ${action}`);
  const record = resolved.record;
  if (!record?.evidence?.passed) throw new Error(`Work ${resolved.active.id} has no passing evidence yet; run \`ways done\` first`);
  if (!await evidenceFresh(git, record)) throw new Error(`Work ${record.id} changed after its evidence (commit ${record.evidence.input.commit.slice(0, 12)}); run \`ways done\` again first`);
  return { top, git, active: resolved.active, record: record as WorkRecord & { evidence: Evidence } };
}

/** Authors and committers of the increment's own commits (not the harness's record commits). */
async function implementers(git: GitRepository, base: string, input: string): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const hash of (await git.run(["rev-list", `${base}..${input}`])).split("\n").filter(Boolean)) {
    const [author = "", authorEmail = "", committer = "", committerEmail = "", body = ""] = (await git.run(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", hash])).split("\0");
    if (parseTrailers(body).state) continue;
    for (const identity of [author, authorEmail, committer, committerEmail]) if (identity.trim()) identities.add(identity.trim().toLowerCase());
  }
  return identities;
}

export interface ReviewOutcome {
  status: "closed" | "verifying";
  blockers: string[];
  notes: string[];
  pending: Pending;
  commit: string;
}

export async function submitReview(cwd: string, file: string): Promise<ReviewOutcome> {
  const { top, git, active, record } = await verifyingRecord(cwd, "review");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the review ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validationDetails("review", value).valid) {
    throw new Error(`Invalid review ${file}: ${validationDetails("review", value).errors.join("; ")}\nExpected {"reviewer": "<name>", "commit": "${record.evidence.input.commit}", "verdict": "pass"|"fail", "findings": [{"id", "severity": "critical|high|medium|low", "summary"}]}`);
  }
  const input = value as Omit<Review, "submittedAt">;
  let commit: string;
  try {
    commit = await git.run(["rev-parse", "--verify", "--quiet", `${input.commit}^{commit}`]);
  } catch {
    commit = "";
  }
  if (commit !== record.evidence.input.commit) {
    throw new Error(`The review is of ${input.commit.slice(0, 12)}, but the evaluated commit is ${record.evidence.input.commit.slice(0, 12)} (printed by \`ways done\`); review that commit and submit again`);
  }
  const reviewer = input.reviewer.trim();
  const known = await implementers(git, active.base, commit);
  const tokens = [reviewer, ...(/^(.*)<([^>]+)>\s*$/.exec(reviewer)?.slice(1) ?? [])].map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.some((token) => known.has(token))) throw new Error(`Reviewer "${reviewer}" authored or committed this increment; the review must come from someone else (e.g. the ways-reviewer agent in a fresh session)`);
  const next: WorkRecord = { ...record, review: { reviewer, commit, verdict: input.verdict, findings: input.findings, submittedAt: new Date().toISOString() } };
  delete next.approval;
  const missing = pending(next);
  const closing = !missing.review && !missing.approval;
  if (closing) next.closed = { at: new Date().toISOString() };
  const path = await writeRecord(top, next);
  const made = await git.harnessCommit([path], `chore(ways): ${closing ? "close" : "review of"} ${record.id}`, { work: record.id, state: closing ? "closed" : "reviewed" });
  if (closing) {
    clearActive(top, record.id);
  }
  return { status: closing ? "closed" : "verifying", blockers: reviewBlockers(next.review!), notes: reviewNotes(next.review!), pending: missing, commit: made };
}

export interface Terminal {
  interactive: boolean;
  ask(question: string): Promise<string>;
  say(line: string): void;
}

export function processTerminal(): Terminal {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    say(line) {
      console.log(line);
    },
  };
}

async function approverIdentity(git: GitRepository): Promise<string> {
  try {
    const name = await git.run(["config", "user.name"]);
    const email = await git.run(["config", "user.email"]).catch(() => "");
    if (name && email) return `${name} <${email}>`;
    if (name) return name;
  } catch {
    // Fall back to the OS user.
  }
  return userInfo().username;
}

/**
 * Human approval. Refuses without a real terminal so an agent driving the CLI
 * through a tool cannot approve; the human sees what they approve and types
 * the work id. It comes last: after a passing evidence and any review.
 */
export async function approve(cwd: string, terminal: Terminal = processTerminal()): Promise<{ status: "closed" | "verifying"; pending: Pending; commit: string }> {
  if (!terminal.interactive) throw new Error("Approval needs a human at an interactive terminal; ask the human to run `ways approve` themselves");
  const { top, git, record } = await verifyingRecord(cwd, "approve");
  const reasons = approvalReasons(record, record.evidence);
  if (reasons.length === 0) throw new Error(`Work ${record.id} needs no human approval`);
  const before = pending(record);
  if (!before.approval) throw new Error(`Work ${record.id} is already approved for ${record.evidence.input.commit.slice(0, 12)}`);
  if (before.review) throw new Error(`Approval comes last: ${before.review}. Submit the review first (\`ways review submit <file>\`)`);
  terminal.say(`Work ${record.id} (${record.kind})${record.goal ? `: ${record.goal}` : ""}`);
  for (const criterion of record.criteria) {
    const entry = record.evidence.criteria[criterion.id];
    terminal.say(`  ${criterion.id} ${criterion.text} — ${entry?.status ?? "?"} [${criterion.strength}${criterion.verify ? `: ${formatCommandLine(criterion.verify)}` : ""}]`);
  }
  terminal.say(`Evaluated commit ${record.evidence.input.commit.slice(0, 12)} (base ${record.evidence.base.slice(0, 12)}); checks ${record.evidence.passed ? "passed" : "failed"}.`);
  if (record.review) terminal.say(`Review by ${record.review.reviewer}: ${record.review.verdict}.`);
  for (const reason of reasons) terminal.say(`Needs approval because ${reason}.`);
  terminal.say(`Inspect it with: git diff ${record.evidence.base.slice(0, 12)} ${record.evidence.input.commit.slice(0, 12)}`);
  const answer = await terminal.ask(`Type "${record.id}" to approve: `);
  if (answer.trim() !== record.id) throw new Error("Approval cancelled; nothing was recorded");
  const next: WorkRecord = { ...record, approval: { by: await approverIdentity(git), at: new Date().toISOString(), input: record.evidence.input.commit, digest: approvalDigest(record), reasons } };
  const missing = pending(next);
  const closing = !missing.review && !missing.approval;
  if (closing) next.closed = { at: new Date().toISOString() };
  const path = await writeRecord(top, next);
  const commit = await git.harnessCommit([path], `chore(ways): ${closing ? "close" : "approval of"} ${record.id}`, { work: record.id, state: closing ? "closed" : "approved" });
  if (closing) {
    clearActive(top, record.id);
  }
  return { status: closing ? "closed" : "verifying", pending: missing, commit };
}

/** Drops the active work. A committed record is marked cancelled; commits stay as they are. */
export async function cancel(cwd: string): Promise<{ id: string; commit?: string }> {
  const { top, git } = repo(cwd);
  const pointer = readActive(top);
  let resolved: Resolved | undefined;
  try {
    resolved = await resolveActive(top);
  } catch (error) {
    // A pointer whose record is missing at HEAD is exactly what cancel clears.
    if (!pointer) throw error;
    clearActive(top, pointer.id);
    clearRuns(top, pointer.id);
    return { id: pointer.id };
  }
  if (!resolved) throw new Error("No active work to cancel");
  const { active, record } = resolved;
  let commit: string | undefined;
  if (record && isOpen(record)) {
    const path = await writeRecord(top, { ...record, cancelled: { at: new Date().toISOString() } });
    commit = await git.harnessCommit([path], `chore(ways): cancel ${active.id}`, { work: active.id, state: "cancelled" });
  }
  clearActive(top, active.id);
  clearRuns(top, active.id);
  return { id: active.id, ...(commit ? { commit } : {}) };
}
