import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installed, repository } from "./helpers.js";

/*
 * Where the CLI is run from, and what it says when it cannot help: every
 * failure says what happened and which command to run next, and nothing is
 * written where it does not belong.
 */
function ways(cwd: string, args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [process.env.WAYS_CLI!, ...args], { cwd, encoding: "utf8", env: { ...process.env, WAYS_SESSION: "", WAYS_AGENT: "" } });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("CLI: where it runs and what it says", () => {
  it("refuses every repository command outside a Git repository, writes nothing there, and says what to do", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ways-outside-"));
    const commands = [["status"], ["done"], ["start", "fix-x"], ["remember", "a fact worth keeping"], ["memory", "check"], ["query", "x"], ["check", "--history"], ["adapter", "install", "claude"], ["wiki", "check"], ["ask", "ready?"], ["bootstrap"]];
    for (const args of commands) {
      const result = ways(outside, args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.out, args.join(" ")).toContain(`Not inside a Git repository: ${outside}. Run \`ways ${args[0]}\` from your project's directory (or \`git init\` one first).`);
    }
    expect(existsSync(join(outside, ".ways"))).toBe(false);
    // What needs no repository still works.
    const list = ways(outside, ["adapter", "list"]);
    expect(list.status).toBe(0);
    expect(list.out.trim().split("\n").sort()).toEqual(["claude", "codex (best effort)", "cursor (best effort)", "pi"]);
    expect(ways(outside, ["--help"]).status).toBe(0);
  });

  it("works on the repository from any of its directories, and keeps the user's paths relative to where they typed them", async () => {
    const { cwd } = await installed();
    const sub = join(cwd, "packages", "app");
    await mkdir(sub, { recursive: true });
    const remembered = ways(sub, ["remember", "App strings live in locales/", "--path=packages/app/**"]);
    expect(remembered.status, remembered.out).toBe(0);
    expect(existsSync(join(cwd, ".ways/knowledge/conventions/app-strings-live-in-locales.md"))).toBe(true);
    expect(existsSync(join(sub, ".ways"))).toBe(false);
    expect(ways(sub, ["status"]).out).toContain("enforcement: observe");
    expect(ways(sub, ["memory", "check"])).toMatchObject({ status: 0 });
    const verified = ways(sub, ["verify", "--base=HEAD", "--json=report.json"]);
    expect(verified.status, verified.out).toBe(0);
    expect(JSON.parse(await readFile(join(sub, "report.json"), "utf8"))).toMatchObject({ passed: true });
  });

  it("points at the next command when ways is not installed or nothing is active", async () => {
    const { cwd: bare } = await repository();
    expect(ways(bare, ["check"]).out).toContain("run `ways bootstrap` first");
    expect(ways(bare, ["context"]).out).toContain("run `ways bootstrap` first");
    expect(ways(bare, ["upgrade"]).out).toContain("Run `ways bootstrap`");
    expect(ways(bare, ["adapter", "install", "claude"]).out).toContain(".ways/manifest.json is missing: ways is not installed here. Run `ways bootstrap --agents=<agents>`");
    expect(ways(bare, ["wiki", "check"])).toMatchObject({ status: 0, out: expect.stringContaining("`ways wiki init` creates one") });

    const { cwd } = await installed();
    for (const [args, next] of [
      [["done"], "`ways start <id>`"],
      [["block", "the payments key is missing"], "`ways start <id>`"],
      [["review"], "run `ways done` first"],
      [["approve"], "run `ways approve` themselves"],
      [["start"], "`ways start <id>`"],
      [["memory"], "ways memory --help"],
      [["evals", "compare"], "ways evals --help"],
    ] as const) {
      const result = ways(cwd, [...args]);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.out, args.join(" ")).toContain(next);
    }
  });
});
