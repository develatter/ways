import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepository } from "../src/git/git.js";
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

  it("installs and runs the package from an npm pack tarball", async () => {
    const root = process.cwd();
    const packDir = await mkdtemp(join(tmpdir(), "ways-pack-"));
    // `npm pack --json` changes shape between npm versions (array vs. keyed object), so find the tarball on disk instead.
    execFileSync("npm", ["pack", "--pack-destination", packDir], { cwd: root, stdio: "ignore" });
    const [file] = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    expect(file).toBeTruthy();
    const tarball = join(packDir, file!);
    const cwd = await mkdtemp(join(tmpdir(), "ways-pack-consumer-"));
    const git = new GitRepository(cwd);
    await git.run(["init", "-q", "-b", "main"]);
    await git.run(["config", "user.name", "Ways Test"]);
    await git.run(["config", "user.email", "ways@example.test"]);
    await git.run(["commit", "--allow-empty", "-q", "-m", "initial"]);
    // The consumer runs its own installed CLI, not the one under development.
    const consumerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WAYS_")));
    execFileSync("npm", ["init", "-y"], { cwd, stdio: "ignore" });
    execFileSync("npm", ["install", "--save-dev", tarball], { cwd, stdio: "ignore" });
    const installedPackage = JSON.parse(await readFile(join(cwd, "node_modules", "@develatter", "ways", "package.json"), "utf8"));
    expect(installedPackage.name).toBe("@develatter/ways");
    const ways = (...args: string[]): string => execFileSync("npx", ["--no-install", "ways", ...args], { cwd, encoding: "utf8", env: consumerEnv, stdio: ["ignore", "pipe", "pipe"] });
    expect(ways("--help")).toMatch(/^ways /);
    ways("bootstrap", `--test-command=${JSON.stringify([process.execPath, "-e", "process.exit(0)"])}`);
    execFileSync("sh", [join(cwd, "scripts/check.sh")], { cwd, stdio: "ignore", env: consumerEnv });
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "chore: install ways"], consumerEnv);

    // The installed hook traces a commit, and one outcome closes through the packed CLI.
    ways("outcome", "open", "greeting", "--goal=Greet users", "--criterion=AC1:greeting.txt says hi", "--verify=AC1:grep -q hi greeting.txt", "--review=none");
    await writeFile(join(cwd, "greeting.txt"), "hello\n");
    await git.run(["add", "greeting.txt"]);
    await git.run(["commit", "-q", "-m", "feat: greeting"], consumerEnv);
    expect((await git.commitInfo()).trailers.work).toBe("greeting");
    expect(() => ways("done")).toThrow(/criterion AC1 \(test\): failed/);
    await writeFile(join(cwd, "greeting.txt"), "hi\n");
    await git.run(["commit", "-qam", "fix: say hi"], consumerEnv);
    expect(ways("done")).toContain("Done: outcome greeting closed");
    expect(ways("status")).toContain("No active work.");
    execFileSync("sh", [join(cwd, "scripts/check.sh"), "--history"], { cwd, stdio: "ignore", env: consumerEnv });
  }, 120_000);
});
