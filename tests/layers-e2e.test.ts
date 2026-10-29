import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/*
 * The three layers as a consumer gets them, from the packed tarball: a Node
 * and a Python repository bootstrapped with no options (checks detected and
 * run once), `ways run` on a test suite that prints thousands of lines and
 * already had a broken test, and `ways onboard` with a stand-in agent. It
 * prints what it measured, for the record.
 */
const root = process.cwd();
let cli = "";

function consumerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WAYS_") && key !== "CLAUDECODE" && key !== "CLAUDE_ENV_FILE" && key !== "PI_CODING_AGENT"));
  return { ...base, WAYS_CLI: cli, ...extra };
}

function sh(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv = consumerEnv()): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function repo(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Layers E2E"], ["config", "user.email", "e2e@example.test"], ["config", "commit.gpgSign", "false"]]) execFileSync("git", args, { cwd });
  return cwd;
}

/** The project as it was before ways: committed, so the checks' line base is a commit. */
function commitAll(cwd: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd });
}

/** A runner that prints like pytest: 6,000 lines of logging, then a FAILED line per name in failing.txt. */
const PYTEST_LIKE = `
const fs = require("node:fs");
const failing = fs.existsSync("failing.txt") ? fs.readFileSync("failing.txt", "utf8").split("\\n").filter(Boolean) : [];
const out = ["============================= test session starts =============================="];
for (let i = 0; i < 6000; i += 1) out.push("[app] request " + i + " handled in " + (i % 97) + " ms user=u" + (i % 13) + " path=/api/items/" + i);
if (failing.length) {
  out.push("=================================== FAILURES ===================================");
  for (const name of failing) out.push("____ " + name + " ____", "", ">       assert total == 81", "E       assert 90 == 81", "", "tests/test_cart.py:14: AssertionError");
  out.push("=========================== short test summary info ============================");
  for (const name of failing) out.push("FAILED tests/test_cart.py::" + name + " - assert 90 == 81");
}
out.push("========================= " + (failing.length ? failing.length + " failed, " : "") + "120 passed in 2.31s =========================");
process.stdout.write(out.join("\\n") + "\\n");
process.exitCode = failing.length ? 1 : 0;
`;

beforeAll(async () => {
  const packDir = await mkdtemp(join(tmpdir(), "ways-layers-pack-"));
  execFileSync("npm", ["pack", "--pack-destination", packDir], { cwd: root, stdio: "ignore" });
  const [file] = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  const tools = await mkdtemp(join(tmpdir(), "ways-layers-tools-"));
  execFileSync("npm", ["init", "-y"], { cwd: tools, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", join(packDir, file!)], { cwd: tools, stdio: "ignore" });
  cli = join(tools, "node_modules/@develatter/ways/dist/cli.js");
}, 600_000);

describe("the three layers, from the packed tarball", () => {
  it("a Node repository: detected checks, a short AGENTS.md, MAP.md apart, and ways run on a huge failing suite", async () => {
    const cwd = await repo("ways-layers-node-");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "shop", description: "Checkout and pricing for the shop", scripts: { test: "node runner.js", lint: "node -e \"console.log('0 problems')\"", typecheck: "tsc --noEmit" } }, null, 2));
    await writeFile(join(cwd, "runner.js"), PYTEST_LIKE);
    await writeFile(join(cwd, "failing.txt"), "test_already_broken\n");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/cart.js"), "module.exports = {};\n");
    await mkdir(join(cwd, ".github/workflows"), { recursive: true });
    await writeFile(join(cwd, ".github/workflows/ci.yml"), "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n");
    commitAll(cwd, "feat: the shop");
    const boot = sh(cwd, process.execPath, [cli, "bootstrap"]);
    expect(boot.status, boot.stdout + boot.stderr).toBe(0);
    const files = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" }).trim().split("\n").filter((path) => !["package.json", "runner.js", "failing.txt", "src/cart.js", ".github/workflows/ci.yml"].includes(path));
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    const map = readFileSync(join(cwd, "MAP.md"), "utf8");
    const checks = JSON.parse(readFileSync(join(cwd, ".ways/checks.json"), "utf8")) as { checks: Record<string, { command: string[]; baseline?: { status: string; failures?: string[] } }> };
    console.info(`--- Node: bootstrap output\n${boot.stdout}--- ${files.length} files written:\n${files.join("\n")}\n--- AGENTS.md (${agents.split("\n").length} lines)\n${agents}\n--- MAP.md\n${map}\n--- .ways/checks.json\n${JSON.stringify(checks, null, 2)}\n--- .ways/onboarding.json\n${readFileSync(join(cwd, ".ways/onboarding.json"), "utf8")}`);
    expect(agents.split("\n").length).toBeLessThanOrEqual(100);
    expect(agents).toContain("| Test | `npx ways run test` (runs `npm test`) |");
    expect(agents).not.toMatch(/\((?:path|npm ci|One or two)/);
    expect(map).toContain("Stack: Node.js/TypeScript (npm, `package.json`).");
    expect(checks.checks.test?.baseline).toMatchObject({ status: "failed", failures: ["tests/test_cart.py::test_already_broken"] });
    expect(checks.checks.typecheck).toBeUndefined();
    expect(files.length).toBeLessThanOrEqual(30);
    execFileSync("git", ["add", "-A"], { cwd, env: consumerEnv() });
    execFileSync("git", ["commit", "-q", "-m", "chore: install ways"], { cwd, env: consumerEnv() });

    // A change that breaks one more test, on top of the one that was already broken.
    await writeFile(join(cwd, "failing.txt"), "test_already_broken\ntest_applies_discount\n");
    const raw = sh(cwd, "npm", ["test"]).stdout;
    const failing = sh(cwd, process.execPath, [cli, "run", "test"]);
    expect(failing.status).toBe(1);
    expect(failing.stdout.length).toBeLessThanOrEqual(2000);
    expect(failing.stdout).toMatch(/1 new, 1 already failing at [0-9a-f]{12}/);
    expect(failing.stdout).toContain("✗ new tests/test_cart.py::test_applies_discount");
    expect(failing.stdout).toMatch(/Full log \(\d+ lines\): ways run --show test-/);
    await writeFile(join(cwd, "failing.txt"), "");
    const green = sh(cwd, process.execPath, [cli, "run", "test"]);
    expect(green.status).toBe(0);
    expect(green.stdout.trim().split("\n")).toHaveLength(1);
    console.info(`--- Node: npm test printed ${raw.length} characters (${raw.split("\n").length} lines); ways run test printed ${failing.stdout.length}:\n${failing.stdout}--- all green:\n${green.stdout}`);
  }, 900_000);

  it("a Python repository: pytest found and run (a stand-in python on PATH), a missing linter rejected", async () => {
    const bin = await mkdtemp(join(tmpdir(), "ways-layers-bin-"));
    await writeFile(join(bin, "python"), `#!/bin/sh\nif [ "$1" = "-m" ] && [ "$2" = "pytest" ]; then exec node "$PWD/runner.js"; fi\necho "/usr/bin/python: No module named $2" >&2\nexit 1\n`);
    chmodSync(join(bin, "python"), 0o755);
    const env = consumerEnv({ PATH: `${bin}${delimiter}${process.env.PATH}` });
    const cwd = await repo("ways-layers-python-");
    await writeFile(join(cwd, "pyproject.toml"), "[project]\nname = \"inventory\"\ndescription = \"Stock levels per warehouse\"\n\n[project.scripts]\ninventory = \"inventory.cli:main\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n\n[tool.ruff]\nline-length = 100\n");
    await writeFile(join(cwd, "runner.js"), PYTEST_LIKE);
    await mkdir(join(cwd, "tests"));
    await writeFile(join(cwd, "tests/test_cart.py"), "def test_ok():\n    assert True\n");
    await mkdir(join(cwd, "inventory"));
    await writeFile(join(cwd, "inventory/__main__.py"), "print('hi')\n");
    commitAll(cwd, "feat: inventory");
    const boot = sh(cwd, process.execPath, [cli, "bootstrap"], env);
    expect(boot.status, boot.stdout + boot.stderr).toBe(0);
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    const map = readFileSync(join(cwd, "MAP.md"), "utf8");
    console.info(`--- Python: bootstrap output\n${boot.stdout}${boot.stderr}--- AGENTS.md\n${agents}\n--- MAP.md\n${map}\n--- .ways/checks.json\n${readFileSync(join(cwd, ".ways/checks.json"), "utf8")}`);
    expect(boot.stdout).toMatch(/✓ test: python -m pytest — passes/);
    expect(boot.stdout).toMatch(/✗ lint: python -m ruff check \. — rejected: .*No module named ruff/);
    expect(agents).toContain("| Test | `npx ways run test` (runs `python -m pytest`) |");
    expect(agents).toContain("inventory: Stock levels per warehouse. Python (pip).");
    expect(map).toContain("Stack: Python (pip, `pyproject.toml`).");
    expect(map).toContain("- `inventory/__main__.py` — python -m entry");
    expect(map).toContain("| `tests/` |");
    expect(JSON.parse(readFileSync(join(cwd, ".ways/onboarding.json"), "utf8"))).toMatchObject({ status: "pending" });
  }, 900_000);

  it("ways onboard with a stand-in agent, and one that writes outside its paths", async () => {
    const cwd = await repo("ways-layers-onboard-");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "node -e \"console.log('# pass 1')\"" } }));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/money.js"), "module.exports = (cents) => cents;\n");
    commitAll(cwd, "feat: money");
    expect(sh(cwd, process.execPath, [cli, "bootstrap", "--agents=claude,pi"]).status).toBe(0);
    execFileSync("git", ["add", "-A"], { cwd, env: consumerEnv() });
    execFileSync("git", ["commit", "-q", "-m", "chore: install ways"], { cwd, env: consumerEnv() });
    const agentDir = await mkdtemp(join(tmpdir(), "ways-layers-agent-"));
    await writeFile(join(agentDir, "good.js"), `
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeFileSync(".ways/map-notes.json", JSON.stringify({ "src/": "Pricing: amounts in integer cents" }));
fs.mkdirSync(".ways/knowledge/pitfalls", { recursive: true });
fs.writeFileSync(".ways/knowledge/pitfalls/money.md", "---\\ntype: pitfall\\ntitle: Amounts are integer cents\\npaths: [\\"src/**\\"]\\nsources:\\n  - resource: /src/money.js\\n---\\nAmounts are integer cents; never add floats.\\n");
const checks = JSON.parse(fs.readFileSync(".ways/checks.json", "utf8"));
checks.proposed = { lint: { command: ["node", "-e", "console.log('0 problems')"] }, e2e: { command: ["no-such-e2e-runner"] } };
fs.writeFileSync(".ways/checks.json", JSON.stringify(checks));
console.log("wrote 1 note, 1 fact, 2 proposed checks");
`);
    await writeFile(join(agentDir, "rogue.js"), "require('node:fs').readFileSync(0, 'utf8'); require('node:fs').writeFileSync('src/money.js', 'hacked');\n");
    const asked = sh(cwd, process.execPath, [cli, "onboard", `--agent=node ${join(agentDir, "good.js")}`]);
    expect(asked.status).toBe(2);
    expect(asked.stdout).toContain("ways onboard --yes");
    const rogue = sh(cwd, process.execPath, [cli, "onboard", `--agent=node ${join(agentDir, "rogue.js")}`, "--yes"]);
    expect(rogue.status).toBe(1);
    expect(rogue.stdout).toContain("src/money.js");
    execFileSync("git", ["checkout", "--", "src/money.js"], { cwd });
    const good = sh(cwd, process.execPath, [cli, "onboard", `--agent=node ${join(agentDir, "good.js")}`, "--yes", "--json"]);
    const report = JSON.parse(good.stdout) as { status: string; summary: { facts: string[]; unverified: string[]; checks: string[]; rejected: Array<{ check: string }> } };
    console.info(`--- ways onboard (stand-in agent):\n${JSON.stringify(report, null, 2)}`);
    expect(report.status).toBe("done");
    expect(report.summary).toMatchObject({ facts: ["pitfalls/money"], unverified: ["pitfalls/money"], checks: ["test", "lint"] });
    expect(report.summary.rejected.map((entry) => entry.check)).toEqual(["e2e"]);
    expect(readFileSync(join(cwd, "MAP.md"), "utf8")).toContain("Pricing: amounts in integer cents");
    expect(sh(cwd, process.execPath, [cli, "memory", "check"]).status).toBe(0);
    expect(sh(cwd, process.execPath, [cli, "map", "--check"]).status).toBe(0);
  }, 900_000);
});
