import { WIKI_DIR } from "../domain/constants.js";
import { renderIssue, staleMessage, type WikiReport } from "./check.js";
import { readPages } from "./pages.js";

const MAX_ITEMS = 40;

function cap(lines: string[]): string[] {
  return lines.length > MAX_ITEMS ? [...lines.slice(0, MAX_ITEMS), `- … ${lines.length - MAX_ITEMS} more (\`ways wiki check\`)`] : lines;
}

export interface WikiBrief {
  text: string;
  /** Nothing is stale, missing or broken: there is nothing to ask of an agent. */
  empty: boolean;
}

/**
 * What the documentalist is told: the state of the wiki as facts, computed by
 * `ways wiki check` (so it is deterministic), and the page format. Nothing in
 * it is procedure; the role says how to write.
 */
export async function buildWikiBrief(cwd: string, report: WikiReport): Promise<WikiBrief> {
  const sections: string[] = [];
  const staleByPage = new Map<string, string[]>();
  for (const entry of report.stale) staleByPage.set(entry.page, [...(staleByPage.get(entry.page) ?? []), staleMessage(entry)]);
  if (staleByPage.size > 0) {
    sections.push(["## Stale pages (a source changed since the page was stamped)", ...cap([...staleByPage].map(([page, reasons]) => `- ${page}: ${reasons.join("; ")}`))].join("\n"));
  }
  const gaps = [...report.uncovered.modules.map((unit) => `- module ${unit}: no page cites it in \`sources\``), ...report.uncovered.commands.map((name) => `- command \`${name}\`: no page mentions it`)];
  if (gaps.length > 0) sections.push(["## Gaps (nothing documents them yet)", ...cap(gaps)].join("\n"));
  const problems = report.issues.filter((issue) => !["stale", "uncovered-command", "uncovered-module"].includes(issue.code));
  if (problems.length > 0) sections.push(["## Problems `ways wiki check` reports", ...cap(problems.map((issue) => `- ${renderIssue(issue).replace(/\s+/g, " ")}`))].join("\n"));
  const empty = sections.length === 0;
  const pages = await readPages(cwd);
  const titles = pages.map((page) => `- ${page.path}${typeof page.frontmatter?.title === "string" ? ` — ${page.frontmatter.title}` : ""}${typeof page.frontmatter?.kind === "string" ? ` (${page.frontmatter.kind})` : ""}`);
  const text = [
    `# Wiki update brief`,
    "",
    `The wiki is ${WIKI_DIR}/ (${pages.length} page(s)). Write only there. The agents' memory, .ways/knowledge, is a different thing: do not copy between them.`,
    "Page format: frontmatter with `title`, `kind` (tutorial | how-to | reference | explanation), `sources` (repository paths the page documents; a trailing / names a folder) and `reviewed` (YYYY-MM-DD); ways records `source_hashes` itself. Pages live in tutorials/, how-to/, reference/ and explanation/ and are linked from index.md. Command examples that should be checked go in ```sh ways-check blocks.",
    "",
    ...(empty ? ["Nothing is stale, missing or broken."] : sections.flatMap((section) => [section, ""])),
    ...(titles.length > 0 ? ["## Existing pages", ...cap(titles)] : []),
    "",
  ].join("\n");
  return { text, empty };
}
