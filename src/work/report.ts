import { formatCommandLine } from "./argv.js";
import { strengthSummary } from "./evaluate.js";
import type { DoneResult } from "./work.js";

/** What `ways done` prints: the result, what is missing and the exact next command. */
export function doneLines(result: DoneResult): string[] {
  const { evidence } = result;
  const lines: string[] = [];
  const short = evidence.input.commit.slice(0, 12);
  if (result.status === "failed") {
    lines.push(`Not done: ${result.id} failed on ${short}.`, ...result.failures.map((line) => `  ${line}`));
    lines.push("Fix it, commit, and run `ways done` again. If it cannot pass without weakening a test or a check, stop and run `ways block \"<what is missing; what would unblock it>\"` instead.");
    return lines;
  }
  const criteria = Object.entries(evidence.criteria);
  const summary = [
    `${evidence.checks.filter((check) => check.status === "passed").length} check(s) passed`,
    ...(criteria.length > 0 ? [`${criteria.filter(([, entry]) => entry.status === "passed").length}/${criteria.length} criteria verified`] : []),
    ...(evidence.tests ? [`${evidence.tests.ran} tests ran`] : []),
    evidence.runner?.clean === false ? "in place (--fast)" : "in a clean checkout",
  ].join(", ");
  if (result.status === "closed") {
    lines.push(`Done: ${result.kind} ${result.id} closed on ${short} (${summary}).`);
  } else {
    lines.push(`Verifying: ${result.id} passed on ${short} (${summary}).`);
    if (result.pending.review) {
      lines.push(`  Missing: ${result.pending.review}.`);
      lines.push("  Run `ways review`: it launches an independent read-only reviewer and records its verdict (in Claude Code you can use the ways-reviewer subagent instead; ways records its verdict itself).");
    }
    if (result.pending.approval) {
      lines.push(`  Missing: human approval, because ${result.pending.approval}.`);
      lines.push(`  ${result.pending.review ? "After the review, ask" : "Ask"} the human to run \`ways approve\` in their own terminal.`);
    }
  }
  if (criteria.length > 0) lines.push(`  Backed by: ${strengthSummary(evidence)}.`);
  const weak = criteria.filter(([, entry]) => entry.status === "passed" && entry.baseline?.status === "passed").map(([id, entry]) => `${id} (${formatCommandLine(entry.command ?? [])})`);
  if (weak.length > 0) lines.push(`  ${weak.join(", ")} already passed on the base ${evidence.base.slice(0, 12)}: the verifier does not show this work did anything, so the criterion counts as review-only.`);
  const unverified = criteria.filter(([, entry]) => entry.status === "review-only").map(([id]) => id);
  if (unverified.length > 0) lines.push(`  ${unverified.join(", ")} ha${unverified.length === 1 ? "s" : "ve"} no executable verifier (review-only).`);
  if (evidence.flaky?.length) lines.push(`  Flaky: ${evidence.flaky.join(", ")} failed and then passed on a retry; it is in the quarantine \`ways status\` shows.`);
  if (evidence.tests?.dropped && evidence.tests.baseline) lines.push(`  Fewer tests ran than on the base (${evidence.tests.ran} < ${evidence.tests.baseline.ran}); that counts as a change of the tests.`);
  if (result.memory.length > 0) {
    lines.push("Memory about the code you changed (not updated in this work):");
    for (const concept of result.memory) lines.push(`  ${concept.path} — ${concept.title}${concept.stale ? " (possibly stale)" : ""}`);
    lines.push("  If one no longer holds, fix it in a commit; to keep a new fact: `ways remember \"<fact>\" --path=<glob>`.");
  }
  return lines;
}

export function printDone(result: DoneResult): void {
  const lines = doneLines(result);
  (result.status === "failed" ? console.error : console.log)(lines.join("\n"));
}
