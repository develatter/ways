import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { HARNESS_VERSION } from "../src/index.js";
import { GitRepository } from "../src/git/git.js";

const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

afterEach(() => {
  log.mockClear();
  error.mockClear();
});

describe("CLI", () => {
  it("prints its version", async () => {
    expect(await run(["--version"])).toBe(0);
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(log).toHaveBeenCalledWith(pkg.version);
    expect(HARNESS_VERSION).toBe(pkg.version);
  });

  it("prints the same version from the built binary", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(execFileSync(process.execPath, [process.env.WAYS_CLI!, "--version"], { encoding: "utf8" }).trim()).toBe(pkg.version);
  });

  it("delivers a small change with at most two ways commands and an outcome with at most four, through the built binary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-cli-acceptance-"));
    const git = new GitRepository(cwd);
    await git.run(["init", "-q", "-b", "main"]);
    await git.run(["config", "user.name", "Ways Test"]);
    await git.run(["config", "user.email", "ways@example.test"]);
    await writeFile(join(cwd, ".gitkeep"), "");
    await git.run(["add", ".gitkeep"]);
    await git.run(["commit", "-q", "-m", "initial"]);
    const invocations: string[][] = [];
    const ways = (...args: string[]): string => {
      invocations.push(args);
      return execFileSync(process.execPath, [process.env.WAYS_CLI!, ...args], { cwd, encoding: "utf8" });
    };
    ways("bootstrap", "--test-command=[\"node\",\"-e\",\"0\"]");
    // A stand-in for `claude -p` / `pi -p`: reads ways' prompt on stdin, answers with the review JSON.
    const reviewer = join(cwd, "..", "fake-reviewer.mjs");
    await writeFile(reviewer, "let t='';process.stdin.on('data',(c)=>t+=c).on('end',()=>{const c=/\"commit\": \"([0-9a-f]{40})\"/.exec(t)[1];console.log('Looks fine.\\n```json\\n'+JSON.stringify({reviewer:'fake',commit:c,verdict:'pass',findings:[]})+'\\n```')});\n");
    const configPath = join(cwd, ".ways/config.json");
    await writeFile(configPath, JSON.stringify({ ...JSON.parse(await readFile(configPath, "utf8")) as object, reviewer: { command: [process.execPath, reviewer] } }, null, 2));
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "chore: install ways"]);
    invocations.length = 0;

    // A small change: commit as usual, then one command.
    await git.run(["checkout", "-q", "-b", "fix/typo"]);
    await writeFile(join(cwd, "a.txt"), "a\n");
    await git.run(["add", "a.txt"]);
    await git.run(["commit", "-q", "-m", "fix: typo"]);
    expect(ways("done")).toContain("Done: change fix-typo closed");
    expect(invocations).toHaveLength(1);

    // A delivery with criteria and an independent review: open, done, review.
    invocations.length = 0;
    const opened = ways("outcome", "open", "greeting", "--goal=Greet users", "--criterion=AC1:greeting.txt says hi", "--verify=AC1:grep -q hi greeting.txt");
    // The human reviews the criteria, not the diff: one short block.
    expect(opened).toContain("  AC1  greeting.txt says hi  [test: grep -q hi greeting.txt]");
    await writeFile(join(cwd, "greeting.txt"), "hi\n");
    await git.run(["add", "greeting.txt"]);
    await git.run(["commit", "-q", "-m", "feat: greet"]);
    const verifying = ways("done");
    expect(verifying).toMatch(/Verifying: greeting passed on [0-9a-f]{12}[\s\S]*Run `ways review`[\s\S]*Backed by: 1 test\./);
    const reviewed = ways("review");
    expect(reviewed).toContain("Review recorded: pass.");
    expect(reviewed).toContain("Work closed.");
    expect(invocations.length).toBeLessThanOrEqual(4);
    expect(ways("check", "--history")).toContain("History checks passed.");
  });

  it("answers status in JSON with the next command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-cli-status-"));
    const git = new GitRepository(cwd);
    await git.run(["init", "-q", "-b", "main"]);
    await git.run(["config", "user.name", "Ways Test"]);
    await git.run(["config", "user.email", "ways@example.test"]);
    await mkdir(join(cwd, "x"));
    await writeFile(join(cwd, "x/.gitkeep"), "");
    await git.run(["add", "."]);
    await git.run(["commit", "-q", "-m", "initial"]);
    expect(await run(["bootstrap", "--no-adapters", "--test-command=[\"true\"]"], cwd)).toBe(0);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await run(["status", "--json"], cwd)).toBe(0);
    const packet = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    stdout.mockRestore();
    expect(packet).toMatchObject({ schemaVersion: 2, enforcement: "observe", active: null, next: expect.stringContaining("ways done") });
  });

  it("rejects unknown commands", async () => {
    expect(await run(["unknown"])).toBe(1);
    expect(error).toHaveBeenCalledWith("Unknown command: unknown. Run `ways --help` to list the commands.");
  });
});
