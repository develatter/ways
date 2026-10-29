import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The product's own documentation outside the wiki (which `ways wiki check`
 * covers): every relative link points at a file that exists.
 */
const root = process.cwd();

async function markdown(dir: string): Promise<string[]> {
  return (await readdir(join(root, dir))).filter((name) => name.endsWith(".md")).map((name) => join(dir, name));
}

describe("documentation links", () => {
  it("resolve to files in the repository", async () => {
    const files = ["README.md", "CHANGELOG.md", ...await markdown("docs"), ...await markdown("docs/decisions")];
    const broken: string[] = [];
    for (const file of files) {
      const text = (await readFile(join(root, file), "utf8")).replace(/^```[\s\S]*?^```/gm, "");
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:|#)/.test(target!)) continue;
        const path = target!.split("#")[0]!;
        if (!existsSync(join(root, dirname(file), decodeURIComponent(path)))) broken.push(`${file}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
