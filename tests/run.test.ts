import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { runChecksCompact } from "../src/run/command.js";
import { readChecksFile } from "../src/run/checks-file.js";
import { addCheck } from "../src/run/validate.js";
import { gitDirs } from "../src/runtime/runtime.js";
import { done, openOutcome, startChange } from "../src/work/work.js";
import { installed } from "./helpers.js";

/**
 * A test runner that prints like pytest: thousands of lines of logging, then
 * a FAILED line for every name listed in failing.txt.
 */
const RUNNER = `
const fs = require("node:fs");
const failing = fs.existsSync("failing.txt") ? fs.readFileSync("failing.txt", "utf8").split("\\n").filter(Boolean) : [];
const out = [];
out.push("============================= test session starts ==============================");
for (let i = 0; i < 6000; i += 1) out.push("[app] request " + i + " handled in " + (i % 97) + " ms user=u" + (i % 13));
if (failing.length > 0) {
  out.push("=================================== FAILURES ===================================");
  for (const name of failing) {
    out.push("____ " + name + " ____", "", ">       assert total == 81", "E       assert 90 == 81", "", "tests/test_cart.py:14: AssertionError");
  }
  out.push("=========================== short test summary info ============================");
  for (const name of failing) out.push("FAILED tests/test_cart.py::" + name + " - assert 90 == 81");
}
out.push("========================= " + (failing.length ? failing.length + " failed, " : "") + "18 passed in 0.31s =========================");
process.stdout.write(out.join("\\n") + "\\n");
process.exitCode = failing.length ? 1 : 0;
`;

const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
afterEach(() => {
  log.mockClear();
  stdout.mockClear();
});

async function project(failing: string[]): Promise<Awaited<ReturnType<typeof installed>>> {
  const repo = await installed({ testCommand: [process.execPath, "runner.js"] });
  await writeFile(join(repo.cwd, "runner.js"), RUNNER);
  await writeFile(join(repo.cwd, "failing.txt"), failing.join("\n"));
  await repo.git.run(["add", "-A"]);
  await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "test: the runner"]);
  return repo;
}

describe("ways run", () => {
  it("returns a summary of a huge failing run, keeps the exit code and the whole log", async () => {
    const repo = await project(["test_applies_discount", "test_rejects_negative"]);
    const report = await runChecksCompact(repo.cwd, ["test"]);
    const raw = (await readFile(join(gitDirs(repo.cwd).common, "ways", "runs", `${report.runs[0]!.record.id}.log`), "utf8"));
    expect(raw.split("\n").length).toBeGreaterThan(6000);
    expect(report.exitCode).toBe(1);
    expect(report.text.length).toBeLessThanOrEqual(2000);
    expect(report.text).toContain("tests/test_cart.py::test_applies_discount");
    expect(report.text).toContain("assert 90 == 81");
    expect(report.text).toMatch(/18 passed, 2 failed/);
    expect(report.text).toContain(`ways run --show ${report.runs[0]!.record.id}`);
    console.info(`ways run test: raw output ${raw.length} chars, summary ${report.text.length} chars`);

    expect(await run(["run", "--show", report.runs[0]!.record.id, "--grep=^FAILED"], repo.cwd)).toBe(0);
    const shown = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(shown).toMatch(/^\d+: FAILED tests\/test_cart\.py::test_applies_discount/m);
    expect(shown).toContain("(2 of");
    stdout.mockClear();
    expect(await run(["run", "test"], repo.cwd)).toBe(1);
  });

  it("says one line when everything passes", async () => {
    const repo = await project([]);
    const report = await runChecksCompact(repo.cwd, []);
    expect(report.exitCode).toBe(0);
    expect(report.text.split("\n")).toHaveLength(1);
    expect(report.text).toMatch(/^✓ test: passed in [\d.]+ m?s — 18 passed \(log: ways run --show test-[a-z0-9]+\)$/);
  });

  it("tells new failures from those that already failed at the base", async () => {
    const repo = await project(["test_already_broken"]);
    // A run on the clean base is what later runs compare with.
    const atBase = await runChecksCompact(repo.cwd, ["test"]);
    expect(atBase.runs[0]!.record.clean).toBe(true);
    await startChange(repo.cwd, "discount");
    await writeFile(join(repo.cwd, "failing.txt"), "test_already_broken\ntest_applies_discount\n");
    const report = await runChecksCompact(repo.cwd, ["test"]);
    expect(report.text.split("\n")[0]).toMatch(/1 new, 1 already failing at [0-9a-f]{12}/);
    expect(report.text).toContain("✗ new tests/test_cart.py::test_applies_discount");
    expect(report.text).toContain("already failing at the base: tests/test_cart.py::test_already_broken");
  });

  it("falls back to the line base in .ways/checks.json when the base was never run here", async () => {
    const repo = await project(["test_already_broken"]);
    const added = await addCheck(gitDirs(repo.cwd), "test", [process.execPath, "runner.js"]);
    expect(added.accepted).toBe(true);
    expect(readChecksFile(repo.cwd).checks.test?.baseline).toMatchObject({ status: "failed", failures: ["tests/test_cart.py::test_already_broken"] });
    // A fresh clone: no runs on this machine, only the committed line base.
    await rm(join(gitDirs(repo.cwd).common, "ways", "runs"), { recursive: true, force: true });
    await writeFile(join(repo.cwd, "failing.txt"), "test_already_broken\ntest_new_one\n");
    const report = await runChecksCompact(repo.cwd, ["test"]);
    expect(report.text.split("\n")[0]).toContain("1 new, 1 already failing");
    expect(report.text).toContain("✗ new tests/test_cart.py::test_new_one");
  });

  it("validates a check before saving it: a missing program is rejected, a working one is kept", async () => {
    const repo = await project([]);
    const missing = await addCheck(gitDirs(repo.cwd), "lint", ["ways-no-such-linter", "."]);
    expect(missing.accepted).toBe(false);
    expect(missing.lines.join("\n")).toMatch(/rejected: it cannot start/);
    expect(readChecksFile(repo.cwd).checks.lint).toBeUndefined();
    const lint = [process.execPath, "-e", "console.log('0 problems')"];
    const added = await addCheck(gitDirs(repo.cwd), "lint", lint);
    expect(added.accepted).toBe(true);
    const config = JSON.parse(await readFile(join(repo.cwd, ".ways/config.json"), "utf8")) as { commands: { lint: string[]; required: string[] } };
    expect(config.commands.lint).toEqual(lint);
    expect(config.commands.required).toEqual(["test", "lint"]);
    expect(readChecksFile(repo.cwd).checks.lint).toMatchObject({ command: lint, source: "ways check add", baseline: { status: "passed" } });
    await expect(addCheck(gitDirs(repo.cwd), "format", lint)).rejects.toThrow(/A check is one of test, lint, typecheck, build, e2e/);
  });

  it("ways done records the same compact summary and the log of each check and verifier in the evidence", async () => {
    const repo = await project(["test_applies_discount"]);
    await openOutcome(repo.cwd, "discount", { goal: "Apply the discount", criteria: ["AC1:the discount applies"], verify: [`AC1:${process.execPath} runner.js`], strength: [] });
    await writeFile(join(repo.cwd, "note.txt"), "wip\n");
    await repo.git.run(["add", "-A"]);
    await repo.git.run(["commit", "-q", "-m", "feat: discount"]);
    const result = await done(repo.cwd, { fast: true });
    expect(result.status).toBe("failed");
    const check = result.evidence.checks.find((entry) => entry.name === "test")!;
    expect(check.summary).toMatch(/^✗ test: failed in .* — 18 passed, 1 failed\n {2}✗ tests\/test_cart\.py::test_applies_discount/);
    expect(check.log).toMatch(/^\.git\/ways\/runs\/test-[a-z0-9]+\.log$/);
    expect(check.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    const criterion = result.evidence.criteria.AC1!;
    expect(criterion.summary).toContain("tests/test_cart.py::test_applies_discount");
    expect(criterion.log).toMatch(/^\.git\/ways\/runs\/criterion-ac1-[a-z0-9]+\.log$/);
    expect(result.failures.join("\n")).toContain(`full log: ways run --show ${check.run}`);
    expect(result.failures.join("\n").length).toBeLessThan(2000);
  });

  it("names the configured checks when asked for one that is not", async () => {
    const repo = await project([]);
    await expect(runChecksCompact(repo.cwd, ["lint"])).rejects.toThrow(/No check named "lint" is configured \(configured: test\); add it with `ways check add lint -- <command>`/);
  });
});
