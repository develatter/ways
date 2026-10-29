import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderVerifyMarkdown, verifyRange } from "../src/work/verify.js";
import { approve, done, openOutcome, startChange, type Terminal } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

const human = (answer: string): Terminal => ({ interactive: true, ask: async () => answer, say: () => undefined });

async function project(): Promise<Awaited<ReturnType<typeof installed>> & { base: string }> {
  const repo = await installed({ testCommand: ["node", "-e", "console.log('ℹ tests 4')"] });
  await mkdir(join(repo.cwd, "tests"), { recursive: true });
  await writeFile(join(repo.cwd, "tests/existing.test.js"), "// existing\n");
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: tests"]);
  return { ...repo, base: await repo.git.head() };
}

describe("ways verify", () => {
  it("re-runs the base's checks and each closed work's verifiers, the same way twice, and reports what backs them", async () => {
    const { cwd, git, base } = await project();
    await openOutcome(cwd, "greeting", { goal: "Greet", criteria: ["AC1:greeting says hi", "AC2:says it politely"], verify: ["AC1:grep -q hi greeting.txt", "AC2:grep -q please greeting.txt"], strength: ["AC2:property"], review: "none" });
    await commitFile(git, cwd, "greeting.txt", "hi, please\n", "feat: greet");
    expect((await done(cwd)).status).toBe("closed");
    const first = await verifyRange(cwd, { base });
    const second = await verifyRange(cwd, { base });
    expect(first).toMatchObject({ passed: true, failures: [], clean: true, verifierChanges: { changed: [], uncovered: [] }, strength: { test: 1, property: 1 } });
    expect(first.works).toEqual([expect.objectContaining({ id: "greeting", state: "closed", reproduced: true, summary: "1 property, 1 test" })]);
    expect(first.works[0]!.criteria[0]).toMatchObject({ id: "AC1", recorded: "passed", now: "passed", base: "failed", effective: "test" });
    const verdict = (report: typeof first): unknown => ({ passed: report.passed, failures: report.failures, checks: report.checks.map((check) => [check.name, check.status, check.exitCode, check.outputSha256]), works: report.works });
    expect(verdict(second)).toEqual(verdict(first));
    expect(renderVerifyMarkdown(first)).toMatch(/## ways verify: passed[\s\S]*\*\*Backed by:\*\* 1 test, 1 property \(2 criteria\)[\s\S]*\| AC2 says it politely \| property \| passed \| passed \| failed \|/);
  });

  it("fails a range that edits an existing test without an approval, which a commit in observe mode allows", async () => {
    const { cwd, git, base } = await project();
    // No `ways done` at all: the hook only traced the commit.
    await commitFile(git, cwd, "tests/existing.test.js", "// weakened\n", "test: relax");
    const report = await verifyRange(cwd, { base });
    expect(report.passed).toBe(false);
    expect(report.verifierChanges).toEqual({ changed: ["tests/existing.test.js"], uncovered: ["tests/existing.test.js"] });
    expect(report.failures.join("\n")).toMatch(/tests\/existing\.test\.js: the range removes or changes lines of existing tests[\s\S]*and no closed work/);
    // Through the CLI, as CI runs it: exit 1 and a JSON report.
    const result = spawnSync(process.execPath, [process.env.WAYS_CLI!, "verify", `--base=${base}`, "--json=report.json", "--markdown=report.md"], { cwd, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(await readFile(join(cwd, "report.json"), "utf8"))).toMatchObject({ passed: false, base });
    expect(await readFile(join(cwd, "report.md"), "utf8")).toContain("**not approved:** tests/existing.test.js");
  });

  it("passes the same edit once the human approved it in a work", async () => {
    const { cwd, git, base } = await project();
    await startChange(cwd, "relax");
    await commitFile(git, cwd, "tests/existing.test.js", "// renamed API\n", "test: follow the rename");
    expect((await done(cwd)).status).toBe("verifying");
    expect((await approve(cwd, human("relax"))).status).toBe("closed");
    const report = await verifyRange(cwd, { base });
    expect(report).toMatchObject({ passed: true, verifierChanges: { changed: ["tests/existing.test.js"], uncovered: [] } });
    expect(execFileSync(process.execPath, [process.env.WAYS_CLI!, "verify", `--base=${base}`, "--in-place"], { cwd, encoding: "utf8" })).toMatch(/^ways verify passed for [0-9a-f]{12}\.\.[0-9a-f]{12}: 1 check\(s\) passed, 1 work\(s\)/);
  });

  it("does not let an approved edit of a test cover a later edit of the same file outside any work", async () => {
    const { cwd, git, base } = await project();
    await startChange(cwd, "relax");
    await commitFile(git, cwd, "tests/existing.test.js", "// renamed API\n", "test: follow the rename");
    await done(cwd);
    expect((await approve(cwd, human("relax"))).status).toBe("closed");
    // Observe mode lets a plain commit through; CI must not count the earlier approval for it.
    await commitFile(git, cwd, "tests/existing.test.js", "// weakened further\n", "test: relax more");
    const report = await verifyRange(cwd, { base });
    expect(report.passed).toBe(false);
    expect(report.verifierChanges).toEqual({ changed: ["tests/existing.test.js"], uncovered: ["tests/existing.test.js"] });
  });

  it("still counts the approval when a later commit only adds tests to the approved file", async () => {
    const { cwd, git, base } = await project();
    await startChange(cwd, "relax");
    await commitFile(git, cwd, "tests/existing.test.js", "// renamed API\n", "test: follow the rename");
    await done(cwd);
    await approve(cwd, human("relax"));
    await commitFile(git, cwd, "tests/existing.test.js", "// renamed API\n// one more test\n", "test: one more");
    const report = await verifyRange(cwd, { base });
    expect(report).toMatchObject({ passed: true, verifierChanges: { changed: ["tests/existing.test.js"], uncovered: [] } });
  });

  it("fails when a closed work's verifier no longer passes on the head", async () => {
    const { cwd, git, base } = await project();
    await openOutcome(cwd, "greeting", { goal: "Greet", criteria: ["AC1:greeting says hi"], verify: ["AC1:grep -q hi greeting.txt"], strength: [], review: "none" });
    await commitFile(git, cwd, "greeting.txt", "hi\n", "feat: greet");
    await done(cwd);
    await commitFile(git, cwd, "greeting.txt", "hello\n", "feat: reword");
    const report = await verifyRange(cwd, { base });
    expect(report.passed).toBe(false);
    expect(report.failures).toContain(`greeting AC1: its verifier fails on ${report.head.slice(0, 12)} although the work closed`);
    expect(report.works[0]).toMatchObject({ reproduced: false });
  });
});
