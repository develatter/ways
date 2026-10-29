import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkHistory } from "../src/integrity/history.js";
import { indexDir } from "../src/knowledge/indexes.js";
import { checkMemory, remember } from "../src/memory/memory.js";
import { queryKnowledgeResult } from "../src/query/query.js";
import { done, startChange } from "../src/work/work.js";
import { installed } from "./helpers.js";

describe("baseline end-to-end coverage", () => {
  it("keeps memory with the change that taught it, finds it again, and flags it when its code moves on", async () => {
    const { cwd, git } = await installed({ prefix: "ways-baseline-e2e-" });
    await mkdir(join(cwd, "src"), { recursive: true });

    // The change and its memory travel in one commit; done validates both.
    await startChange(cwd, "runtime");
    await writeFile(join(cwd, "src/runtime.ts"), "export const runtime = 1;\n");
    const { path } = await remember(cwd, "The runtime export is a plain number; callers never await it", { paths: ["src/runtime.ts"], type: "convention" });
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "feat: runtime export"]);
    const finished = await done(cwd);
    expect(finished.status).toBe("closed");
    expect(finished.memory).toEqual([]);

    const found = await queryKnowledgeResult(cwd, "runtime await");
    expect(found.hits[0]?.path).toBe(path);
    expect(JSON.parse(await readFile(join(indexDir(cwd), "search.json"), "utf8"))).toHaveProperty("terms.runtime");
    await writeFile(join(indexDir(cwd), "search.json"), "{}\n");
    expect((await queryKnowledgeResult(cwd, "runtime")).hits[0]?.path).toBe(path);

    // A later change to that code points at the memory and marks it possibly stale; it never blocks.
    await startChange(cwd, "runtime-two");
    await writeFile(join(cwd, "src/runtime.ts"), "export const runtime = 2;\n");
    await git.run(["commit", "-qam", "feat: runtime two"]);
    const second = await done(cwd);
    expect(second.status).toBe("closed");
    expect(second.memory).toEqual([expect.objectContaining({ path, stale: true })]);
    expect((await checkMemory(cwd)).warnings.map((warning) => warning.code)).toEqual(["possibly-stale"]);
    expect(await checkHistory(cwd)).toEqual([]);
  });

  // The packed tarball in a consumer repository is tests/smoke-e2e.test.ts.
});
