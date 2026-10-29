import { enforcementOf, loadConfig, verifierPaths } from "../config/config.js";
import { WORK_DIR } from "../domain/constants.js";
import type { Evidence, HarnessConfig, IntegrityIssue, Strength, WorkRecord } from "../domain/types.js";
import { GitRepository } from "../git/git.js";
import { auditHistory, commitsAfter } from "../integrity/history.js";
import { gitDirs } from "../runtime/runtime.js";
import { baseConfig, baseTestMarkers, baseVerifierPaths, evaluate, evidenceFailures, strengthSummary, TESTS_RAN, verifierChanges } from "./evaluate.js";
import { pending, verifierCheckpoint } from "./policy.js";
import { committedRecord } from "./record.js";

/**
 * `ways verify --base=<sha>`: the CI's judgement of a range, re-run from
 * scratch rather than read from what the branch says about itself. It runs
 * the base's checks on the head in a clean checkout, re-runs every criterion
 * verifier of the works the range touched (green on the head, red on each
 * work's base), requires every entry of the range's verifier checkpoint to be
 * covered by a closed work that got that very content approved or accepted,
 * and audits the records the range changed. The report says, per work, what
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
  const covering: Evidence[] = [];
  const counts: Partial<Record<Strength, number>> = {};
  const flaky = [...main.flaky ?? []];
  for (const id of await recordsChanged(git, base, head)) {
    const record = await committedRecord(git, id, head).catch(() => undefined);
    if (!record) continue;
    const state = stateOf(record);
    // A close covers its verifier changes only if, judged now, nothing was missing (a valid approval, or an acceptance that still counts).
    if (record.closed && record.evidence) {
      if (Object.keys(pending(record)).length === 0) covering.push(record.evidence);
      else failures.push(`${id} closed although ${Object.values(pending(record)).join("; ")}`);
    }
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
  const uncovered: string[] = [];
  let config: HarnessConfig | undefined;
  try {
    config = await loadConfig(top);
  } catch {
    // Integrity reports the configuration.
  }
  const surface = await baseVerifierPaths(git, base, verifierPaths(config ?? {}));
  const markers = await baseTestMarkers(git, base, config?.testMarkers ?? []);
  for (const entry of changed) if (!await coveredAtHead(git, entry, covering, { base, head, ran: main.tests?.ran, surface, markers })) uncovered.push(entry);
  for (const entry of uncovered) {
    failures.push(entry === TESTS_RAN
      ? `fewer tests ran than on the base (${main.tests?.ran} < ${main.tests?.baseline?.ran}) and no closed work in the range had that approved`
      : `${entry}: the range removes or changes lines of existing tests, disables or narrows tests, or changes check configuration there, and no closed work in the range had that version approved or accepted by an independent review`);
  }
  // The base decides whether untraced commits fail, so a range cannot switch itself to observe.
  const enforcement = (await baseConfig(git, base))?.enforcement ?? config?.enforcement;
  const untraced = enforcementOf({ enforcement: enforcement === "enforce" ? "enforce" : "observe" }) === "enforce";
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

/**
 * A checkpoint entry is covered by what closed works had approved or
 * accepted, not by its path, and only all the way from the range's base: a
 * chain of covering works where each one's approved edit starts from a
 * version the range's base reaches without anything the checkpoint counts
 * (or that an earlier work in the chain covers), and the head holds the last
 * one's version or one that only adds to it. So an approval covers neither a
 * later weakening of the same file nor one committed before the work started,
 * which the human approving never saw. A fewer-tests entry is covered when no
 * fewer tests run now than a work had approved.
 */
async function coveredAtHead(git: GitRepository, entry: string, covering: readonly Evidence[], at: { base: string; head: string; ran: number | undefined; surface: readonly string[]; markers: readonly string[] }): Promise<boolean> {
  if (entry === TESTS_RAN) return covering.some((evidence) => verifierCheckpoint(evidence).includes(TESTS_RAN) && at.ran !== undefined && evidence.tests !== undefined && at.ran >= evidence.tests.ran);
  const flagged = new Map<string, Promise<boolean>>();
  const counts = (from: string, to: string): Promise<boolean> => {
    const key = `${from}..${to}`;
    if (!flagged.has(key)) flagged.set(key, verifierChanges(git, from, to, at.surface, [], at.markers).then((changes) => changes.includes(entry)));
    return flagged.get(key)!;
  };
  // Whether the version at `commit` is accounted for from the range's base, using each work at most once (each step goes back in history).
  const accounted = async (commit: string, unused: readonly Evidence[]): Promise<boolean> => {
    if (!await counts(at.base, commit)) return true;
    for (const evidence of unused) {
      if (!verifierCheckpoint(evidence).includes(entry) || await counts(evidence.input.commit, commit)) continue;
      // A work that started before the range's base: what it changed before the base is not the range's to judge.
      if (await git.isAncestor(evidence.base, at.base)) return true;
      if (await accounted(evidence.base, unused.filter((other) => other !== evidence))) return true;
    }
    return false;
  };
  return accounted(at.head, covering);
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
