import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VERIFIER_PATHS } from "../src/domain/constants.js";
import { verifierChanges } from "../src/work/evaluate.js";
import { done, startChange } from "../src/work/work.js";
import { installed, repository } from "./helpers.js";

/*
 * What on the verifier surface needs approval is decided by what changed
 * inside the file, not by whether the file existed: adding tests to an
 * existing test file is the common case and stays free.
 */

const TEST = "tests/math.test.mjs";
const ORIGINAL = [
  "import { add } from '../src/math.mjs';",
  "import assert from 'node:assert';",
  "test('adds', () => {",
  "  assert.equal(add(1, 2), 3);",
  "});",
  "",
].join("\n");

async function write(cwd: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(cwd, path), { force: true });
      continue;
    }
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
}

/** The verifier changes a commit with `files` (null deletes) makes over a base with the original test. */
async function changesOf(files: Record<string, string | null>, base: Record<string, string> = {}): Promise<string[]> {
  const { cwd, git } = await repository();
  // ways is installed in the base: adding check configuration then counts.
  await write(cwd, { [TEST]: ORIGINAL, "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n", ".ways/config.json": "{}\n", ...base });
  await git.run(["add", "-A"]);
  await git.run(["commit", "-q", "-m", "base"]);
  const from = await git.head();
  await write(cwd, files);
  await git.run(["add", "-A"]);
  await git.run(["commit", "-q", "--allow-empty", "-m", "change"]);
  return verifierChanges(git, from, await git.head(), DEFAULT_VERIFIER_PATHS);
}

describe("the verifier surface, by content", () => {
  it("lets a test be appended to an existing test file", async () => {
    expect(await changesOf({ [TEST]: `${ORIGINAL}test('adds zero', () => {\n  assert.equal(add(0, 2), 2);\n});\n` })).toEqual([]);
  });

  it("lets a test be inserted between existing ones", async () => {
    const inserted = ORIGINAL.replace("test('adds'", "test('first', () => {\n  assert.ok(add);\n});\ntest('adds'");
    expect(await changesOf({ [TEST]: inserted })).toEqual([]);
  });

  it("lets an import of the same module name more things", async () => {
    const widened = ORIGINAL.replace("import { add } from", "import { add, mul } from");
    expect(await changesOf({ [TEST]: `${widened}test('muls', () => {\n  assert.equal(mul(2, 3), 6);\n});\n` })).toEqual([]);
  });

  it("lets new test files and new test helpers in", async () => {
    expect(await changesOf({ "tests/new.test.mjs": "test('new', () => {});\n", "tests/helpers/data.json": "{}\n" })).toEqual([]);
  });

  it.each([
    ["deleting an assertion", ORIGINAL.replace("  assert.equal(add(1, 2), 3);\n", "")],
    ["commenting a test out", ORIGINAL.replace("test('adds'", "// test('adds'")],
    ["changing an expectation", ORIGINAL.replace("3);", "4);")],
    ["skipping an existing test", ORIGINAL.replace("test('adds'", "test.skip('adds'")],
    ["importing from another module", ORIGINAL.replace("from '../src/math.mjs'", "from '../src/fake.mjs'")],
    ["importing fewer names", ORIGINAL.replace("import { add } from", "import { } from")],
    ["adding a skipped test", `${ORIGINAL}test.skip('later', () => {});\n`],
    ["adding a focused test, which narrows the run", `${ORIGINAL}it.only('mine', () => {});\n`],
    ["adding a disabled Java test", `${ORIGINAL}@Disabled\n`],
    ["adding a pytest skip", `${ORIGINAL}@pytest.mark.skip(reason="later")\n`],
    ["adding xit", `${ORIGINAL}xit('later', () => {});\n`],
  ])("needs approval for %s", async (_name, content) => {
    expect(await changesOf({ [TEST]: content })).toEqual([TEST]);
  });

  it("needs approval for deleting a test file", async () => {
    expect(await changesOf({ [TEST]: null })).toEqual([TEST]);
  });

  it("needs approval for a new test file that focuses the run", async () => {
    expect(await changesOf({ "tests/new.test.mjs": "describe.only('new', () => {});\n" })).toEqual(["tests/new.test.mjs"]);
  });

  it("needs approval for adding or changing the configuration of checks, even by appending", async () => {
    expect(await changesOf({ "vitest.config.mjs": "export default { test: { include: ['nothing'] } };\n" })).toEqual(["vitest.config.mjs"]);
    expect(await changesOf({ ".github/workflows/ci.yml": "on: push\njobs: {}\n" }, { ".github/workflows/ci.yml": "on: push\n" })).toEqual([".github/workflows/ci.yml"]);
    // A new pipeline only adds jobs; branch protection says which are required.
    expect(await changesOf({ ".github/workflows/extra.yml": "on: push\n" })).toEqual([]);
    expect(await changesOf({ "conftest.py": "def pytest_collection_modifyitems(items):\n    items.clear()\n" })).toEqual(["conftest.py"]);
    expect(await changesOf({ "tests/conftest.py": "import pytest\n# appended\n" }, { "tests/conftest.py": "import pytest\n" })).toEqual(["tests/conftest.py"]);
    expect(await changesOf({ "package.json": "{\"scripts\":{\"test\":\"true\"}}\n" })).toEqual(["package.json"]);
    // A dependency bump is not a change of the checks.
    expect(await changesOf({ "package.json": "{\"scripts\":{\"test\":\"node --test\"},\"dependencies\":{\"x\":\"1\"}}\n" })).toEqual([]);
  });

  it("lets a check be added to the config, but not changed or dropped", async () => {
    const config = (commands: unknown, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ schemaVersion: 2, testCommand: ["npm", "test"], ...(commands ? { commands } : {}), ...extra })}\n`;
    const base = { ".ways/config.json": config(undefined) };
    // `ways check add lint` on a base that ran only the test command.
    expect(await changesOf({ ".ways/config.json": config({ required: ["test", "lint"], test: ["npm", "test"], lint: ["npm", "run", "lint"] }) }, base)).toEqual([]);
    expect(await changesOf({ ".ways/config.json": config({ required: ["test"], test: ["true"] }) }, base)).toEqual([".ways/config.json"]);
    const two = { ".ways/config.json": config({ required: ["test", "lint"], test: ["npm", "test"], lint: ["npm", "run", "lint"] }) };
    expect(await changesOf({ ".ways/config.json": config({ required: ["test"], test: ["npm", "test"], lint: ["npm", "run", "lint"] }) }, two)).toEqual([".ways/config.json"]);
    expect(await changesOf({ ".ways/config.json": config({ required: ["test", "lint"], test: ["npm", "test"], lint: ["npm", "run", "lint"] }, { review: "none" }) }, two)).toEqual([".ways/config.json"]);
  });

  it("ignores dependency and build directories that happen to match a test glob", async () => {
    const vendored = { "node_modules/lib/a.test.js": "assert(1);\n", "vendor/lib/b_test.go": "x\n", "dist/c.spec.js": "x\n", "coverage/d.test.js": "x\n" };
    expect(await changesOf(Object.fromEntries(Object.keys(vendored).map((path) => [path, "changed\n"])), vendored)).toEqual([]);
  });

  it("takes extra disabling markers from the configuration", async () => {
    const { cwd, git } = await repository();
    await write(cwd, { [TEST]: ORIGINAL });
    await git.run(["add", "-A"]);
    await git.run(["commit", "-q", "-m", "base"]);
    const from = await git.head();
    await write(cwd, { [TEST]: `${ORIGINAL}quarantine('adds');\n` });
    await git.run(["commit", "-qam", "change"]);
    expect(await verifierChanges(git, from, await git.head(), DEFAULT_VERIFIER_PATHS)).toEqual([]);
    expect(await verifierChanges(git, from, await git.head(), DEFAULT_VERIFIER_PATHS, [], ["\\bquarantine\\("])).toEqual([TEST]);
  });
});

describe("ways done on a test added to an existing file", () => {
  async function project(): Promise<Awaited<ReturnType<typeof installed>>> {
    const repo = await installed({ testCommand: ["node", "-e", "process.exit(0)"] });
    await write(repo.cwd, { [TEST]: ORIGINAL });
    await repo.git.run(["add", "-A"]);
    await repo.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: tests"]);
    return repo;
  }

  it("closes without a human", async () => {
    const { cwd, git } = await project();
    await startChange(cwd, "more-tests");
    await write(cwd, { [TEST]: `${ORIGINAL}test('adds zero', () => {\n  assert.equal(add(0, 2), 2);\n});\n` });
    await git.run(["commit", "-qam", "test: adds zero"]);
    const result = await done(cwd);
    expect(result).toMatchObject({ status: "closed", pending: {} });
    expect(result.evidence.verifierChanges).toEqual([]);
  });

  it("waits for the human when an assertion goes", async () => {
    const { cwd, git } = await project();
    await startChange(cwd, "fewer-asserts");
    await write(cwd, { [TEST]: ORIGINAL.replace("  assert.equal(add(1, 2), 3);\n", "") });
    await git.run(["commit", "-qam", "test: drop an assertion"]);
    const result = await done(cwd);
    expect(result.status).toBe("verifying");
    expect(result.pending.approval).toMatch(/tests\/math\.test\.mjs/);
  });
});
