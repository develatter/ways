import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testsRan } from "../src/check/tests-count.js";
import { readQuarantine } from "../src/runtime/ledger.js";
import { readActive } from "../src/runtime/runtime.js";
import { committedRecord } from "../src/work/record.js";
import { buildStatus } from "../src/work/status.js";
import { block, buildCriteria, done, openOutcome, startChange } from "../src/work/work.js";
import { commitFile, installed } from "./helpers.js";

const node = (script: string, ...args: string[]): string[] => ["node", "-e", script, ...args];

async function project(testCommand: string[], files: Record<string, string> = {}, extraConfig: Record<string, unknown> = {}): Promise<Awaited<ReturnType<typeof installed>>> {
  const repo = await installed({ testCommand });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo.cwd, path, ".."), { recursive: true });
    await writeFile(join(repo.cwd, path), content);
  }
  if (Object.keys(extraConfig).length > 0) {
    const path = join(repo.cwd, ".ways/config.json");
    await writeFile(path, `${JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")) as object, ...extraConfig }, null, 2)}\n`);
  }
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "chore: project files"]);
  return repo;
}

describe("evaluation in a clean checkout", () => {
  it("does not see what the working tree has but the commit lacks, unless --fast", async () => {
    const { cwd, git } = await project(node("process.exit(require('fs').existsSync('built.txt')?0:1)"), { ".gitignore": "built.txt\n", "package.json": "{}\n" });
    await writeFile(join(cwd, "built.txt"), "left over from a local build\n");
    await startChange(cwd, "relies-on-local");
    await commitFile(git, cwd, "a.txt", "a\n", "feat: a");
    const clean = await done(cwd);
    expect(clean.status).toBe("failed");
    expect(clean.evidence.runner).toMatchObject({ clean: true, contractFrom: "base" });
    expect(clean.failures.join("\n")).toMatch(/clean checkout of [0-9a-f]{12}[\s\S]*--fast/);
    const fast = await done(cwd, { fast: true });
    expect(fast.status).toBe("closed");
    expect(fast.evidence.runner?.clean).toBe(false);
  });

  it("links the working tree's dependencies when no setup is configured, and says so", async () => {
    const { cwd, git } = await project(node("require('dep'); process.exit(0)"), { ".gitignore": "node_modules/\n" });
    await mkdir(join(cwd, "node_modules/dep"), { recursive: true });
    await writeFile(join(cwd, "node_modules/dep/index.js"), "module.exports = 1;\n");
    await startChange(cwd, "uses-dep");
    await commitFile(git, cwd, "a.txt", "a\n", "feat: a");
    const result = await done(cwd);
    expect(result.status).toBe("closed");
    expect(result.evidence.runner?.dependencies).toBe("linked from the working tree: node_modules");
  });

  it("runs the setup in the checkout, and again only when a lockfile changes", async () => {
    const counter = join(await import("node:os").then((os) => os.tmpdir()), `setup-${Date.now()}-${Math.random()}`);
    const setup = node("const fs=require('fs');fs.appendFileSync(process.argv[1],'x');fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/ready','1')", counter);
    const test = node("process.exit(require('fs').existsSync('node_modules/ready')?0:1)");
    const { cwd, git } = await project(test, { ".gitignore": "node_modules/\n", "package-lock.json": "{\"v\":1}\n" }, { commands: { required: ["test"], test, setup } });
    for (const [id, file] of [["first", "a.txt"], ["second", "b.txt"]] as const) {
      await startChange(cwd, id);
      await commitFile(git, cwd, file, "x\n", `feat: ${file}`);
      expect((await done(cwd)).status).toBe("closed");
    }
    expect(await readFile(counter, "utf8")).toBe("x");
    await startChange(cwd, "lock-bump");
    await commitFile(git, cwd, "package-lock.json", "{\"v\":2}\n", "chore: bump lock");
    const bumped = await done(cwd);
    expect(bumped.status).toBe("closed");
    expect(await readFile(counter, "utf8")).toBe("xx");
    expect(bumped.evidence.environment?.[0]).toMatchObject({ kind: "setup", status: "passed" });
  });

  it("gives the same result twice on the same commit", async () => {
    const { cwd, git } = await project(node("console.log('ℹ tests 2'); process.exit(0)"));
    await openOutcome(cwd, "twice", { goal: "Twice", criteria: ["AC1:file says hi"], verify: ["AC1:grep -q hi twice.txt"], strength: [], review: "none" });
    await commitFile(git, cwd, "twice.txt", "hi\n", "feat: twice");
    const { evaluate } = await import("../src/work/evaluate.js");
    const active = readActive(cwd)!;
    const record = await committedRecord(git, "twice");
    const runs = [];
    for (let index = 0; index < 2; index += 1) runs.push(await evaluate({ cwd, git, base: active.base, criteria: record!.criteria, work: "twice" }));
    const verdict = (evidence: (typeof runs)[number]): unknown => ({
      passed: evidence.passed,
      checks: evidence.checks.map(({ id, status, exitCode, outputSha256, tests }) => ({ id, status, exitCode, outputSha256, tests })),
      criteria: Object.fromEntries(Object.entries(evidence.criteria).map(([id, entry]) => [id, { status: entry.status, effective: entry.effective, exitCode: entry.exitCode, outputSha256: entry.outputSha256, baseline: entry.baseline?.status }])),
      verifierChanges: evidence.verifierChanges,
    });
    expect(verdict(runs[1]!)).toEqual(verdict(runs[0]!));
    expect(runs[0]!.criteria.AC1).toMatchObject({ status: "passed", effective: "test", runs: ["AC1", "AC1@base"], baseline: { status: "failed", id: "AC1@base" } });
  });
});

describe("criteria verified from red to green", () => {
  it("counts a verifier that already passes on the base as review-only, so a review is required", async () => {
    const { cwd, git } = await project(node("process.exit(0)"), { "greeting.txt": "hi\n" });
    await openOutcome(cwd, "already", { goal: "Already", criteria: ["AC1:greeting says hi"], verify: ["AC1:grep -q hi greeting.txt"], strength: [], review: "none" });
    await commitFile(git, cwd, "other.txt", "x\n", "feat: unrelated");
    const result = await done(cwd);
    expect(result.status).toBe("verifying");
    expect(result.evidence.criteria.AC1).toMatchObject({ status: "passed", strength: "test", effective: "review-only", baseline: { status: "passed" } });
    expect(result.pending.review).toMatch(/AC1 has no verifier that fails without the work/);
  });

  it("skips red-on-base with --fast and leaves it to CI", async () => {
    const { cwd, git } = await project(node("process.exit(0)"));
    await openOutcome(cwd, "quick", { goal: "Quick", criteria: ["AC1:q exists"], verify: ["AC1:test -f q.txt"], strength: [], review: "none" });
    await commitFile(git, cwd, "q.txt", "q\n", "feat: q");
    const result = await done(cwd, { fast: true });
    expect(result.status).toBe("closed");
    expect(result.evidence.criteria.AC1).toMatchObject({ effective: "test", baseline: { status: "not-run" } });
  });

  it("infers e2e from the verifier and records the agent's note", async () => {
    expect(buildCriteria({ criteria: ["AC1:a", "AC2:b"], verify: ["AC1:npx playwright test login", "AC2:npm test"], strength: [] }).map((criterion) => criterion.strength)).toEqual(["e2e", "test"]);
    const { cwd, git } = await project(node("process.exit(0)"));
    await openOutcome(cwd, "noted", { goal: "Noted", criteria: ["AC1:n exists"], verify: ["AC1:test -f n.txt"], strength: [], review: "none" });
    await commitFile(git, cwd, "n.txt", "n\n", "feat: n");
    await expect(done(cwd, { notes: ["AC9:nope"] })).rejects.toThrow(/AC9, which is not a criterion/);
    const result = await done(cwd, { notes: ["AC1:checked by hand on Safari too"] });
    expect(result.evidence.criteria.AC1?.note).toBe("checked by hand on Safari too");
  });
});

describe("flakiness", () => {
  it("retries a failing check, records the pass as flaky and quarantines it", async () => {
    const counter = join(await import("node:os").then((os) => os.tmpdir()), `flaky-${Date.now()}-${Math.random()}`);
    const { cwd, git } = await project(node("const fs=require('fs');const p=process.argv[1];const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));if(n===0){console.log('boom');process.exit(1)}", counter));
    await startChange(cwd, "flaky");
    await commitFile(git, cwd, "a.txt", "a\n", "feat: a");
    const result = await done(cwd);
    expect(result.status).toBe("closed");
    expect(result.evidence.flaky).toEqual(["check:test"]);
    expect(result.evidence.checks[0]).toMatchObject({ status: "passed", attempts: 2 });
    expect(readQuarantine(cwd)).toEqual([expect.objectContaining({ key: "check:test", count: 1, tail: "boom" })]);
    expect((await buildStatus(cwd)).quarantine).toEqual([expect.objectContaining({ key: "check:test" })]);
  });

  it("records a failure only after three attempts", async () => {
    const { cwd, git } = await project(node("process.exit(1)"));
    await startChange(cwd, "broken");
    await commitFile(git, cwd, "a.txt", "a\n", "feat: a");
    const result = await done(cwd);
    expect(result.status).toBe("failed");
    expect(result.evidence.checks[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(result.failures[0]).toMatch(/after 3 attempts/);
  });
});

describe("the test ratchet", () => {
  it("reads common runner summaries", () => {
    expect(testsRan(" Test Files  2 passed (2)\n      Tests  12 passed | 1 skipped (13)\n   Duration  1.2s")).toBe(12);
    expect(testsRan("Tests:       1 failed, 12 passed, 13 total")).toBe(13);
    expect(testsRan("ℹ tests 7\nℹ pass 7")).toBe(7);
    expect(testsRan("  5 passing (20ms)")).toBe(5);
    expect(testsRan("===== 3 passed, 1 failed in 0.12s =====")).toBe(4);
    expect(testsRan("test result: ok. 9 passed; 0 failed; 1 ignored")).toBe(9);
    expect(testsRan("all good")).toBeUndefined();
  });

  it("treats fewer tests than on the base as a change of the tests", async () => {
    const { cwd, git } = await project(node("console.log('ℹ tests '+require('fs').readFileSync('count.txt','utf8').trim())"), { "count.txt": "3\n" });
    await startChange(cwd, "seed");
    await commitFile(git, cwd, "a.txt", "a\n", "feat: a");
    expect((await done(cwd)).evidence.tests).toEqual({ ran: 3, dropped: false });
    await startChange(cwd, "fewer");
    await commitFile(git, cwd, "count.txt", "2\n", "refactor: fewer tests run");
    const result = await done(cwd);
    expect(result.evidence.tests).toMatchObject({ ran: 2, dropped: true, baseline: { ran: 3 } });
    expect(result.status).toBe("verifying");
    expect(result.pending.approval).toMatch(/fewer tests ran than on the base \(2 < 3/);
  });
});

describe("ways block", () => {
  it("records why the work stopped, for the human, and a later pass clears it", async () => {
    const { cwd, git } = await project(node("process.exit(require('fs').readFileSync('status.txt','utf8').trim()==='ok'?0:1)"), { "status.txt": "ok\n" });
    await openOutcome(cwd, "impossible", { goal: "Impossible", criteria: ["AC1:p exists"], verify: ["AC1:test -f p.txt"], strength: [], review: "none" });
    await expect(block(cwd, "hm")).rejects.toThrow(/what is missing/);
    const blocked = await block(cwd, "AC1 needs the payments sandbox key; set PAYMENTS_KEY or drop AC1");
    expect(blocked.id).toBe("impossible");
    expect((await git.commitInfo()).trailers).toEqual({ work: "impossible", state: "blocked" });
    expect((await committedRecord(git, "impossible"))?.blocked?.reason).toMatch(/payments sandbox key/);
    const status = await buildStatus(cwd);
    expect(status.active?.blocked).toMatch(/payments sandbox key/);
    expect(status.next).toMatch(/blocked[\s\S]*human/);
    await commitFile(git, cwd, "p.txt", "p\n", "feat: p");
    const result = await done(cwd);
    expect(result.status).toBe("closed");
    expect((await committedRecord(git, "impossible"))?.blocked).toBeUndefined();
    const { checkHistory } = await import("../src/integrity/history.js");
    expect(await checkHistory(cwd)).toEqual([]);
  });

  it("gives a small change a record so the block is kept", async () => {
    const { cwd, git } = await project(node("process.exit(0)"));
    await git.run(["checkout", "-q", "-b", "fix/thing"]);
    const result = await block(cwd, "The fix needs a decision on the API shape: v1 or v2?");
    expect(result.id).toBe("fix-thing");
    expect(await committedRecord(git, "fix-thing")).toMatchObject({ kind: "change", blocked: { reason: expect.stringMatching(/API shape/) } });
  });
});
