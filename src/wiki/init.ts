import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { WIKI_CONFIG_PATH, WIKI_DIR } from "../domain/constants.js";
import { stableJson, writeAtomic } from "../fs/files.js";
import { KIND_DIRECTORIES } from "./pages.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function indexPage(name: string): string {
  return `---\n${stringify({ title: `${name} wiki` }).trimEnd()}\n---\n
# ${name} wiki

This wiki is for people. It explains the project the way a colleague would; it is not read by coding agents as truth (their memory is \`.ways/knowledge\`), and no tool turns it into a site: GitHub renders it as it is.

Pages are grouped by what the reader needs ([Diátaxis](https://diataxis.fr/)). A folder appears when its first page does.

- **Tutorials** (\`tutorials/\`): learn by doing, start to finish.
- **How-to guides** (\`how-to/\`): reach one goal you already have.
- **Reference** (\`reference/\`): exact facts to look up.
- **Explanation** (\`explanation/\`): why it is the way it is.

Every page lists in its frontmatter the files it documents and their hashes; \`ways wiki check\` tells when one changed, and \`ways wiki update\` launches the documentalist agent to catch the page up. Add each new page to this list.
`;
}

/** Creates what is missing: the entry page, the Diátaxis folders and `.ways/wiki.json`. Nothing that exists is touched. */
export async function initWiki(cwd: string, name: string): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  const index = `${WIKI_DIR}/index.md`;
  if (await exists(join(cwd, index))) existing.push(index);
  else {
    await writeAtomic(join(cwd, index), indexPage(name));
    created.push(index);
  }
  for (const folder of Object.keys(KIND_DIRECTORIES)) await mkdir(join(cwd, WIKI_DIR, folder), { recursive: true });
  if (await exists(join(cwd, WIKI_CONFIG_PATH))) existing.push(WIKI_CONFIG_PATH);
  else {
    await writeAtomic(join(cwd, WIKI_CONFIG_PATH), stableJson({ agent: "claude", scope: { modules: [], commands: [] } }));
    created.push(WIKI_CONFIG_PATH);
  }
  return { created, existing };
}
