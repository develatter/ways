import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOutput, stripAnsi } from "../src/run/parsers.js";
import { renderRun, type RunRecord } from "../src/run/run.js";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", "run", `${name}.txt`), "utf8");

/** Thousands of lines of the logging a real suite prints, around the tool's own report. */
function noisy(core: string, lines = 6000): string {
  const noise = Array.from({ length: lines }, (_, index) => `[app] request ${index} handled in ${index % 97} ms user=u${index % 13} path=/api/items/${index}`);
  return [...noise.slice(0, lines / 2), core, ...noise.slice(lines / 2)].join("\n");
}

function record(check: string, command: string[], output: string, exitCode: number): RunRecord {
  const reading = readOutput(output, exitCode, command);
  return {
    v: 1, id: `${check}-abc12`, check, command, status: exitCode === 0 ? "passed" : "failed", exitCode, durationMs: 4321, bytes: output.length, lines: output.split("\n").length,
    tool: reading.tool, counts: reading.counts, failures: reading.failures, commit: "a".repeat(40), clean: true, at: new Date().toISOString(),
  };
}

const dirs = { top: "/repo", gitDir: "/repo/.git", common: "/repo/.git" };
const budget = { maxLines: 40, maxChars: 2000 };

describe("check output parsers", () => {
  it("vitest: counts and each failing test with its location and first error lines", () => {
    const reading = readOutput(fixture("vitest"), 1, ["npm", "test"]);
    expect(reading.tool).toBe("vitest");
    expect(reading.counts).toEqual({ failed: 2, passed: 18 });
    expect(reading.failures.map((failure) => failure.id)).toEqual(["tests/cart.test.ts > cart > applies the discount", "tests/cart.test.ts > cart > rejects negative quantities"]);
    expect(reading.failures[0]!.where).toBe("tests/cart.test.ts:22");
    expect(reading.failures[0]!.lines[0]).toBe("AssertionError: expected 90 to be 81 // Object.is equality");
    expect(reading.failures[0]!.lines.join("\n")).not.toMatch(/\d+\|/);
  });

  it("jest", () => {
    const reading = readOutput(fixture("jest"), 1, ["npx", "jest"]);
    expect(reading.tool).toBe("jest");
    expect(reading.counts).toEqual({ failed: 2, passed: 18 });
    expect(reading.failures.map((failure) => failure.id)).toEqual(["src/cart.test.js > cart > applies the discount", "src/cart.test.js > cart > rejects negative quantities"]);
    expect(reading.failures[0]!.where).toBe("src/cart.test.js:22");
  });

  it("pytest: node ids from the short summary, E lines and the location from FAILURES", () => {
    const reading = readOutput(fixture("pytest"), 1, ["python", "-m", "pytest"]);
    expect(reading.tool).toBe("pytest");
    expect(reading.counts).toEqual({ failed: 2, passed: 18 });
    expect(reading.failures).toEqual([
      { id: "tests/test_cart.py::test_applies_discount", where: "tests/test_cart.py:14", lines: ["assert 90 == 81", "+  where 90 = <bound method Cart.total of <shop.cart.Cart object at 0x7f>>()"] },
      { id: "tests/test_cart.py::test_rejects_negative_quantities", where: "tests/test_cart.py:22", lines: ["Failed: DID NOT RAISE <class 'ValueError'>"] },
    ]);
  });

  it("cargo test", () => {
    const reading = readOutput(fixture("cargo"), 101, ["cargo", "test"]);
    expect(reading.tool).toBe("cargo");
    expect(reading.counts).toEqual({ passed: 18, failed: 2, skipped: 0 });
    expect(reading.failures[0]).toEqual({ id: "cart::tests::applies_discount", where: "src/cart.rs:48", lines: ["assertion `left == right` failed", "left: 90", "right: 81"] });
  });

  it("cargo build errors", () => {
    const reading = readOutput("error[E0425]: cannot find value `totl` in this scope\n  --> src/cart.rs:12:5\n   |\n12 |     totl\n   |     ^^^^ help: a local variable with a similar name exists: `total`\n\nerror: could not compile `shop` (lib) due to 1 previous error\n", 101, ["cargo", "test"]);
    expect(reading.failures).toEqual([{ id: "src/cart.rs:12 E0425", where: "src/cart.rs:12", lines: ["cannot find value `totl` in this scope"] }]);
  });

  it("go test, and a package that does not build", () => {
    const reading = readOutput(fixture("go"), 1, ["go", "test", "./..."]);
    expect(reading.tool).toBe("go");
    expect(reading.failures).toEqual([
      { id: "TestAppliesDiscount", where: "cart_test.go:18", lines: ["total = 90, want 81"] },
      { id: "TestRejectsNegativeQuantities", where: "cart_test.go:27", lines: ["expected an error for quantity -1"] },
    ]);
    const build = readOutput("# example.com/shop/cart\ncart/cart.go:9:2: undefined: totl\nFAIL\texample.com/shop/cart [build failed]\nFAIL\n", 1, ["go", "test", "./..."]);
    expect(build.failures).toEqual([{ id: "example.com/shop/cart [build failed]", where: "cart/cart.go:9", lines: ["cart/cart.go:9:2: undefined: totl"] }]);
  });

  it("tsc, eslint, ruff and mypy: one failure per error, by file and line", () => {
    expect(readOutput(fixture("tsc"), 2, ["npx", "tsc", "--noEmit"]).failures.map((failure) => failure.id)).toEqual(["src/cart.ts:22 TS2322", "src/checkout/index.ts:8 TS2345"]);
    const eslint = readOutput(fixture("eslint"), 1, ["npx", "eslint", "."]);
    expect(eslint.counts).toEqual({ errors: 2, warnings: 1 });
    expect(eslint.failures.map((failure) => failure.id)).toEqual(["/home/dev/shop/src/cart.js:12 no-unused-vars", "/home/dev/shop/src/checkout/index.js:4 no-undef"]);
    const ruff = readOutput(fixture("ruff"), 1, ["ruff", "check", "."]);
    expect(ruff.tool).toBe("ruff");
    expect(ruff.failures.map((failure) => failure.id)).toEqual(["shop/cart.py:1 F401", "shop/checkout.py:14 E711"]);
    expect(readOutput("shop/cart.py:1:8: F401 [*] `os` imported but unused\nFound 1 error.\n", 1, ["ruff", "check"]).failures[0]!.lines).toEqual(["`os` imported but unused"]);
    const mypy = readOutput(fixture("mypy"), 1, ["mypy", "."]);
    expect(mypy.tool).toBe("mypy");
    expect(mypy.failures.map((failure) => failure.id)).toEqual(["shop/cart.py:22 assignment", "shop/checkout.py:8 arg-type"]);
  });

  it("an unknown tool gets the generic reading: exit code, error-looking lines and the tail", () => {
    const reading = readOutput("step 1 ok\nstep 2 ok\nFatal: database is locked\nstep 3 skipped\n", 3, ["./ci.sh"]);
    expect(reading.tool).toBe("generic");
    expect(reading.failures[0]!.id).toBe("exit 3");
    expect(reading.failures[0]!.lines).toContain("Fatal: database is locked");
  });

  it("a known tool that crashed before its report still shows why, and colours are stripped", () => {
    const reading = readOutput("\u001b[31m RUN  v3.2.4\u001b[0m\n Test Files  0 passed\nError: Cannot find package 'zod'\n", 1, ["npx", "vitest", "run"]);
    expect(reading.failures[0]!.lines).toContain("Error: Cannot find package 'zod'");
    expect(stripAnsi("\u001b[32m✓\u001b[39m ok")).toBe("✓ ok");
  });

  it("a passing run is one line", () => {
    const text = renderRun(dirs, record("test", ["npm", "test"], noisy(" Test Files  2 passed (2)\n      Tests  20 passed (20)\n"), 0), budget);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toMatch(/^✓ test: passed in 4\.3 s — 20 passed \(log: ways run --show test-abc12\)$/);
  });

  it("thousands of lines of output come back as a summary within the budget, failures first", () => {
    const rows: string[] = [];
    for (const [name, command, exit] of [["vitest", ["npm", "test"], 1], ["pytest", ["python", "-m", "pytest"], 1], ["cargo", ["cargo", "test"], 101], ["go", ["go", "test", "./..."], 1], ["jest", ["npx", "jest"], 1]] as const) {
      const raw = noisy(fixture(name));
      expect(raw.split("\n").length).toBeGreaterThan(5000);
      const text = renderRun(dirs, record("test", [...command], raw, exit), budget);
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(text.split("\n").length).toBeLessThanOrEqual(40);
      expect(text).toMatch(/discount|Discount/);
      expect(text).toContain("ways run --show test-abc12");
      expect(text).toContain(".git/ways/runs/test-abc12.log");
      rows.push(`${name}: raw ${raw.length} chars → summary ${text.length} chars (${(100 - (100 * text.length) / raw.length).toFixed(2)} % less)`);
    }
    console.log(rows.join("\n"));
  });

  it("new failures are told apart from those that already failed at the base", () => {
    const run = record("test", ["npm", "test"], fixture("vitest"), 1);
    const text = renderRun(dirs, run, budget, { against: "the base", base: "b".repeat(40), fresh: ["tests/cart.test.ts > cart > applies the discount"], known: ["tests/cart.test.ts > cart > rejects negative quantities"] });
    expect(text.split("\n")[0]).toContain("1 new, 1 already failing at bbbbbbbbbbbb");
    expect(text).toContain("✗ new tests/cart.test.ts > cart > applies the discount");
    expect(text).toContain("already failing at the base: tests/cart.test.ts > cart > rejects negative quantities");
  });

  it("a tight budget counts what it could not show", () => {
    const many = Array.from({ length: 60 }, (_, index) => `FAILED tests/test_x.py::test_${index} - assert ${index} == -1`).join("\n");
    const text = renderRun(dirs, record("test", ["pytest"], `===== test session starts =====\n${many}\n===== 60 failed, 2 passed in 1.00s =====\n`, 1), { maxLines: 12, maxChars: 800 });
    expect(text.split("\n").length).toBeLessThanOrEqual(12);
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toMatch(/… \d+ more failure\(s\) in the log/);
  });
});
