import type { DoneResult } from "./work.js";

/** What `ways done` prints: the result, what is missing and the exact next command. */
export function doneLines(result: DoneResult): string[] {
  const { evidence } = result;
  const lines: string[] = [];
  const short = evidence.input.commit.slice(0, 12);
  if (result.status === "failed") {
    lines.push(`Not done: ${result.id} failed on ${short}.`, ...result.failures.map((line) => `  ${line}`));
    lines.push("Fix it, commit, and run `ways done` again.");
    return lines;
  }
  const criteria = Object.entries(evidence.criteria);
  const summary = [
    `${evidence.checks.filter((check) => check.status === "passed").length} check(s) passed`,
    ...(criteria.length > 0 ? [`${criteria.filter(([, entry]) => entry.status === "passed").length}/${criteria.length} criteria verified`] : []),
  ].join(", ");
  if (result.status === "closed") {
    lines.push(`Done: ${result.kind} ${result.id} closed on ${short} (${summary}).`);
  } else {
    lines.push(`Verifying: ${result.id} passed on ${short} (${summary}).`);
    if (result.pending.review) {
      lines.push(`  Missing: ${result.pending.review}.`);
      lines.push(`  Have a reviewer in a fresh read-only session (e.g. the ways-reviewer agent) review \`git diff ${evidence.base.slice(0, 12)} ${short}\` against the criteria and write {"reviewer": "<name>", "commit": "${evidence.input.commit}", "verdict": "pass"|"fail", "findings": [...]} to a file outside .ways/work; then run \`ways review submit <file>\`.`);
    }
    if (result.pending.approval) {
      lines.push(`  Missing: human approval, because ${result.pending.approval}.`);
      lines.push(`  ${result.pending.review ? "After the review, ask" : "Ask"} the human to run \`ways approve\` in their own terminal.`);
    }
  }
  const weak = criteria.filter(([, entry]) => entry.status === "review-only").map(([id]) => id);
  if (weak.length > 0) lines.push(`  ${weak.join(", ")} ha${weak.length === 1 ? "s" : "ve"} no executable verifier (review-only).`);
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
