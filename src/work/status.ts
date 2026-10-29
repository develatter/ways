import { loadConfig, enforcementOf } from "../config/config.js";
import { WAYS_DIR } from "../domain/constants.js";
import type { EarlierRun, Enforcement, Strength } from "../domain/types.js";
import { GitRepository } from "../git/git.js";
import { relevantConcepts, type RelevantConcept } from "../memory/memory.js";
import { gitDirs, readRuns } from "../runtime/runtime.js";
import { HARNESS_VERSION } from "../version.js";
import { formatCommandLine } from "./argv.js";
import { pending, reviewBlockers, reviewNotes, type Pending } from "./record.js";
import { openWorkIds, resolveActive } from "./work.js";

/**
 * A short, deterministic packet: what is active, what "done" means for it,
 * what the last run said, what is still missing, the next command, and the
 * memory of the code being changed. `ways status` prints it; `--json` emits it.
 */
export interface StatusPacket {
  schemaVersion: 2;
  version: string;
  enforcement: Enforcement | null;
  head: string | null;
  branch: string | null;
  problem: string | null;
  active: ActiveStatus | null;
  next: string;
  memory: RelevantConcept[];
}

export interface ActiveStatus {
  id: string;
  kind: "outcome" | "change";
  base: string;
  commits: number;
  uncommitted: string[];
  goal: string | null;
  criteria: Array<{ id: string; text: string; strength: Strength; verify: string | null; result: "passed" | "failed" | "review-only" | "not run" }>;
  evidence: { input: string; passed: boolean; fresh: boolean; ranAt: string } | null;
  lastRun: EarlierRun | null;
  review: { reviewer: string; verdict: "pass" | "fail"; blockers: string[]; notes: string[]; fresh: boolean } | null;
  pending: Pending;
}

async function tryRun(git: GitRepository, args: readonly string[]): Promise<string | undefined> {
  try {
    return await git.run(args);
  } catch {
    return undefined;
  }
}

export async function buildStatus(cwd: string): Promise<StatusPacket> {
  const { top } = gitDirs(cwd);
  const git = new GitRepository(top);
  const head = (await tryRun(git, ["rev-parse", "--verify", "-q", "HEAD"])) || null;
  const branch = (await tryRun(git, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  let enforcement: Enforcement | null = null;
  let problem: string | null = null;
  try {
    enforcement = enforcementOf(await loadConfig(top));
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  const packet: StatusPacket = { schemaVersion: 2, version: HARNESS_VERSION, enforcement, head, branch, problem, active: null, next: "", memory: [] };
  if (!head) {
    packet.next = "Make a first commit, then run `ways bootstrap`.";
    return packet;
  }
  let resolved;
  try {
    resolved = await resolveActive(top);
  } catch (error) {
    packet.problem = error instanceof Error ? error.message : String(error);
    packet.next = "Resolve the problem above (usually `ways cancel`).";
    return packet;
  }
  const uncommitted = await git.dirtyPaths();
  const open = resolved ? [] : await openWorkIds(top);
  if (!resolved && open.length > 1) {
    packet.problem = `Several works are open at HEAD: ${open.join(", ")}`;
    packet.next = `Continue one with \`ways start <id>\` (${open.map((id) => `\`ways start ${id}\``).join(" or ")}).`;
    return packet;
  }
  if (!resolved) {
    packet.next = enforcement === "enforce"
      ? "Start work with `ways start <id>` (small change) or `ways outcome open <id> --goal=... --criterion=AC1:... --verify=AC1:<command>`; commits outside a work are refused."
      : "Just work and commit: the first commit starts a change from the branch name; run `ways done` when finished. For a delivery with criteria: `ways outcome open <id> --goal=... --criterion=AC1:... --verify=AC1:<command>`.";
    if (uncommitted.length > 0) packet.memory = await relevantConcepts(top, uncommitted.filter((path) => !path.startsWith(`${WAYS_DIR}/`)));
    return packet;
  }
  const { active, record } = resolved;
  const commits = Number(await tryRun(git, ["rev-list", "--count", `${active.base}..HEAD`]) ?? "0");
  const evidence = record?.evidence;
  const fresh = Boolean(evidence && head && (await tryRun(git, ["diff", "--name-only", evidence.input.commit, "HEAD", "--"]))?.split("\n").filter(Boolean)
    .every((path) => path === `${WAYS_DIR}/work/${active.id}.json`) && uncommitted.length === 0);
  const runs = readRuns(top, active.id);
  const lastRun = runs.at(-1) ?? null;
  const missing = record && fresh ? pending(record) : {};
  const review = record?.review;
  packet.active = {
    id: active.id,
    kind: active.kind,
    base: active.base,
    commits,
    uncommitted,
    goal: record?.goal ?? null,
    criteria: (record?.criteria ?? []).map((criterion) => {
      const entry = fresh ? evidence?.criteria[criterion.id] : undefined;
      return { id: criterion.id, text: criterion.text, strength: criterion.strength, verify: criterion.verify ? formatCommandLine(criterion.verify) : null, result: entry?.status ?? "not run" };
    }),
    evidence: evidence ? { input: evidence.input.commit, passed: evidence.passed, fresh, ranAt: evidence.ranAt } : null,
    lastRun,
    review: review ? { reviewer: review.reviewer, verdict: review.verdict, blockers: reviewBlockers(review), notes: reviewNotes(review), fresh: fresh && review.commit === evidence?.input.commit } : null,
    pending: missing,
  };
  if (uncommitted.length > 0) packet.next = "Commit your changes (the hook adds Harness-Work), then run `ways done`; or `ways done --message=\"<subject>\"`.";
  else if (!fresh) packet.next = lastRun && !lastRun.passed && lastRun.input === head ? `Fix what failed (${lastRun.failed.join(", ") || "see the last run"}), commit, then run \`ways done\` again.` : "Run `ways done` when the work is finished.";
  else if (missing.review) packet.next = `${missing.review}: have a reviewer in a fresh read-only session (e.g. the ways-reviewer agent) review \`git diff ${active.base.slice(0, 12)} ${evidence!.input.commit.slice(0, 12)}\` against the criteria, write {"reviewer", "commit": "${evidence!.input.commit}", "verdict", "findings"} to a file outside .ways/work, then run \`ways review submit <file>\`.`;
  else if (missing.approval) packet.next = `Human approval needed (${missing.approval}): ask the human to run \`ways approve\` in their own terminal.`;
  else packet.next = "Run `ways done` to close.";
  const changed = (await tryRun(git, ["diff", "--name-only", active.base, "--"]))?.split("\n").filter((path) => path && !path.startsWith(`${WAYS_DIR}/`)) ?? [];
  packet.memory = await relevantConcepts(top, [...new Set([...changed, ...uncommitted])]);
  return packet;
}

export function renderStatus(packet: StatusPacket): string {
  const lines = [`ways ${packet.version}${packet.enforcement ? ` · enforcement: ${packet.enforcement}` : ""}${packet.branch ? ` · branch ${packet.branch}` : ""}`];
  if (packet.problem) lines.push(`Problem: ${packet.problem}`);
  const active = packet.active;
  if (!active) lines.push("No active work.");
  else {
    lines.push(`Active: ${active.kind} ${active.id}${active.goal ? ` — ${active.goal}` : ""} (${active.commits} commit${active.commits === 1 ? "" : "s"} since ${active.base.slice(0, 12)})`);
    for (const criterion of active.criteria) {
      lines.push(`  ${criterion.id} ${criterion.text}  [${criterion.strength}${criterion.verify ? `: ${criterion.verify}` : ""}] ${criterion.result}`);
    }
    if (active.evidence) lines.push(`Evidence: ${active.evidence.passed ? "passed" : "failed"} on ${active.evidence.input.slice(0, 12)}${active.evidence.fresh ? "" : " (stale: HEAD changed since)"}`);
    else if (active.lastRun) lines.push(`Last run: ${active.lastRun.passed ? "passed" : `failed (${active.lastRun.failed.join(", ")})`} on ${active.lastRun.input.slice(0, 12)}`);
    if (active.review) {
      lines.push(`Review: ${active.review.verdict} by ${active.review.reviewer}${active.review.fresh ? "" : " (stale)"}${active.review.blockers.length > 0 ? `, blocked by ${active.review.blockers.join(", ")}` : ""}`);
      for (const note of active.review.notes) lines.push(`  note ${note}`);
    }
    if (active.uncommitted.length > 0) lines.push(`Uncommitted: ${active.uncommitted.join(", ")}`);
  }
  if (packet.memory.length > 0) {
    lines.push("Memory for the code you are changing:");
    for (const concept of packet.memory) lines.push(`  ${concept.path} — ${concept.title}${concept.stale ? " (possibly stale)" : ""}`);
  }
  lines.push(`Next: ${packet.next}`);
  return `${lines.join("\n")}\n`;
}
