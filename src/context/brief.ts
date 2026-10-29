import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH, isWorkId, WAYS_DIR, WORK_DIR } from "../domain/constants.js";
import type { Enforcement, WorkRecord } from "../domain/types.js";
import { fastHash } from "../runtime/lazy.js";
import { currentBranchOf, headCommitOf, readActive, readLastRun, writeFileAtomic, type GitDirs, type LastRun } from "../runtime/runtime.js";
import { isOpen, pending, type Pending } from "../work/policy.js";
import { contextCachePath, git, loadMemory, ordinal, safeMatch, type MemoryFact } from "./memory.js";

/**
 * The context brief: a short, deterministic description of the state an agent
 * works in. The active work and its criteria, what fails now, what is waiting
 * on whom, the next command, and the memory of the code in play. It states
 * facts, not procedure: AGENTS.md is the project map, and ways' own workflow
 * is one line of `Next:`.
 *
 * It is built on agent hooks, so it reads files and spawns git only when the
 * repository changed since the last build (see `gitFacts`). No ajv, no yaml
 * unless the memory cache is stale.
 */
export const BRIEF_MAX_CHARS = 6000;
export const MAX_MEMORY = 5;
const MAX_CRITERIA = 12;
/** Failing items listed, and output lines kept for each. */
const MAX_FAILURE_LINES = 12;
const TAIL_LINES = 3;
const LINE_CHARS = 220;

export type SectionId = "problem" | "work" | "failing" | "waiting" | "next" | `memory:${string}`;

export interface BriefSection {
  id: SectionId;
  text: string;
}

/** Something that stands between the work and close. `agent` can act on it; `human` cannot be done by the agent. */
export interface Blocker {
  key: string;
  who: "agent" | "human";
  text: string;
}

export interface Brief {
  /** False when ways is not installed in this repository: hooks stay silent. */
  installed: boolean;
  branch: string | null;
  work: { id: string; kind: string } | null;
  sections: BriefSection[];
  blockers: Blocker[];
  next: string | null;
  memory: MemoryFact[];
}

export interface BriefOptions {
  /** Paths the agent touched in this session, most recent first. */
  touched?: readonly string[];
  /** Cap the rendered text at BRIEF_MAX_CHARS and the memory at MAX_MEMORY (the default). */
  brief?: boolean;
}

function clip(text: string, max = LINE_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function short(commit: string | undefined | null): string {
  return commit ? commit.slice(0, 12) : "?";
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function enforcementOf(top: string): Enforcement | undefined {
  try {
    const config = readJson(join(top, CONFIG_PATH)) as { enforcement?: unknown };
    return config.enforcement === "enforce" ? "enforce" : "observe";
  } catch {
    return undefined;
  }
}

/** A light shape check: enough for a brief; `ways done` validates records against the schema. */
function asRecord(value: unknown): WorkRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<WorkRecord>;
  if (typeof record.id !== "string" || (record.kind !== "outcome" && record.kind !== "change") || !Array.isArray(record.criteria) || !record.policy || typeof record.policy !== "object") return undefined;
  return value as WorkRecord;
}

function recordInTree(top: string, id: string): WorkRecord | undefined {
  try {
    return asRecord(readJson(join(top, WORK_DIR, `${id}.json`)));
  } catch {
    return undefined;
  }
}

function openRecordsInTree(top: string): WorkRecord[] {
  let names: string[];
  try {
    names = readdirSync(join(top, WORK_DIR)).filter((name) => name.endsWith(".json") && isWorkId(name.slice(0, -5)));
  } catch {
    return [];
  }
  return names.sort().map((name) => recordInTree(top, name.slice(0, -5))).filter((record): record is WorkRecord => record !== undefined && isOpen(record));
}

interface GitFacts {
  uncommitted: string[];
  changed: string[];
  /** HEAD differs from the evidence input only by the record, and nothing is uncommitted. */
  fresh: boolean;
}

function statStamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "-";
  }
}

/**
 * What only git can say (uncommitted files, files changed since the base,
 * whether the evidence still certifies HEAD), cached per worktree and keyed by
 * HEAD, the index and the number of paths the session touched. Edits made
 * outside the agent's file tools show up at the next `git add` or commit.
 */
async function gitFacts(dirs: GitDirs, head: string | undefined, base: string | undefined, input: string | undefined, recordPath: string | undefined, touched: number): Promise<GitFacts> {
  const key = fastHash([head, statStamp(join(dirs.gitDir, "index")), base, input, recordPath, touched].join("\n"));
  const path = contextCachePath(dirs, "git");
  try {
    const cached = readJson(path) as { key?: string; facts?: GitFacts };
    if (cached.key === key && cached.facts) return cached.facts;
  } catch {
    // No cache yet.
  }
  const [status, changed, sinceInput] = await Promise.all([
    // Without --no-optional-locks, status rewrites the index, which would change the cache key on every call.
    git(dirs.top, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"]).catch(() => ""),
    head && base ? git(dirs.top, ["diff", "--name-only", "--no-renames", base, "HEAD", "--"]).catch(() => "") : Promise.resolve(""),
    head && input ? git(dirs.top, ["diff", "--name-only", "--no-renames", input, "HEAD", "--"]).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  const uncommitted: string[] = [];
  const records = status.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    uncommitted.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C") index += 1;
  }
  const facts: GitFacts = {
    uncommitted: [...new Set(uncommitted)].sort(),
    changed: changed.split("\n").filter((file) => file && !file.startsWith(`${WAYS_DIR}/`)),
    fresh: sinceInput !== undefined && uncommitted.length === 0 && sinceInput.split("\n").filter(Boolean).every((file) => file === recordPath),
  };
  try {
    writeFileAtomic(path, JSON.stringify({ key, facts }));
  } catch {
    // The cache is an optimisation.
  }
  return facts;
}

/**
 * Ranks the concepts covering the paths in play: touched this session (most
 * recent first), then uncommitted, then changed by the work; within that, the
 * more specific glob first, then fresh before possibly stale.
 */
export function relevantMemory(concepts: readonly MemoryFact[], inPlay: { touched: readonly string[]; uncommitted: readonly string[]; changed: readonly string[] }, limit = MAX_MEMORY): MemoryFact[] {
  const scored: Array<{ concept: MemoryFact; score: number; specificity: number }> = [];
  for (const concept of concepts) {
    const touchedAt = inPlay.touched.findIndex((path) => safeMatch(path, concept.paths));
    let score = 0;
    if (touchedAt >= 0) score = 3000 - Math.min(touchedAt, 999);
    else if (inPlay.uncommitted.some((path) => safeMatch(path, concept.paths))) score = 2000;
    else if (inPlay.changed.some((path) => safeMatch(path, concept.paths))) score = 1000;
    if (score === 0) continue;
    const specificity = Math.max(...concept.paths.map((glob) => glob.split(/[*?]/, 1)[0]!.length));
    scored.push({ concept, score, specificity });
  }
  scored.sort((a, b) => b.score - a.score || b.specificity - a.specificity || Number(a.concept.stale) - Number(b.concept.stale) || ordinal(a.concept.path, b.concept.path));
  return scored.slice(0, limit).map((entry) => entry.concept);
}

export function renderMemory(concept: MemoryFact): string {
  const stale = concept.stale ? " (possibly stale: its code changed after it was written)" : "";
  const lines = concept.fact.split("\n");
  // `ways remember` writes the fact as the body and its first line as the title.
  const body = lines[0]?.startsWith(concept.title.replace(/…$/, "")) ? lines : [concept.title, ...lines];
  return [`- [${concept.type}] ${body[0]} — ${concept.paths.join(", ")} (${concept.path})${stale}`, ...body.slice(1).map((line) => `  ${line}`)].join("\n");
}

/**
 * Every failing item `ways done` printed (a headline), each with only the
 * last lines of its output: what fails comes before why.
 */
export function failureSummary(failures: readonly string[]): string[] {
  const blocks: Array<{ headline: string; tail: string[] }> = [];
  for (const line of failures) {
    if (/^\s/.test(line) && blocks.length > 0) blocks.at(-1)!.tail.push(line.trim());
    else blocks.push({ headline: line, tail: [] });
  }
  const lines: string[] = [];
  for (const block of blocks.slice(0, MAX_FAILURE_LINES)) {
    lines.push(`- ${clip(block.headline)}`);
    for (const line of block.tail.filter(Boolean).slice(-TAIL_LINES)) lines.push(`    ${clip(line, 160)}`);
  }
  if (blocks.length > MAX_FAILURE_LINES) lines.push(`- … ${blocks.length - MAX_FAILURE_LINES} more (\`ways status\`)`);
  return lines;
}

/** From the evidence when it certifies HEAD, else from the last run on HEAD (failed runs leave no evidence). */
function criterionResult(record: WorkRecord, id: string, fresh: boolean, lastRun: LastRun | undefined, head: string | undefined): string {
  const entry = fresh ? record.evidence?.criteria[id] : undefined;
  if (entry) return entry.status === "review-only" ? "needs review" : entry.status;
  if (!lastRun || lastRun.input !== head) return "not run on HEAD";
  if (lastRun.failures.some((line) => line.startsWith(`criterion ${id} `))) return "failed";
  return record.criteria.find((criterion) => criterion.id === id)?.strength === "review-only" ? "needs review" : "passed";
}

function nextCommand(work: { record: WorkRecord | undefined; base: string | undefined }, facts: GitFacts, lastRun: LastRun | undefined, head: string | undefined, missing: Pending): string {
  // No file count here: the line would change, and be injected again, with every edit.
  if (facts.uncommitted.length > 0) return "commit what is uncommitted, then `ways done`";
  const record = work.record;
  if (!facts.fresh || !record?.evidence) {
    if (lastRun && !lastRun.passed && lastRun.input === head) return "fix what fails, commit, then `ways done`";
    return "`ways done` when the work is finished";
  }
  const input = record.evidence.input.commit;
  if (missing.review) return `an independent read-only review of \`git diff ${short(record.evidence.base)} ${short(input)}\` (e.g. the ways-reviewer agent), then \`ways review submit <file>\` with {"reviewer", "commit": "${input}", "verdict", "findings"}`;
  if (missing.approval) return "the human runs `ways approve` in their own terminal";
  return "`ways done` to close";
}

/** Builds the brief for the worktree at `dirs`. */
export async function buildBrief(dirs: GitDirs, options: BriefOptions = {}): Promise<Brief> {
  const touched = options.touched ?? [];
  const branch = currentBranchOf(dirs) ?? null;
  const brief: Brief = { installed: false, branch, work: null, sections: [], blockers: [], next: null, memory: [] };
  if (!enforcementOf(dirs.top)) return brief;
  brief.installed = true;
  const head = headCommitOf(dirs);

  let record: WorkRecord | undefined;
  let base: string | undefined;
  let id: string | undefined;
  let kind: string | undefined;
  const pointer = readActive(dirs.top);
  if (pointer) {
    record = recordInTree(dirs.top, pointer.id);
    if (record && !isOpen(record)) record = undefined;
    else {
      ({ id, kind, base } = pointer);
      if (pointer.kind === "outcome" && !record) brief.sections.push({ id: "problem", text: `Problem: active outcome ${pointer.id} has no record in this checkout (${WORK_DIR}/${pointer.id}.json); switch back to its branch or \`ways cancel\`.` });
    }
  }
  if (!id) {
    const open = openRecordsInTree(dirs.top);
    if (open.length === 1) {
      record = open[0]!;
      ({ id, kind } = record);
      base = record.evidence?.base;
    } else if (open.length > 1) {
      brief.sections.push({ id: "problem", text: `Problem: several works are open here (${open.map((entry) => entry.id).join(", ")}); \`ways start <id>\` picks one.` });
    }
  }

  const recordPath = id ? `${WORK_DIR}/${id}.json` : undefined;
  const facts = await gitFacts(dirs, head, base, record?.evidence?.input.commit, recordPath, touched.length);
  const all = await loadMemory(dirs);
  const limit = options.brief === false ? Number.POSITIVE_INFINITY : MAX_MEMORY;
  brief.memory = relevantMemory(all, { touched, uncommitted: facts.uncommitted, changed: id ? facts.changed : [] }, limit);

  if (id && kind) {
    brief.work = { id, kind };
    const lastRun = readLastRun(dirs.top, id);
    const missing = record && facts.fresh ? pending(record) : {};
    const goal = record?.goal ? ` — ${clip(record.goal)}` : "";
    const where = [branch ? `branch ${branch}` : undefined, base ? `base ${short(base)}` : undefined].filter(Boolean).join(", ");
    const work = [`Work: ${kind} ${id}${goal}${where ? ` (${where})` : ""}`];
    const criteria = record?.criteria ?? [];
    for (const criterion of criteria.slice(0, options.brief === false ? criteria.length : MAX_CRITERIA)) {
      work.push(`- ${criterion.id} [${criterion.strength}] ${criterionResult(record!, criterion.id, facts.fresh, lastRun, head)}: ${clip(criterion.text, 160)}`);
    }
    if (criteria.length > MAX_CRITERIA && options.brief !== false) work.push(`- … ${criteria.length - MAX_CRITERIA} more criteria (\`ways status\`)`);
    if (record?.evidence && facts.fresh) work.push(`Evaluated: ${record.evidence.passed ? "passed" : "failed"} on ${short(record.evidence.input.commit)}.`);
    brief.sections.push({ id: "work", text: work.join("\n") });

    if (lastRun && !lastRun.passed) {
      const where = lastRun.input === head ? "HEAD" : "an earlier commit";
      brief.sections.push({ id: "failing", text: [`Failing: the last \`ways done\` ran on ${short(lastRun.input)} (${where}):`, ...failureSummary(lastRun.failures)].join("\n") });
      if (lastRun.input === head) brief.blockers.push({ key: `failing:${lastRun.input}`, who: "agent", text: `the last \`ways done\` failed on HEAD (${short(lastRun.input)}), so ${id} is not done` });
    }

    const input = record?.evidence?.input.commit;
    const waiting: string[] = [];
    if (missing.review) {
      waiting.push(`an independent review of ${short(input)} (${missing.review})`);
      brief.blockers.push({ key: `review:${input}`, who: "agent", text: `${id} passed its checks on ${short(input)} but is not closed: ${missing.review}` });
    }
    if (missing.approval) {
      waiting.push(`the human's approval, because ${missing.approval}; only the human can run \`ways approve\``);
      brief.blockers.push({ key: `approval:${input}`, who: "human", text: `${id} is waiting for your approval (${missing.approval}): run \`ways approve\` in your terminal` });
    }
    if (waiting.length > 0) brief.sections.push({ id: "waiting", text: `Waiting on: ${waiting.join("; ")}.` });
    brief.next = nextCommand({ record, base }, facts, lastRun, head, missing);
    brief.sections.push({ id: "next", text: `Next: ${brief.next}.` });
  }

  for (const concept of brief.memory) brief.sections.push({ id: `memory:${concept.path}`, text: renderMemory(concept) });
  return brief;
}

export const MEMORY_HEADING = "Memory for the code in play (short facts from .ways/knowledge; fix a concept in the same commit when it no longer holds):";

/** Renders sections in order under the character budget; memory goes last and is dropped first. */
export function renderSections(sections: readonly BriefSection[], max = BRIEF_MAX_CHARS): string {
  const parts: string[] = [];
  let size = 0;
  let memoryHeading = false;
  for (const section of sections) {
    const isMemory = section.id.startsWith("memory:");
    const text = isMemory && !memoryHeading ? `${MEMORY_HEADING}\n${section.text}` : section.text;
    const cost = text.length + (parts.length > 0 ? 1 : 0);
    if (size + cost > max) {
      if (isMemory) continue;
      const room = max - size - (parts.length > 0 ? 2 : 1);
      if (room > 40) parts.push(`${text.slice(0, room)}…`);
      break;
    }
    if (isMemory) memoryHeading = true;
    parts.push(text);
    size += cost;
  }
  return parts.join("\n");
}

export function renderBrief(brief: Brief, max = BRIEF_MAX_CHARS): string {
  return renderSections(brief.sections, max);
}
