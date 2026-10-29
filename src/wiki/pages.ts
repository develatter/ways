import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse, stringify } from "yaml";
import { WIKI_DIR } from "../domain/constants.js";

/** The Diátaxis kinds a page may declare, and the folder each one usually lives in. */
export const KINDS = ["tutorial", "how-to", "reference", "explanation"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_DIRECTORIES: Readonly<Record<string, Kind>> = { tutorials: "tutorial", "how-to": "how-to", reference: "reference", explanation: "explanation" };

export interface WikiPage {
  /** Repository-relative, e.g. `docs/wiki/reference/commands.md`. */
  path: string;
  /** Relative to the wiki root, e.g. `reference/commands.md`. */
  rel: string;
  text: string;
  frontmatter: Record<string, unknown> | undefined;
  /** Why the frontmatter could not be read. */
  frontmatterError?: string;
  /** Text after the frontmatter. */
  body: string;
  /** 1-based line of the first body line in the file. */
  bodyLine: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parsePage(path: string, text: string): WikiPage {
  const rel = path.slice(WIKI_DIR.length + 1);
  const match = FRONTMATTER.exec(text);
  if (!match) return { path, rel, text, frontmatter: undefined, frontmatterError: "missing YAML frontmatter (--- … ---) at the top", body: text, bodyLine: 1 };
  const body = text.slice(match[0].length);
  const bodyLine = text.slice(0, match[0].length).split("\n").length;
  try {
    const value: unknown = parse(match[1] ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) return { path, rel, text, frontmatter: undefined, frontmatterError: "the frontmatter must be a mapping", body, bodyLine };
    return { path, rel, text, frontmatter: value as Record<string, unknown>, body, bodyLine };
  } catch (error) {
    return { path, rel, text, frontmatter: undefined, frontmatterError: `invalid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, body, bodyLine };
  }
}

/** Markdown files under docs/wiki, sorted; `[]` when there is no wiki. */
export async function readPages(cwd: string): Promise<WikiPage[]> {
  const pages: WikiPage[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(cwd, directory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) pages.push(parsePage(path, await readFile(join(cwd, path), "utf8")));
    }
  }
  await walk(WIKI_DIR);
  return pages;
}

export interface Fence {
  /** The info string after the opening fence, e.g. `sh ways-check`. */
  info: string;
  /** 1-based line of the opening fence, in the page file. */
  line: number;
  lines: string[];
}

export interface Link {
  target: string;
  line: number;
}

export interface Heading {
  text: string;
  anchor: string;
}

/** Splits a body into fenced code blocks and the prose around them. */
export function scan(page: WikiPage): { fences: Fence[]; prose: Array<{ text: string; line: number }> } {
  const fences: Fence[] = [];
  const prose: Array<{ text: string; line: number }> = [];
  let open: { marker: string; fence: Fence } | undefined;
  page.body.split("\n").forEach((text, index) => {
    const line = page.bodyLine + index;
    const edge = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(text);
    if (open) {
      if (edge && edge[1]!.startsWith(open.marker) && edge[1]!.length >= open.marker.length && edge[2]!.trim() === "") {
        fences.push(open.fence);
        open = undefined;
      } else open.fence.lines.push(text);
    } else if (edge) {
      open = { marker: edge[1]![0]!.repeat(edge[1]!.length), fence: { info: edge[2]!.trim(), line, lines: [] } };
    } else prose.push({ text, line });
  });
  if (open) fences.push(open.fence);
  return { fences, prose };
}

/** Inline links and images in prose, outside code spans. */
export function linksOf(page: WikiPage): Link[] {
  const links: Link[] = [];
  for (const { text, line } of scan(page).prose) {
    const plain = text.replace(/`[^`]*`/g, "");
    for (const match of plain.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) links.push({ target: match[1]!, line });
  }
  return links;
}

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
export function headingsOf(page: WikiPage): Heading[] {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  for (const { text } of scan(page).prose) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
    if (!match) continue;
    const plain = match[1]!.replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ text: plain, anchor: count === 0 ? base : `${base}-${count}` });
  }
  return headings;
}

/** The page's frontmatter with new `source_hashes` and `reviewed`, the body untouched. */
export function withStamp(page: WikiPage, hashes: Record<string, string>, reviewed: string): string {
  const frontmatter = { ...(page.frontmatter ?? {}), source_hashes: hashes, reviewed };
  return `---\n${stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${page.body.startsWith("\n") ? "" : "\n"}${page.body}`;
}
