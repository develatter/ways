import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { writeMap } from "../src/map/map.js";
import { readChecksFile } from "../src/run/checks-file.js";
import { repository } from "./helpers.js";

const PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH;
});

/** A `python` on PATH that runs `-m pytest` like pytest would, and knows no other module. */
async function fakePython(failing: string[] = []): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), "ways-python-"));
  const script = `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pytest" ]; then
  echo "============================= test session starts =============================="
  echo "collected 3 items"
${failing.map((name) => `  echo "FAILED tests/test_app.py::${name} - assert 1 == 2"`).join("\n")}
  echo "========================= ${failing.length ? `${failing.length} failed, ` : ""}2 passed in 0.01s ========================="
  exit ${failing.length ? 1 : 0}
fi
echo "/usr/bin/python: No module named $2" >&2
exit 1
`;
  await writeFile(join(bin, "python"), script);
  await chmod(join(bin, "python"), 0o755);
  process.env.PATH = `${bin}${delimiter}${PATH}`;
}

describe("the first session's three layers", () => {
  it("a Node project: checks detected and validated, AGENTS.md short with the real commands, MAP.md apart", async () => {
    const { cwd } = await repository("ways-node-");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "shop", description: "A small shop", scripts: { test: "node test.js", lint: "node lint.js", build: "node -e \"process.exit(0)\"", typecheck: "ways-missing-tsc" }, devDependencies: { "@develatter/ways": "^0.3.0" } }, null, 2));
    await writeFile(join(cwd, "test.js"), "console.log('# tests 3'); console.log('# pass 3');\n");
    await writeFile(join(cwd, "lint.js"), "console.log('0 problems');\n");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/index.js"), "export const x = 1;\n");
    const result = await bootstrap({ cwd });
    const accepted = result.validation.accepted.map((entry) => entry.name);
    expect(accepted).toEqual(["test", "lint", "build"]);
    expect(result.validation.rejected).toEqual([expect.objectContaining({ name: "typecheck", command: ["npm", "run", "typecheck"] })]);

    const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agents.split("\n").length).toBeLessThanOrEqual(100);
    expect(agents).toContain("shop: A small shop. Node.js/TypeScript (npm).");
    expect(agents).toContain("| Test | `npx ways run test` (runs `npm test`) |");
    expect(agents).toContain("| Lint | `npx ways run lint` (runs `npm run lint`) |");
    expect(agents).not.toContain("typecheck");
    expect(agents).not.toMatch(/\((?:path|npm ci|One or two)/);

    const map = await readFile(join(cwd, "MAP.md"), "utf8");
    expect(map).toContain("| `src/` | 1 |");
    expect(map).toContain("Stack: Node.js/TypeScript (npm, `package.json`).");
    expect(map).toContain("| Test | `ways run test` → `npm test` | package.json scripts.test (validated) |");
    expect(map).toContain("| Type check | `npm run typecheck` | package.json scripts.typecheck |");

    const config = JSON.parse(await readFile(join(cwd, ".ways/config.json"), "utf8"));
    expect(config.commands).toEqual({ required: ["test", "lint", "build"], test: ["npm", "test"], lint: ["npm", "run", "lint"], build: ["npm", "run", "build"] });
    expect(readChecksFile(cwd).checks.test).toMatchObject({ command: ["npm", "test"], source: "package.json scripts.test", baseline: { status: "passed" } });
    expect(JSON.parse(await readFile(join(cwd, ".ways/onboarding.json"), "utf8"))).toMatchObject({ status: "pending" });
    console.info(`Node bootstrap: ${result.files.length} files\n${result.files.join("\n")}`);
    expect((await writeMap(cwd, { check: true })).drift.reasons).toEqual([]);
  }, 120_000);

  it("a Python project: pytest validated with the failures it already has as the line base; a missing linter rejected", async () => {
    await fakePython(["test_broken"]);
    const { cwd } = await repository("ways-python-");
    await writeFile(join(cwd, "pyproject.toml"), "[project]\nname = \"inventory\"\ndescription = \"Stock levels\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n\n[tool.ruff]\nline-length = 100\n");
    await mkdir(join(cwd, "tests"));
    await writeFile(join(cwd, "tests/test_app.py"), "def test_ok():\n    assert True\n");
    await mkdir(join(cwd, "inventory"));
    await writeFile(join(cwd, "inventory/__main__.py"), "print('hi')\n");
    const result = await bootstrap({ cwd, agents: [] });
    expect(result.validation.accepted.map((entry) => [entry.name, entry.command])).toEqual([["test", ["python", "-m", "pytest"]]]);
    expect(result.validation.rejected.map((entry) => entry.name)).toEqual(["lint", "lint"]);
    expect(result.validation.rejected[0]!.reason).toMatch(/No module named ruff/);
    expect(readChecksFile(cwd).checks.test?.baseline).toMatchObject({ status: "failed", failures: ["tests/test_app.py::test_broken"] });

    const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("inventory: Stock levels. Python (pip).");
    expect(agents).toContain("| Test | `npx ways run test` (runs `python -m pytest`) |");
    expect(agents).not.toContain("ruff");
    const map = await readFile(join(cwd, "MAP.md"), "utf8");
    expect(map).toContain("Stack: Python (pip, `pyproject.toml`).");
    expect(map).toContain("- `inventory/__main__.py` — python -m entry");
    expect(map).toContain("- 1 test file(s) in `tests/`, named test_*.py.");
    console.info(`Python bootstrap: ${result.files.length} files`);
  }, 120_000);

  it("an unrecognised stack: MAP.md says so and gives only the layout; the test check says how to add one", async () => {
    const { cwd } = await repository("ways-plain-");
    await mkdir(join(cwd, "notes"));
    await writeFile(join(cwd, "notes/a.txt"), "a\n");
    const result = await bootstrap({ cwd, agents: [] });
    expect(result.validation.accepted).toEqual([]);
    const map = await readFile(join(cwd, "MAP.md"), "utf8");
    expect(map).toMatch(/Stack: not recognised .* only the layout is shown\./);
    expect(map).toContain("| `notes/` | 1 |");
    const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("No check was found that runs: add one with `npx ways check add test -- <command>`");
  }, 60_000);

  it("ways map keeps the notes and says when the map drifted", async () => {
    const { cwd } = await repository("ways-map-");
    await mkdir(join(cwd, "api"));
    await writeFile(join(cwd, "api/server.js"), "\n");
    await bootstrap({ cwd, testCommand: ["node", "-e", "0"], agents: [] });
    await writeFile(join(cwd, ".ways/map-notes.json"), JSON.stringify({ api: "HTTP handlers; no business logic here", "gone/": "removed folder" }));
    expect((await writeMap(cwd, { check: true })).drift.reasons).toEqual(["the stack, commands, entry points, CI or notes changed"]);
    const written = await writeMap(cwd);
    expect(written.orphans).toEqual(["gone/"]);
    expect(await readFile(join(cwd, "MAP.md"), "utf8")).toContain("| `api/` | 1 | HTTP handlers; no business logic here |");
    await mkdir(join(cwd, "web"));
    await writeFile(join(cwd, "web/index.html"), "\n");
    expect((await writeMap(cwd, { check: true })).drift.reasons).toEqual(["new top-level folder(s) web/"]);
  }, 60_000);
});
