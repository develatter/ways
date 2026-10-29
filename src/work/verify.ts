import { enforcementOf, loadConfig } from "../config/config.js";
import { WORK_DIR } from "../domain/constants.js";
import type { Evidence, IntegrityIssue, Strength, WorkRecord } from "../domain/types.js";
import { GitRepository } from "../git/git.js";
import { auditHistory, commitsAfter } from "../integrity/history.js";
import { gitDirs } from "../runtime/runtime.js";
import { evaluate, evidenceFailures, strengthSummary } from "./evaluate.js";
import { verifierCheckpoint } from "./policy.js";
import { committedRecord } from "./record.js";

/**
 * `ways verify --base=<sha>`: the CI's judgement of a range, re-run from
 * scratch rather than read from what the branch says about itself. It runs
 * the base's checks on the head in a clean checkout, re-runs every criterion
 * verifier of the works the range touched (green on the head, red on each
 * work's base), requires every changed existing test or check file in the
 * range to be covered by a closed work that got it approved or accepted, and
 * audits the records the range changed. The report says, per work, what
 * backs what was delivered.
 */
export interface VerifyReport {
  schemaVersion: 1;
  base: string;
  head: string;
  passed: boolean;
  /** Where it ran: a clean checkout, or the CI's own fresh checkout in place. */
  clean: boolean;
  checks: Evidence["checks"];
  failures: string[];
  tests: Evidence["tests"] | null;
  verifierChanges: { changed: string[]; uncovered: string[] };
  works: WorkReport[];
  /** Criteria across the range by the strength the re-run supports. */
  strength: Partial<Record<Strength, number>>;
  history: IntegrityIssue[];
  flaky: string[];
}

export interface WorkReport {
  id: string;
  kind: WorkRecord["kind"];
  state: "closed" | "open" | "blocked" | "cancelled";
  criteria: Array<{ id: string; text: string; strength: Strength; effective: Strength; recorded: string | null; now: string; base: string | null }>;
  /** Every criterion's verdict now matches the one recorded at close. */
  reproduced: boolean;
  summary: string;
  blocked?: string;
}

async function recordsChanged(git: GitRepository, base: string, head: string): Promise<string[]> {
  return (await git.run(["diff", "--name-only", base, head, "--", `${WORK_DIR}/`])).split("\n").filter((path) => path.endsWith(".json")).map((path) => path.slice(WORK_DIR.length + 1, -5));
}

function stateOf(record: WorkRecord): WorkReport["state"] {
  if (record.cancelled) return "cancelled";
  if (record.closed) return "closed";
  return record.blocked ? "blocked" : "open";
}

export async function verifyRange(cwd: string, options: { base: string; head?: string; inPlace?: boolean }): Promise<VerifyReport> {
  const { top } = gitDirs(cwd);
  const git = new GitRepository(top);
  const base = await git.resolveRef(options.base).catch(() => {
    throw new Error(`--base=${options.base} is not a commit here; in CI fetch the history (actions/checkout with fetch-depth: 0)`);
  });
  const head = await git.resolveRef(options.head ?? "HEAD");
  const inPlace = options.inPlace === true && head === await git.head() && (await git.dirtyPaths()).length === 0;
  const main = await evaluate({ cwd: top, git, base, criteria: [], input: head, mode: inPlace ? "fast" : "clean" });
  const failures = evidenceFailures(main);
  const works: WorkReport[] = [];
  const covered = new Set<string>();
  const counts: Partial<Record<Strength, number>> = {};
  const flaky = [...main.flaky ?? []];
  for (const id of await recordsChanged(git, base, head)) {
    const record = await committedRecord(git, id, head).catch(() => undefined);
    if (!record) continue;
    const state = stateOf(record);
    if (record.closed && record.evidence) for (const entry of verifierCheckpoint(record.evidence)) covered.add(entry);
    const report: WorkReport = { id, kind: record.kind, state, criteria: [], reproduced: true, summary: "", ...(record.blocked ? { blocked: record.blocked.reason } : {}) };
    if (state !== "cancelled" && record.criteria.length > 0) {
      const workBase = record.evidence?.base ?? base;
      const now = await evaluate({ cwd: top, git, base: workBase, criteria: record.criteria, work: id, input: head, mode: "clean", skipChecks: true });
      flaky.push(...(now.flaky ?? []).map((entry) => `${id}/${entry}`));
      for (const criterion of record.criteria) {
        const entry = now.criteria[criterion.id]!;
        const recorded = record.evidence?.criteria[criterion.id];
        const effective = entry.effective ?? (entry.status === "review-only" ? "review-only" : criterion.strength);
        counts[effective] = (counts[effective] ?? 0) + 1;
        if (recorded && recorded.status !== entry.status) report.reproduced = false;
        if (state === "closed" && entry.status === "failed") failures.push(`${id} ${criterion.id}: its verifier fails on ${head.slice(0, 12)} although the work closed`);
        if (state === "closed" && recorded?.effective && recorded.effective !== "review-only" && effective === "review-only") failures.push(`${id} ${criterion.id}: its verifier passes on the base ${workBase.slice(0, 12)} now, so it does not show the work did anything`);
        report.criteria.push({ id: criterion.id, text: criterion.text, strength: criterion.strength, effective, recorded: recorded?.status ?? null, now: entry.status, base: entry.baseline?.status ?? null });
      }
      report.summary = strengthSummary(now);
    }
    works.push(report);
  }
  const changed = verifierCheckpoint(main);
  const uncovered = changed.filter((entry) => !covered.has(entry));
  for (const entry of uncovered) {
    failures.push(entry === "tests-ran"
      ? `fewer tests ran than on the base (${main.tests?.ran} < ${main.tests?.baseline?.ran}) and no closed work in the range had that approved`
      : `${entry} is an existing test or check file the range modifies or deletes, and no closed work in the range had that approved or accepted by an independent review`);
  }
  let untraced = false;
  try {
    untraced = enforcementOf(await loadConfig(top)) === "enforce";
  } catch {
    // Integrity reports the configuration.
  }
  const history = await auditHistory(git, await commitsAfter(git, base, head), { untraced });
  for (const issue of history) failures.push(`history ${issue.code}: ${issue.path}: ${issue.message}`);
  return {
    schemaVersion: 1,
    base,
    head,
    passed: main.passed && failures.length === 0,
    clean: !inPlace,
    checks: main.checks,
    failures,
    tests: main.tests ?? null,
    verifierChanges: { changed, uncovered },
    works,
    strength: counts,
    history,
    flaky,
  };
}

export function renderVerifyMarkdown(report: VerifyReport): string {
  const lines = [
    `## ways verify: ${report.passed ? "passed" : "failed"}`,
    "",
    `Range \`${report.base.slice(0, 12)}..${report.head.slice(0, 12)}\`, checks of the base, ${report.clean ? "in a clean checkout" : "in the CI's fresh checkout"}.`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...report.checks.filter((check) => check.status !== "skipped").map((check) => `| ${check.name} | ${check.status}${check.tests ? `, ${check.tests} tests` : ""}${check.attempts ? `, ${check.attempts} attempts` : ""} |`),
  ];
  const total = Object.values(report.strength).reduce((sum, count) => sum + count, 0);
  if (total > 0) lines.push("", `**Backed by:** ${Object.entries(report.strength).map(([strength, count]) => `${count} ${strength}`).join(", ")} (${total} criteria).`);
  for (const work of report.works) {
    lines.push("", `### ${work.kind} ${work.id}: ${work.state}${work.reproduced ? "" : " (did not reproduce)"}`);
    if (work.blocked) lines.push("", `Blocked: ${work.blocked}`);
    if (work.criteria.length > 0) {
      lines.push("", "| Criterion | Strength | Recorded | Now | On the base |", "| --- | --- | --- | --- | --- |");
      for (const criterion of work.criteria) lines.push(`| ${criterion.id} ${criterion.text.replaceAll("|", "\\|")} | ${criterion.effective}${criterion.effective !== criterion.strength ? ` (declared ${criterion.strength})` : ""} | ${criterion.recorded ?? "—"} | ${criterion.now} | ${criterion.base ?? "—"} |`);
    }
  }
  if (report.verifierChanges.changed.length > 0) lines.push("", `Changed verifiers: ${report.verifierChanges.changed.join(", ")}${report.verifierChanges.uncovered.length > 0 ? `; **not approved:** ${report.verifierChanges.uncovered.join(", ")}` : " (all approved or accepted)"}.`);
  if (report.flaky.length > 0) lines.push("", `Flaky (passed on a retry): ${report.flaky.join(", ")}.`);
  if (report.failures.length > 0) lines.push("", "### Failures", "", ...report.failures.map((failure) => `- ${failure.replace(/\n/g, " ")}`));
  return `${lines.join("\n")}\n`;
}
