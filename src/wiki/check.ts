import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { isWikiPath, WIKI_DIR } from "../domain/constants.js";
import { tokenize } from "../hooks/guard.js";
import { loadWikiConfig } from "./config.js";
import { headingsOf, KIND_DIRECTORIES, KINDS, linksOf, parsePage, readPages, scan, type WikiPage } from "./pages.js";
import { hashSources, normalizeSource, repositoryFiles, sameHash, unitCovered, unitsOf } from "./sources.js";

/**
 * `ways wiki check`: everything a CI can decide about the wiki without reading
 * it. Structure (frontmatter, folders), internal links and anchors, that the
 * sources exist, freshness by hash (a page is stale when a source changed
 * since the page was stamped), that command examples marked `ways-check`
 * agree with the registry, and coverage (every command and module the scope
 * names is cited somewhere). A repository without a wiki passes.
 */
export type IssueCode = "config" | "index-missing" | "frontmatter" | "missing-source" | "stale" | "broken-link" | "broken-anchor" | "orphan" | "example" | "uncovered-command" | "uncovered-module";

export interface WikiIssue {
  code: IssueCode;
  /** The page (or file) the problem is in. */
  path: string;
  line?: number;
  message: string;
}

export interface StaleEntry {
  page: string;
  source: string;
  reason: "changed" | "unstamped";
  recorded?: string;
  current: string;
}

export interface WikiReport {
  /** False when the repository has no wiki; nothing is then checked. */
  exists: boolean;
  pages: number;
  issues: WikiIssue[];
  stale: StaleEntry[];
  uncovered: { commands: string[]; modules: string[] };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function reviewedDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return typeof value === "string" && DATE.test(value) ? value : undefined;
}

export function isIndex(page: WikiPage): boolean {
  return page.rel === "index.md";
}

/** The `sources:` of a page, normalized; entries that cannot be are returned as problems. */
export function sourcesOf(page: WikiPage): { sources: string[]; problems: string[] } {
  const raw = page.frontmatter?.sources;
  const sources: string[] = [];
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { sources, problems };
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      problems.push("every entry of `sources` must be a repository path");
      continue;
    }
    try {
      const source = normalizeSource(item.trim());
      if (isWikiPath(source.replace(/\/$/, ""))) problems.push(`source ${source} is inside the wiki; a page documents code, not other pages (link to the page instead)`);
      else sources.push(source);
    } catch (error) {
      problems.push(`source "${item}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sources: [...new Set(sources)], problems };
}

/** What each page's sources hash to now, against what the page recorded. */
export async function freshness(cwd: string, pages: readonly WikiPage[], files?: string[]): Promise<{ stale: StaleEntry[]; missing: Array<{ page: string; source: string }> }> {
  const known = files ?? await repositoryFiles(cwd);
  const stale: StaleEntry[] = [];
  const missing: Array<{ page: string; source: string }> = [];
  for (const page of pages) {
    if (isIndex(page) || !page.frontmatter) continue;
    const { sources } = sourcesOf(page);
    const recorded = page.frontmatter.source_hashes && typeof page.frontmatter.source_hashes === "object" && !Array.isArray(page.frontmatter.source_hashes) ? page.frontmatter.source_hashes as Record<string, unknown> : {};
    const current = await hashSources(cwd, sources, known);
    for (const source of sources) {
      const now = current.get(source);
      if (now === undefined) {
        missing.push({ page: page.path, source });
        continue;
      }
      const before = recorded[source] ?? recorded[source.replace(/\/$/, "")];
      if (typeof before !== "string" || before === "") stale.push({ page: page.path, source, reason: "unstamped", current: now });
      else if (!sameHash(before, now)) stale.push({ page: page.path, source, reason: "changed", recorded: before, current: now });
    }
  }
  return { stale, missing };
}

export function staleMessage(entry: StaleEntry): string {
  return entry.reason === "unstamped"
    ? `no hash recorded for ${entry.source} (now ${entry.current}); verify the page against it and stamp it`
    : `${entry.source} changed (${entry.recorded} → ${entry.current}) since the page was stamped`;
}

interface Resolved {
  path?: string;
  anchor?: string;
  error?: string;
}

function resolveLink(from: string, target: string): Resolved | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return undefined;
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Keep it as written.
  }
  const [location = "", anchor] = decoded.split("#", 2) as [string, string | undefined];
  const pathPart = location.split("?", 1)[0]!;
  if (!pathPart) return anchor ? { path: from, anchor } : undefined;
  const joined = pathPart.startsWith("/") ? pathPart.slice(1) : posix.join(posix.dirname(from), pathPart);
  const path = posix.normalize(joined);
  if (path === ".." || path.startsWith("../") || path.startsWith("/")) return { error: "points outside the repository" };
  return { path: path.replace(/\/$/, "") || ".", ...(anchor ? { anchor } : {}) };
}

class Targets {
  private readonly pages = new Map<string, WikiPage>();
  constructor(private readonly cwd: string, pages: readonly WikiPage[]) {
    for (const page of pages) this.pages.set(page.path, page);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(join(this.cwd, path));
      return true;
    } catch {
      return false;
    }
  }

  async anchors(path: string): Promise<Set<string> | undefined> {
    let page = this.pages.get(path);
    if (!page) {
      try {
        page = parsePage(path, await readFile(join(this.cwd, path), "utf8"));
      } catch {
        return undefined;
      }
      this.pages.set(path, page);
    }
    return new Set(headingsOf(page).map((heading) => heading.anchor));
  }
}

/** The commands of a `ways-check` block: `ways <command> <args>`, also behind `npx` and in pipelines. */
function waysLines(lines: readonly string[]): Array<{ words: string[]; text: string }> {
  const logical: string[] = [];
  let carry = "";
  for (const raw of lines) {
    const line = `${carry}${raw}`;
    if (line.endsWith("\\")) {
      carry = `${line.slice(0, -1)} `;
      continue;
    }
    carry = "";
    logical.push(line);
  }
  if (carry) logical.push(carry);
  const found: Array<{ words: string[]; text: string }> = [];
  for (const line of logical) {
    const text = line.trim().replace(/^\$\s+/, "");
    if (!text || text.startsWith("#")) continue;
    let segment: string[] = [];
    const flush = (): void => {
      let index = 0;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index] ?? "")) index += 1;
      if (segment[index] === "npx") {
        index += 1;
        while (segment[index]?.startsWith("-")) index += 1;
      }
      if (segment[index] === "ways") found.push({ words: segment.slice(index + 1), text });
      segment = [];
    };
    for (const token of tokenize(text)) {
      if (token.kind === "op") flush();
      else if (token.kind === "word") segment.push(token.value);
    }
    flush();
  }
  return found;
}

async function exampleIssues(page: WikiPage): Promise<WikiIssue[]> {
  const { findCommand } = await import("../commands.js");
  const issues: WikiIssue[] = [];
  for (const fence of scan(page).fences.filter((candidate) => candidate.info.split(/\s+/).includes("ways-check"))) {
    for (const { words, text } of waysLines(fence.lines)) {
      const fail = (message: string): void => {
        issues.push({ code: "example", path: page.path, line: fence.line, message: `\`${text}\`: ${message}` });
      };
      const [name, ...rest] = words;
      if (name === undefined) continue;
      if (name === "--version" || name === "-v" || name === "--help" || name === "-h" || name === "help" || name === "version") continue;
      const command = findCommand(name);
      if (!command) {
        fail(`\`ways ${name}\` is not a command; \`ways --help\` lists them`);
        continue;
      }
      const surface = [...command.usage, ...command.examples].join("\n");
      const subwords = new Set(command.actions.map((action) => action.split(" ")[1]).filter((word): word is string => word !== undefined));
      const strict = !command.actions.includes(command.name) && ![...subwords].some((word) => word.includes("<"));
      const first = rest.find((word) => !word.startsWith("-"));
      if (strict && subwords.size > 0 && first !== undefined && !subwords.has(first)) fail(`\`ways ${name} ${first}\` is not an action of \`ways ${name}\` (${[...subwords].join(", ")})`);
      for (const word of rest) {
        if (!word.startsWith("--")) continue;
        const flag = word.split("=", 1)[0]!;
        if (flag === "--help") continue;
        if (!surface.includes(flag)) fail(`\`${flag}\` is not an option of \`ways ${name}\`; \`ways ${name} --help\` shows its usage`);
      }
    }
  }
  return issues;
}

function mentions(pages: readonly WikiPage[], name: string, prefixed: boolean): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(prefixed ? `\\bways\\s+${escaped}(?![\\w-])` : `(?<![\\w-])${escaped}(?![\\w-])`);
  return pages.some((page) => pattern.test(page.body));
}

export async function checkWiki(cwd: string): Promise<WikiReport> {
  const pages = await readPages(cwd);
  const report: WikiReport = { exists: pages.length > 0, pages: pages.length, issues: [], stale: [], uncovered: { commands: [], modules: [] } };
  if (!report.exists) return report;
  const issue = (code: IssueCode, path: string, message: string, line?: number): void => {
    report.issues.push({ code, path, message, ...(line === undefined ? {} : { line }) });
  };

  const { config, problems } = await loadWikiConfig(cwd);
  for (const problem of problems) issue("config", ".ways/wiki.json", problem);
  const files = await repositoryFiles(cwd);

  if (!pages.some(isIndex)) issue("index-missing", `${WIKI_DIR}/index.md`, "the wiki has no entry page; create docs/wiki/index.md (`ways wiki init` writes it)");

  for (const page of pages) {
    if (!page.frontmatter) {
      issue("frontmatter", page.path, page.frontmatterError ?? "missing frontmatter");
      continue;
    }
    const front = page.frontmatter;
    if (typeof front.title !== "string" || !front.title.trim()) issue("frontmatter", page.path, "`title` is required");
    if (isIndex(page)) continue;
    if (typeof front.kind !== "string" || !(KINDS as readonly string[]).includes(front.kind)) issue("frontmatter", page.path, `\`kind\` must be one of ${KINDS.join(", ")}`);
    else {
      const folder = KIND_DIRECTORIES[page.rel.split("/")[0]!];
      if (page.rel.includes("/") && folder && folder !== front.kind) issue("frontmatter", page.path, `\`kind: ${front.kind}\` in the ${page.rel.split("/")[0]}/ folder, which holds ${folder} pages`);
    }
    if (!Array.isArray(front.sources) || front.sources.length === 0) issue("frontmatter", page.path, "`sources` must list the repository paths the page documents (a page about nothing cannot go stale)");
    else for (const problem of sourcesOf(page).problems) issue("frontmatter", page.path, problem);
    if (front.source_hashes !== undefined && (!front.source_hashes || typeof front.source_hashes !== "object" || Array.isArray(front.source_hashes))) issue("frontmatter", page.path, "`source_hashes` must map each source to its hash");
    if (reviewedDate(front.reviewed) === undefined) issue("frontmatter", page.path, "`reviewed` must be a date, YYYY-MM-DD");
  }

  const { stale, missing } = await freshness(cwd, pages, files);
  report.stale = stale;
  for (const entry of missing) issue("missing-source", entry.page, `source ${entry.source} does not exist; fix the path or remove it from \`sources\``);
  for (const entry of stale) issue("stale", entry.page, staleMessage(entry));

  const targets = new Targets(cwd, pages);
  for (const page of pages) {
    for (const link of linksOf(page)) {
      const resolved = resolveLink(page.path, link.target);
      if (!resolved) continue;
      if (resolved.error) {
        issue("broken-link", page.path, `${link.target}: ${resolved.error}`, link.line);
        continue;
      }
      if (!await targets.exists(resolved.path!)) {
        issue("broken-link", page.path, `${link.target}: no such file or folder (${resolved.path})`, link.line);
        continue;
      }
      if (resolved.anchor && resolved.path!.endsWith(".md")) {
        const anchors = await targets.anchors(resolved.path!);
        if (anchors && !anchors.has(resolved.anchor.toLowerCase())) issue("broken-anchor", page.path, `${link.target}: no heading "#${resolved.anchor}" in ${resolved.path}`, link.line);
      }
    }
  }

  // Every page must be reachable from the index, or nobody finds it.
  const index = pages.find(isIndex);
  if (index) {
    const reached = new Set<string>([index.path]);
    const queue = [index];
    for (let page = queue.shift(); page; page = queue.shift()) {
      for (const link of linksOf(page)) {
        const resolved = resolveLink(page.path, link.target);
        const next = resolved?.path ? pages.find((candidate) => candidate.path === resolved.path) : undefined;
        if (next && !reached.has(next.path)) {
          reached.add(next.path);
          queue.push(next);
        }
      }
    }
    for (const page of pages) if (!reached.has(page.path)) issue("orphan", page.path, "no page links here from index.md; add it to the index (or to a page the index links to)");
  }

  for (const page of pages) report.issues.push(...await exampleIssues(page));

  const cited = pages.flatMap((page) => sourcesOf(page).sources);
  for (const unit of unitsOf(files, config.scope.modules)) {
    if (!unitCovered(unit, cited)) {
      report.uncovered.modules.push(unit);
      issue("uncovered-module", WIKI_DIR, `${unit} is not cited in the \`sources\` of any page`);
    }
  }
  const commands = config.scope.commands === "ways" ? (await import("../commands.js")).COMMANDS.map((command) => command.name) : config.scope.commands;
  for (const name of commands) {
    if (!mentions(pages, name, config.scope.commands === "ways")) {
      report.uncovered.commands.push(name);
      issue("uncovered-command", WIKI_DIR, `\`${config.scope.commands === "ways" ? `ways ${name}` : name}\` is not mentioned in any page`);
    }
  }
  return report;
}

const LABELS: Record<IssueCode, string> = {
  config: "config", "index-missing": "index", frontmatter: "front", "missing-source": "source", stale: "stale", "broken-link": "broken", "broken-anchor": "broken",
  orphan: "orphan", example: "example", "uncovered-command": "gap", "uncovered-module": "gap",
};

export function renderIssue(issue: WikiIssue): string {
  const where = issue.line === undefined ? issue.path : `${issue.path}:${issue.line}`;
  return `${LABELS[issue.code].padEnd(8)} ${where}  ${issue.message}`;
}

/** The text `ways wiki check` prints for a report, with the next command. */
export function renderReport(report: WikiReport): string {
  if (!report.exists) return "No wiki in this repository (docs/wiki is empty or missing); nothing to check. `ways wiki init` creates one.";
  if (report.issues.length === 0) return `Wiki is fine: ${report.pages} page(s), links, sources and examples check out and nothing is stale.`;
  const lines = report.issues.map(renderIssue);
  const hint = report.stale.length > 0 || report.uncovered.commands.length + report.uncovered.modules.length > 0
    ? "`ways wiki update` has the documentalist agent fix stale pages and gaps; after checking a page by hand, `ways wiki update --stamp <page>` records that it is current."
    : "Fix them and run `ways wiki check` again.";
  return [...lines, "", `${report.issues.length} problem(s) in ${report.pages} page(s). ${hint}`].join("\n");
}
