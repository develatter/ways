import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { CHECK_NAMES, type CheckName } from "../domain/types.js";

/**
 * What can be read from a repository without an agent: its stacks (from
 * manifests), the commands they define, entry points, where the tests are,
 * what is generated or ignored, and the CI files. Deterministic and cheap (a
 * few small files read), so `ways map` reruns it every time and `ways
 * bootstrap` uses it for AGENTS.md and the checks. Nothing here is executed:
 * a detected check command becomes a check only after ways ran it.
 */
export type StackId = "node" | "python" | "rust" | "go" | "java";
export type Task = "install" | CheckName | "run";
export const TASKS: readonly Task[] = ["install", "build", "test", "lint", "typecheck", "e2e", "run"];

export interface Stack {
  id: StackId;
  /** The manifest it was recognised by. */
  manifest: string;
  /** Package manager or build tool: npm, pnpm, yarn, bun, poetry, uv, pip, cargo, go, maven, gradle. */
  tool: string;
}

export interface DetectedCommand {
  task: Task;
  argv: string[];
  /** Where it was read from, for the human: `package.json scripts.test`, `Cargo.toml`. */
  source: string;
}

export interface EntryPoint {
  path: string;
  why: string;
}

export interface Detection {
  name: string;
  description?: string;
  stacks: Stack[];
  /** The preferred command per task, in task order. */
  commands: DetectedCommand[];
  /** Every candidate per check, best first: validation keeps the first one that works. */
  candidates: Partial<Record<CheckName, DetectedCommand[]>>;
  entryPoints: EntryPoint[];
  tests: { dirs: string[]; patterns: string[]; count: number };
  ignored: string[];
  ci: string[];
  /** Manifests found anywhere in the repository (monorepo packages included), repository-relative. */
  manifests: string[];
}

export const MANIFEST_NAMES = ["package.json", "pyproject.toml", "requirements.txt", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"] as const;
const CI_FILES = [/^\.github\/workflows\/[^/]+\.ya?ml$/, /^\.gitlab-ci\.yml$/, /^\.circleci\/config\.ya?ml$/, /^Jenkinsfile$/, /^azure-pipelines\.ya?ml$/, /^\.buildkite\/[^/]+\.ya?ml$/];
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
const TEST_FILE_PATTERNS: Array<[RegExp, string]> = [
  [/\.(test|spec)\.[cm]?[jt]sx?$/, "*.test.* / *.spec.*"],
  [/(^|\/)test_[^/]+\.py$/, "test_*.py"],
  [/_test\.py$/, "*_test.py"],
  [/_test\.go$/, "*_test.go"],
  [/(Test|Tests|IT)\.(java|kt)$/, "*Test.java"],
  [/(^|\/)tests\/[^/]+\.rs$/, "tests/*.rs"],
];
const CODE = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb|php|cs|swift|scala)$/;
const DEFAULT_NPM_TEST = /no test specified/;

function read(top: string, path: string): string | undefined {
  try {
    return readFileSync(join(top, path), "utf8");
  } catch {
    return undefined;
  }
}

function json(top: string, path: string): Record<string, unknown> | undefined {
  const text = read(top, path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** A value from the first `[section]` of a TOML file that has it; enough for names and descriptions, not a TOML parser. */
function tomlValue(text: string, section: string, key: string): string | undefined {
  let current = "";
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1]!.trim();
      continue;
    }
    if (current !== section) continue;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`));
    if (match) return match[1];
  }
  return undefined;
}

function tomlKeys(text: string, section: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  let current = "";
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1]!.trim();
      continue;
    }
    if (current !== section) continue;
    const match = line.match(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*=\s*["']([^"']*)["']/);
    if (match) found.push([match[1]!, match[2]!]);
  }
  return found;
}

function xmlValue(text: string, tag: string): string | undefined {
  // The project's own element, not a parent's or a dependency's.
  const stripped = text.replace(/<parent>[\s\S]*?<\/parent>/g, "").replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "").replace(/<build>[\s\S]*?<\/build>/g, "");
  return stripped.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`))?.[1];
}

interface StackFacts {
  stack: Stack;
  commands: DetectedCommand[];
  entryPoints: EntryPoint[];
  name?: string;
  description?: string;
}

function command(task: Task, argv: string[], source: string): DetectedCommand {
  return { task, argv, source };
}

function nodeFacts(top: string, files: ReadonlySet<string>): StackFacts | undefined {
  const pkg = json(top, "package.json");
  if (!pkg) return undefined;
  const tool = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : files.has("bun.lockb") || files.has("bun.lock") ? "bun" : "npm";
  const scripts = strings(pkg.scripts);
  const run = (script: string): string[] => {
    if (script === "test") return tool === "bun" ? ["bun", "run", "test"] : [tool, "test"];
    if (tool === "yarn") return ["yarn", script];
    return [tool, "run", script];
  };
  const commands: DetectedCommand[] = [];
  const install = tool === "npm" ? (files.has("package-lock.json") || files.has("npm-shrinkwrap.json") ? ["npm", "ci"] : ["npm", "install"])
    : tool === "pnpm" ? ["pnpm", "install", "--frozen-lockfile"] : tool === "yarn" ? ["yarn", "install", "--frozen-lockfile"] : ["bun", "install"];
  commands.push(command("install", install, tool === "npm" && install[1] === "ci" ? "package-lock.json" : `${tool} (lockfile)`));
  const pick = (task: Task, names: string[]): void => {
    for (const name of names) {
      if (scripts[name] === undefined || (name === "test" && DEFAULT_NPM_TEST.test(scripts[name]!))) continue;
      commands.push(command(task, run(name), `package.json scripts.${name}`));
    }
  };
  pick("build", ["build", "compile"]);
  pick("test", ["test", "test:unit"]);
  pick("lint", ["lint", "lint:check"]);
  pick("typecheck", ["typecheck", "type-check", "check-types", "tsc", "types"]);
  pick("e2e", ["e2e", "test:e2e"]);
  pick("run", ["start", "dev", "serve"]);
  const deps = { ...strings(pkg.dependencies), ...strings(pkg.devDependencies) };
  // Without a script, the tools the project depends on.
  if (!commands.some((entry) => entry.task === "typecheck") && deps.typescript !== undefined && files.has("tsconfig.json")) commands.push(command("typecheck", ["npx", "--no-install", "tsc", "--noEmit"], "tsconfig.json"));
  if (!commands.some((entry) => entry.task === "test") && deps.vitest !== undefined) commands.push(command("test", ["npx", "--no-install", "vitest", "run"], "package.json devDependencies.vitest"));
  if (!commands.some((entry) => entry.task === "lint") && deps.eslint !== undefined) commands.push(command("lint", ["npx", "--no-install", "eslint", "."], "package.json devDependencies.eslint"));
  const entryPoints: EntryPoint[] = [];
  if (typeof pkg.bin === "string") entryPoints.push({ path: pkg.bin.replace(/^\.\//, ""), why: "package.json bin" });
  for (const [name, path] of Object.entries(strings(pkg.bin))) entryPoints.push({ path: path.replace(/^\.\//, ""), why: `package.json bin \`${name}\`` });
  if (typeof pkg.main === "string") entryPoints.push({ path: pkg.main.replace(/^\.\//, ""), why: "package.json main" });
  return {
    stack: { id: "node", manifest: "package.json", tool },
    commands,
    entryPoints,
    ...(typeof pkg.name === "string" && pkg.name ? { name: pkg.name } : {}),
    ...(typeof pkg.description === "string" && pkg.description.trim() ? { description: pkg.description.trim() } : {}),
  };
}

function pythonFacts(top: string, files: ReadonlySet<string>, all: readonly string[]): StackFacts | undefined {
  const pyproject = read(top, "pyproject.toml");
  const requirements = read(top, "requirements.txt");
  const setup = read(top, "setup.py");
  if (pyproject === undefined && requirements === undefined && setup === undefined) return undefined;
  const text = [pyproject, requirements, setup, read(top, "requirements-dev.txt"), read(top, "setup.cfg"), read(top, "tox.ini"), read(top, ".pre-commit-config.yaml")].filter(Boolean).join("\n");
  const tool = pyproject !== undefined && /^\s*\[tool\.poetry\]/m.test(pyproject) ? "poetry" : files.has("uv.lock") ? "uv" : "pip";
  // `python` is not on every PATH (many systems only have python3): both are candidates, the first that runs wins.
  const interpreters = tool === "poetry" ? [["poetry", "run", "python"]] : tool === "uv" ? [["uv", "run", "python"]] : [["python"], ["python3"]];
  const module = (name: string, ...args: string[]): string[][] => interpreters.map((prefix) => [...prefix, "-m", name, ...args]);
  const commands: DetectedCommand[] = [];
  const manifest = pyproject !== undefined ? "pyproject.toml" : requirements !== undefined ? "requirements.txt" : "setup.py";
  if (tool === "poetry") commands.push(command("install", ["poetry", "install"], "pyproject.toml [tool.poetry]"));
  else if (tool === "uv") commands.push(command("install", ["uv", "sync"], "uv.lock"));
  else if (requirements !== undefined) commands.push(command("install", ["python", "-m", "pip", "install", "-r", "requirements.txt"], "requirements.txt"));
  else commands.push(command("install", ["python", "-m", "pip", "install", "-e", "."], manifest));
  const pytest = /\bpytest\b/.test(text) || files.has("conftest.py") || all.some((path) => path.endsWith("/conftest.py") || path === "pytest.ini");
  const hasTests = all.some((path) => /(^|\/)test_[^/]+\.py$|_test\.py$/.test(path));
  if (pytest) for (const argv of module("pytest")) commands.push(command("test", argv, /\bpytest\b/.test(pyproject ?? "") ? "pyproject.toml (pytest)" : "pytest configuration"));
  else if (hasTests) for (const argv of module("unittest", "discover")) commands.push(command("test", argv, "test_*.py files (unittest)"));
  if (/\bruff\b/.test(text)) for (const argv of module("ruff", "check", ".")) commands.push(command("lint", argv, "ruff configuration"));
  else if (/\bflake8\b/.test(text)) for (const argv of module("flake8")) commands.push(command("lint", argv, "flake8 configuration"));
  if (/\bmypy\b/.test(text)) for (const argv of module("mypy", ".")) commands.push(command("typecheck", argv, "mypy configuration"));
  if (files.has("tox.ini")) commands.push(command("test", ["tox"], "tox.ini"));
  if (files.has("noxfile.py")) commands.push(command("test", ["nox"], "noxfile.py"));
  const entryPoints: EntryPoint[] = [];
  if (pyproject !== undefined) for (const [name, target] of tomlKeys(pyproject, "project.scripts")) entryPoints.push({ path: target, why: `console script \`${name}\`` });
  for (const path of all) {
    if (/^(src\/[^/]+\/|[^/]+\/)?__main__\.py$/.test(path) || /^(main|app|manage|cli)\.py$/.test(path)) entryPoints.push({ path, why: basename(path) === "__main__.py" ? "python -m entry" : "script at the root" });
  }
  const name = pyproject !== undefined ? tomlValue(pyproject, "project", "name") ?? tomlValue(pyproject, "tool.poetry", "name") : undefined;
  const description = pyproject !== undefined ? tomlValue(pyproject, "project", "description") ?? tomlValue(pyproject, "tool.poetry", "description") : undefined;
  return { stack: { id: "python", manifest, tool }, commands, entryPoints, ...(name ? { name } : {}), ...(description?.trim() ? { description: description.trim() } : {}) };
}

function rustFacts(top: string, files: ReadonlySet<string>, all: readonly string[]): StackFacts | undefined {
  const cargo = read(top, "Cargo.toml");
  if (cargo === undefined) return undefined;
  const commands = [
    command("build", ["cargo", "build"], "Cargo.toml"),
    command("test", ["cargo", "test"], "Cargo.toml"),
    command("lint", ["cargo", "clippy", "--all-targets"], "Cargo.toml"),
    command("typecheck", ["cargo", "check", "--all-targets"], "Cargo.toml"),
  ];
  if (files.has("src/main.rs") || all.some((path) => path.startsWith("src/bin/"))) commands.push(command("run", ["cargo", "run"], "src/main.rs"));
  const entryPoints: EntryPoint[] = [];
  for (const path of all) {
    if (/^(?:[^/]+\/)?src\/main\.rs$/.test(path)) entryPoints.push({ path, why: "binary crate" });
    else if (/^(?:[^/]+\/)?src\/lib\.rs$/.test(path)) entryPoints.push({ path, why: "library crate" });
    else if (/^src\/bin\/[^/]+\.rs$/.test(path)) entryPoints.push({ path, why: "extra binary" });
  }
  const name = tomlValue(cargo, "package", "name");
  const description = tomlValue(cargo, "package", "description");
  return { stack: { id: "rust", manifest: "Cargo.toml", tool: "cargo" }, commands, entryPoints, ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

function goFacts(top: string, all: readonly string[]): StackFacts | undefined {
  const mod = read(top, "go.mod");
  if (mod === undefined) return undefined;
  const module = mod.match(/^module\s+(\S+)/m)?.[1];
  const commands = [
    command("build", ["go", "build", "./..."], "go.mod"),
    command("test", ["go", "test", "./..."], "go.mod"),
    command("lint", ["go", "vet", "./..."], "go.mod"),
  ];
  const entryPoints = all.filter((path) => path === "main.go" || /^cmd\/[^/]+\/main\.go$/.test(path)).map((path) => ({ path, why: "package main" }));
  return { stack: { id: "go", manifest: "go.mod", tool: "go" }, commands, entryPoints, ...(module ? { name: module.split("/").at(-1)! } : {}) };
}

function javaFacts(top: string, files: ReadonlySet<string>, all: readonly string[]): StackFacts | undefined {
  const pom = read(top, "pom.xml");
  const gradleFile = files.has("build.gradle.kts") ? "build.gradle.kts" : files.has("build.gradle") ? "build.gradle" : undefined;
  if (pom === undefined && gradleFile === undefined) return undefined;
  const entryPoints = all.filter((path) => /^(?:[^/]+\/)?src\/main\/(java|kotlin)\/.+\/(Main|[A-Z][A-Za-z0-9]*Application)\.(java|kt)$/.test(path)).map((path) => ({ path, why: "main class" }));
  if (pom !== undefined) {
    const mvn = files.has("mvnw") ? ["./mvnw"] : ["mvn"];
    const name = xmlValue(pom, "name") ?? xmlValue(pom, "artifactId");
    const description = xmlValue(pom, "description");
    return {
      stack: { id: "java", manifest: "pom.xml", tool: "maven" },
      commands: [command("build", [...mvn, "-B", "package", "-DskipTests"], "pom.xml"), command("test", [...mvn, "-B", "test"], "pom.xml")],
      entryPoints,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  }
  const gradle = files.has("gradlew") ? ["./gradlew"] : ["gradle"];
  return {
    stack: { id: "java", manifest: gradleFile!, tool: "gradle" },
    commands: [command("build", [...gradle, "build", "-x", "test"], gradleFile!), command("test", [...gradle, "test"], gradleFile!)],
    entryPoints,
  };
}

function makeTargets(top: string): DetectedCommand[] {
  const makefile = read(top, "Makefile");
  if (makefile === undefined) return [];
  const targets = new Set([...makefile.matchAll(/^([A-Za-z][A-Za-z0-9_-]*)\s*:(?!=)/gm)].map((match) => match[1]!));
  const found: DetectedCommand[] = [];
  const map: Array<[Task, string[]]> = [["install", ["install", "deps", "setup"]], ["build", ["build"]], ["test", ["test", "check"]], ["lint", ["lint"]], ["typecheck", ["typecheck", "types"]], ["e2e", ["e2e"]], ["run", ["run", "start", "serve"]]];
  for (const [task, names] of map) {
    const name = names.find((candidate) => targets.has(candidate));
    if (name) found.push(command(task, ["make", name], `Makefile target ${name}`));
  }
  return found;
}

/** What a CI step's command line checks, when it is one plain command (no pipes, no variables, no chaining). */
const CI_PATTERNS: Array<[CheckName, RegExp]> = [
  ["e2e", /\b(playwright test|cypress run|npm run (?:test:)?e2e)\b/],
  ["typecheck", /(^|\s)(tsc\b|mypy\b|npm run (?:typecheck|type-check|check-types)|cargo check\b)/],
  ["lint", /(^|\s)(eslint\b|ruff check\b|ruff\b|flake8\b|golangci-lint\b|go vet\b|cargo clippy\b|npm run lint\b)/],
  ["test", /(^|\s)(npm test\b|npm run test\b|pnpm test\b|yarn test\b|pytest\b|python3? -m pytest\b|cargo test\b|go test\b|mvn\b.*\btest\b|gradle\b.*\btest\b|vitest\b|jest\b)/],
  ["build", /(^|\s)(npm run build\b|cargo build\b|go build\b|mvn\b.*\bpackage\b)/],
];

/** Splits a plain command line into words; undefined when it needs a shell. */
export function plainArgv(line: string): string[] | undefined {
  const text = line.trim();
  if (!text || /[|&;<>`$(){}\\*?!]|\s#/.test(text)) return undefined;
  const words: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3]!);
  return words.length > 0 && !/=/.test(words[0]!) ? words : undefined;
}

/** `run:` lines of GitHub Actions and GitLab CI jobs. */
function ciCommands(top: string, ci: readonly string[]): DetectedCommand[] {
  const found: DetectedCommand[] = [];
  for (const path of ci) {
    if (!/\.ya?ml$/.test(path)) continue;
    let document: unknown;
    try {
      document = parse(read(top, path) ?? "");
    } catch {
      continue;
    }
    const scripts: string[] = [];
    const walk = (value: unknown, key?: string): void => {
      if (typeof value === "string" && (key === "run" || key === "script")) scripts.push(value);
      else if (Array.isArray(value)) for (const item of value) walk(item, key === "script" ? "script" : undefined);
      else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) walk(item, name);
    };
    walk(document);
    for (const script of scripts) {
      for (const line of script.split("\n")) {
        const argv = plainArgv(line);
        if (!argv) continue;
        const words = argv.join(" ");
        const match = CI_PATTERNS.find(([, pattern]) => pattern.test(words));
        if (match) found.push(command(match[0], argv, path));
      }
    }
  }
  return found;
}

/** pre-commit hooks for known checkers, run through pre-commit itself. */
function preCommit(top: string): DetectedCommand[] {
  const text = read(top, ".pre-commit-config.yaml");
  if (!text) return [];
  const found: DetectedCommand[] = [];
  for (const [id, task] of [["ruff", "lint"], ["eslint", "lint"], ["flake8", "lint"], ["mypy", "typecheck"]] as const) {
    if (new RegExp(`^\\s*-?\\s*id:\\s*${id}\\b`, "m").test(text)) found.push(command(task, ["pre-commit", "run", id, "--all-files"], ".pre-commit-config.yaml"));
  }
  return found;
}

/** Root `.gitignore` entries, in order, without comments and negations; enough to say what is generated. */
function ignoredEntries(top: string): string[] {
  const text = read(top, ".gitignore");
  if (!text) return [];
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
}

function testLayout(all: readonly string[]): Detection["tests"] {
  const dirs = new Set<string>();
  const patterns = new Set<string>();
  let count = 0;
  for (const path of all) {
    const segments = path.split("/");
    const index = segments.findIndex((segment, position) => position < segments.length - 1 && TEST_DIRS.has(segment));
    const pattern = TEST_FILE_PATTERNS.find(([regex]) => regex.test(path));
    const javaTest = /(^|\/)src\/test\//.test(path);
    if ((index < 0 && !pattern && !javaTest) || !CODE.test(path)) continue;
    count += 1;
    if (pattern) patterns.add(pattern[1]);
    if (javaTest) dirs.add(path.slice(0, path.indexOf("src/test/") + "src/test/".length));
    else if (index >= 0) dirs.add(`${segments.slice(0, index + 1).join("/")}/`);
  }
  // A test folder inside another is already covered by the outer one.
  const sorted = [...dirs].sort();
  const outer = sorted.filter((dir) => !sorted.some((other) => other !== dir && dir.startsWith(other)));
  const nested = outer.filter((dir) => dir.split("/").length > 3);
  const collapsed = nested.length > 4 ? [...outer.filter((dir) => dir.split("/").length <= 3), `${nested.length} nested test folders (e.g. ${nested[0]})`] : outer;
  return { dirs: collapsed, patterns: [...patterns].sort(), count };
}

/** True for a path that looks like a test file (same rules as the layout above). */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  if (!CODE.test(path)) return false;
  return TEST_FILE_PATTERNS.some(([regex]) => regex.test(path)) || /(^|\/)src\/test\//.test(path) || segments.slice(0, -1).some((segment) => TEST_DIRS.has(segment));
}

const ORDER: readonly StackId[] = ["node", "python", "rust", "go", "java"];

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Every stack the manifests at the root show, the commands each defines, and the rest of the layout. `all` is the repository's file list. */
export function detectProject(top: string, all: readonly string[]): Detection {
  const files = new Set(all);
  const facts = [nodeFacts(top, files), pythonFacts(top, files, all), rustFacts(top, files, all), goFacts(top, all), javaFacts(top, files, all)].filter((fact): fact is StackFacts => fact !== undefined);
  facts.sort((a, b) => ORDER.indexOf(a.stack.id) - ORDER.indexOf(b.stack.id));
  const ci = all.filter((path) => CI_FILES.some((regex) => regex.test(path))).sort();
  // The stack that defines tests goes first; then make, CI and pre-commit fill the gaps and add alternatives.
  const withTests = facts.find((fact) => fact.commands.some((entry) => entry.task === "test"));
  const ordered = withTests ? [withTests, ...facts.filter((fact) => fact !== withTests)] : facts;
  const every = [...ordered.flatMap((fact) => fact.commands), ...makeTargets(top), ...ciCommands(top, ci), ...preCommit(top)];
  const commands: DetectedCommand[] = [];
  for (const entry of every) if (!commands.some((known) => known.task === entry.task)) commands.push(entry);
  commands.sort((a, b) => TASKS.indexOf(a.task) - TASKS.indexOf(b.task));
  const candidates: Detection["candidates"] = {};
  for (const name of CHECK_NAMES) {
    const list: DetectedCommand[] = [];
    for (const entry of every) if (entry.task === name && !list.some((known) => same(known.argv, entry.argv))) list.push(entry);
    if (list.length > 0) candidates[name] = list;
  }
  const named = facts.find((fact) => fact.name);
  const described = facts.find((fact) => fact.description);
  const seen = new Set<string>();
  const entryPoints = facts.flatMap((fact) => fact.entryPoints).filter((entry) => !seen.has(entry.path) && Boolean(seen.add(entry.path)));
  return {
    name: named?.name ?? basename(top),
    ...(described?.description ? { description: described.description } : {}),
    stacks: facts.map((fact) => fact.stack),
    commands,
    candidates,
    entryPoints,
    tests: testLayout(all),
    ignored: ignoredEntries(top),
    ci,
    manifests: all.filter((path) => (MANIFEST_NAMES as readonly string[]).includes(basename(path)) && !/(^|\/)(node_modules|vendor|third_party)\//.test(path)).sort(),
  };
}
