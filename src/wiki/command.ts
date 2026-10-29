import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { gitDirs } from "../runtime/runtime.js";
import { checkWiki, freshness, renderIssue, renderReport, stalePageMessage } from "./check.js";
import { initWiki } from "./init.js";
import { readPages } from "./pages.js";
import { repositoryFiles } from "./sources.js";
import { pagePath, stampPage } from "./stamp.js";
import { updateWiki } from "./update.js";

interface OptionHelpers {
  option(args: readonly string[], name: string): string | undefined;
  options(args: readonly string[], name: string, spaced?: boolean): string[];
}

const USAGE = "Usage: ways wiki init | update [--agent=claude|pi|<command>] [--dry-run] [--stamp <page>...] | check [--json] | stale [--json]";

async function projectName(top: string): Promise<string> {
  try {
    const name = (JSON.parse(await readFile(join(top, "package.json"), "utf8")) as { name?: unknown }).name;
    if (typeof name === "string" && name) return name.replace(/^@[^/]+\//, "");
  } catch {
    // Not a Node project.
  }
  return basename(top);
}

/** `ways wiki init | update | check | stale`. */
export async function runWiki(args: readonly string[], cwd: string, { option }: OptionHelpers): Promise<number> {
  const [action, ...rest] = args;
  const top = gitDirs(cwd).top;
  const json = args.includes("--json");

  if (action === "init") {
    const { created, existing } = await initWiki(top, await projectName(top));
    for (const path of created) console.log(`created ${path}`);
    for (const path of existing) console.log(`kept    ${path} (already there)`);
    console.log("Next: write a first page (see docs/wiki/index.md for the shape) or let the documentalist draft one with `ways wiki update`; `ways wiki check` validates the wiki, and in `.ways/wiki.json` \"scope\" says which modules and commands it must cover.");
    return 0;
  }

  if (action === "check") {
    const report = await checkWiki(top);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: report.issues.length === 0, ...report }, null, 2)}\n`);
      return report.issues.length > 0 ? 1 : 0;
    }
    (report.issues.length > 0 ? console.error : console.log)(renderReport(report));
    return report.issues.length > 0 ? 1 : 0;
  }

  if (action === "stale") {
    const pages = await readPages(top);
    const { stale, missing } = await freshness(top, pages, await repositoryFiles(top));
    if (json) {
      process.stdout.write(`${JSON.stringify({ stale, missing }, null, 2)}\n`);
      return 0;
    }
    if (pages.length === 0) console.log("No wiki in this repository; `ways wiki init` creates one.");
    else if (stale.length + missing.length === 0) console.log(`No stale pages: the sources of all ${pages.length} page(s) are as they were when the pages were stamped.`);
    for (const page of new Set(stale.map((entry) => entry.page))) console.log(renderIssue({ code: "stale", path: page, message: stalePageMessage(stale.filter((entry) => entry.page === page)) }));
    for (const entry of missing) console.log(renderIssue({ code: "missing-source", path: entry.page, message: `source ${entry.source} no longer exists` }));
    if (stale.length + missing.length > 0) console.log("\n`ways wiki update` has the documentalist agent catch them up; after checking a page by hand, `ways wiki update --stamp <page>` records that it is current.");
    return 0;
  }

  if (action === "update") {
    if (args.includes("--stamp")) {
      const pages = rest.filter((arg) => !arg.startsWith("-"));
      if (pages.length === 0) throw new Error("Usage: ways wiki update --stamp <page>...   (the pages you checked against their sources; paths from the wiki folder or the repository root)");
      const files = await repositoryFiles(top);
      for (const page of pages) {
        const path = pagePath(page);
        await stampPage(top, path, files);
        console.log(`stamped ${path}: its sources' hashes and today's date are recorded`);
      }
      return 0;
    }
    const agent = option(args, "--agent");
    return updateWiki(top, { ...(agent === undefined ? {} : { agent }), dryRun: args.includes("--dry-run") });
  }

  throw new Error(USAGE);
}
