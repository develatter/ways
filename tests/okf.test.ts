import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/git/git.js";
import { inspectOkf } from "../src/knowledge/okf.js";

async function bundle(content: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-okf-"));
  const dir = join(cwd, ".ways/knowledge/faq");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "item.md"), content);
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await git.run(["add", "."]);
  await git.run(["commit", "-q", "-m", "memory"]);
  return cwd;
}

describe("OKF", () => {
  it("accepts a verified stable concept", async () => {
    const cwd = await bundle("---\ntype: faq\nstatus: stable\nverified: { by: human:owner, at: 2026-01-01T00:00:00Z }\n---\n\n# Answer\n");
    expect((await inspectOkf(cwd)).issues).toEqual([]);
  });

  it("accepts an unverified concept (queries label it) and only warns on a passed stale_after or a long body", async () => {
    expect((await inspectOkf(await bundle("---\ntype: faq\n---\n\n# Answer\n"))).issues).toEqual([]);
    const stale = await inspectOkf(await bundle(`---\ntype: faq\nstale_after: 2020-01-01T00:00:00Z\n---\n\n${"line\n".repeat(20)}`));
    expect(stale.issues).toEqual([]);
    expect(stale.warnings.map((warning) => warning.code)).toEqual(["stale-after-passed", "long-concept"]);
  });

  it("rejects malformed paths and missing local sources", async () => {
    const result = await inspectOkf(await bundle("---\ntype: faq\npaths: [../outside/**]\nsources:\n  - resource: /missing.ts\n---\n\nx\n"));
    expect(result.issues.map((issue) => issue.code).sort()).toEqual(["missing-source", "okf-paths"]);
  });

  it("allows agent-authored drafts with provenance", async () => {
    const cwd = await bundle("---\ntype: faq\nstatus: draft\ngenerated: { by: explorer/v1, at: 2026-01-01T00:00:00Z }\nsources:\n  - resource: /.ways/knowledge/faq/item.md\n---\n\n# Answer\n");
    expect((await inspectOkf(cwd)).issues).toEqual([]);
  });
});
