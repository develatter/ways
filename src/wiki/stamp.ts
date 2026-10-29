import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WIKI_DIR } from "../domain/constants.js";
import { writeAtomic } from "../fs/files.js";
import { normalizeRepoPath } from "../memory/glob.js";
import { isIndex, sourcesOf } from "./check.js";
import { parsePage, withStamp } from "./pages.js";
import { hashSources, repositoryFiles } from "./sources.js";

/** `reference/commands.md`, `docs/wiki/reference/commands.md` or `./commands.md` from the wiki folder: the page's repository path. */
export function pagePath(argument: string): string {
  const path = normalizeRepoPath(argument);
  return path === WIKI_DIR || path.startsWith(`${WIKI_DIR}/`) ? path : `${WIKI_DIR}/${path}`;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Records, in the page, the hash of every source as it is now and today's
 * date: "I read this page against these sources and it holds". The hashes are
 * written by ways, not by the agent that wrote the page.
 */
export async function stampPage(cwd: string, path: string, files?: string[], date = today()): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(cwd, path), "utf8");
  } catch {
    throw new Error(`${path} does not exist; \`ways wiki check\` lists the pages`);
  }
  const page = parsePage(path, text);
  if (!page.frontmatter) throw new Error(`${path}: ${page.frontmatterError ?? "no frontmatter"}; fix the frontmatter first`);
  if (isIndex(page)) throw new Error(`${path} is the index: it documents nothing, so there is nothing to stamp`);
  const { sources, problems } = sourcesOf(page);
  if (sources.length === 0 || problems.length > 0) throw new Error(`${path}: ${problems[0] ?? "`sources` lists no repository path"}`);
  const hashes = await hashSources(cwd, sources, files ?? await repositoryFiles(cwd));
  const gone = sources.filter((source) => hashes.get(source) === undefined);
  if (gone.length > 0) throw new Error(`${path}: ${gone.join(", ")} does not exist; fix \`sources\` before stamping`);
  await writeAtomic(join(cwd, path), withStamp(page, Object.fromEntries(sources.map((source) => [source, hashes.get(source)!])), date));
}
