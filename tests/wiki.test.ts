import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../src/commands.js";
import { run } from "../src/cli.js";
import { checkWiki } from "../src/wiki/check.js";
import { blobHash } from "../src/wiki/sources.js";
import { summarizeSessions } from "../src/serve/board.js";
import type { WaysEvent } from "../src/events/bus.js";
import { repository } from "./helpers.js";

const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

afterEach(() => {
  log.mockClear();
  error.mockClear();
  stdout.mockClear();
});

/** Runs `ways wiki <args>` in `cwd`; returns the exit code and everything it printed. */
async function ways(cwd: string, ...args: string[]): Promise<{ code: number; out: string }> {
  log.mockClear();
  error.mockClear();
  stdout.mockClear();
  const code = await run(["wiki", ...args], cwd);
  const out = [...log.mock.calls, ...error.mock.calls].map(([line]) => String(line)).join("\n") + stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
  return { code, out };
}

interface PageOptions {
  kind?: string;
  sources?: string[];
  hashes?: Record<string, string>;
  body?: string;
  title?: string;
}

/** Writes docs/wiki/<rel> and links it from the index, so only what a test wants broken is broken. */
async function page(cwd: string, rel: string, options: PageOptions = {}): Promise<void> {
  const sources = options.sources ?? [];
  const hashes = options.hashes ? `source_hashes:\n${Object.entries(options.hashes).map(([source, hash]) => `  ${source}: ${hash}`).join("\n")}\n` : "";
  const text = `---\ntitle: ${options.title ?? "A page"}\nkind: ${options.kind ?? "reference"}\nsources:\n${sources.map((source) => `  - ${source}`).join("\n")}\n${hashes}reviewed: 2026-10-29\n---\n\n${options.body ?? "# A page\n\nSome text.\n"}`;
  await mkdir(join(cwd, "docs/wiki", rel, ".."), { recursive: true });
  await writeFile(join(cwd, "docs/wiki", rel), text);
  const index = join(cwd, "docs/wiki/index.md");
  const current = await readFile(index, "utf8").catch(() => "---\ntitle: Wiki\n---\n\n# Wiki\n");
  if (!current.includes(`(${rel})`)) await writeFile(index, `${current}\n- [${rel}](${rel})\n`);
}

async function source(cwd: string, path: string, content: string): Promise<void> {
  await mkdir(join(cwd, path, ".."), { recursive: true });
  await writeFile(join(cwd, path), content);
}

/** A repository with `ways wiki init` done and one source file, ready for pages. */
async function wikiRepository(): Promise<string> {
  const { cwd } = await repository();
  await ways(cwd, "init");
  await source(cwd, "src/greet.ts", "export const hi = 1;\n");
  return cwd;
}

describe("ways wiki init", () => {
  it("creates the entry page and the configuration, keeps what exists, and leaves a wiki that checks", async () => {
    const { cwd } = await repository();
    const first = await ways(cwd, "init");
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/created docs\/wiki\/index\.md[\s\S]*created \.ways\/wiki\.json/);
    expect(JSON.parse(await readFile(join(cwd, ".ways/wiki.json"), "utf8"))).toEqual({ agent: "claude", scope: { modules: [], commands: [] } });
    const index = await readFile(join(cwd, "docs/wiki/index.md"), "utf8");
    expect(index).toMatch(/^---\ntitle: .* wiki\n---\n/);
    expect(index).toContain("not read by coding agents as truth");
    await writeFile(join(cwd, "docs/wiki/index.md"), `${index}\nMy edit.\n`);
    const second = await ways(cwd, "init");
    expect(second.out).toMatch(/kept\s+docs\/wiki\/index\.md[\s\S]*kept\s+\.ways\/wiki\.json/);
    expect(await readFile(join(cwd, "docs/wiki/index.md"), "utf8")).toContain("My edit.");
    const check = await ways(cwd, "check");
    expect(check.code).toBe(0);
    expect(check.out).toMatch(/Wiki is fine: 1 page/);
  });

  it("says what to do when a repository has no wiki, and passes", async () => {
    const { cwd } = await repository();
    const result = await ways(cwd, "check");
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/No wiki in this repository[\s\S]*ways wiki init/);
    expect((await ways(cwd, "update", "--dry-run").catch((e: Error) => ({ code: 1, out: e.message }))).out).toMatch(/no wiki to update[\s\S]*ways wiki init/);
  });
});

describe("freshness by source hash", () => {
  it("marks a page stale when a source changes, and a stamp makes it fresh again", async () => {
    const cwd = await wikiRepository();
    await page(cwd, "reference/greet.md", { sources: ["src/greet.ts"] });
    const unstamped = await ways(cwd, "check");
    expect(unstamped.code).toBe(1);
    expect(unstamped.out).toMatch(/stale\s+docs\/wiki\/reference\/greet\.md\s+no hash recorded for src\/greet\.ts/);

    const stamped = await ways(cwd, "update", "--stamp", "reference/greet.md");
    expect(stamped.code).toBe(0);
    const text = await readFile(join(cwd, "docs/wiki/reference/greet.md"), "utf8");
    // The hash is the Git blob id of the source, cut to 12 characters, written by ways.
    const blob = blobHash(Buffer.from("export const hi = 1;\n")).slice(0, 12);
    expect(text).toContain(`src/greet.ts: ${blob}`);
    expect(text).toMatch(/reviewed: \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("Some text.");
    expect((await ways(cwd, "check")).code).toBe(0);
    const stale = await ways(cwd, "stale");
    expect(stale.out).toMatch(/No stale pages/);

    await source(cwd, "src/greet.ts", "export const hi = 2;\n");
    const changed = await ways(cwd, "check");
    expect(changed.code).toBe(1);
    expect(changed.out).toMatch(new RegExp(`stale\\s+docs/wiki/reference/greet\\.md\\s+src/greet\\.ts changed \\(${blob} → [0-9a-f]{12}\\)`));
    const listed = await ways(cwd, "stale");
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/stale\s+docs\/wiki\/reference\/greet\.md\s+src\/greet\.ts changed/);
    const json = JSON.parse((await ways(cwd, "stale", "--json")).out) as { stale: Array<{ page: string; source: string; reason: string }> };
    expect(json.stale).toMatchObject([{ page: "docs/wiki/reference/greet.md", source: "src/greet.ts", reason: "changed" }]);

    await ways(cwd, "update", "--stamp", "docs/wiki/reference/greet.md");
    expect((await ways(cwd, "check")).code).toBe(0);
  });

  it("follows the files of a folder source by name, not by content", async () => {
    const cwd = await wikiRepository();
    await source(cwd, "src/lib/a.ts", "a\n");
    await page(cwd, "explanation/lib.md", { kind: "explanation", sources: ["src/lib/"] });
    await ways(cwd, "update", "--stamp", "explanation/lib.md");
    expect((await ways(cwd, "check")).code).toBe(0);
    await source(cwd, "src/lib/a.ts", "edited\n");
    expect((await ways(cwd, "check")).code).toBe(0);
    await source(cwd, "src/lib/b.ts", "new file\n");
    const result = await ways(cwd, "check");
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/src\/lib\/ changed/);
  });

  it("reports a source that does not exist, and will not stamp a page with one", async () => {
    const cwd = await wikiRepository();
    await page(cwd, "reference/gone.md", { sources: ["src/missing.ts"] });
    const result = await ways(cwd, "check");
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/source\s+docs\/wiki\/reference\/gone\.md\s+source src\/missing\.ts does not exist/);
    await expect(ways(cwd, "update", "--stamp", "reference/gone.md")).rejects.toThrow(/src\/missing\.ts does not exist/);
    const listed = await ways(cwd, "stale");
    expect(listed.out).toMatch(/src\/missing\.ts no longer exists/);
  });

  it("answers in JSON for CI", async () => {
    const cwd = await wikiRepository();
    await page(cwd, "reference/greet.md", { sources: ["src/greet.ts"] });
    const result = await ways(cwd, "check", "--json");
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as { ok: boolean; pages: number; issues: Array<{ code: string }>; stale: unknown[] };
    expect(report).toMatchObject({ ok: false, pages: 2 });
    expect(report.issues.map((issue) => issue.code)).toEqual(["stale"]);
    expect(report.stale).toHaveLength(1);
  });
});

describe("structure and links", () => {
  it("checks the frontmatter of every page", async () => {
    const cwd = await wikiRepository();
    await mkdir(join(cwd, "docs/wiki/how-to"), { recursive: true });
    await writeFile(join(cwd, "docs/wiki/bare.md"), "# No frontmatter\n");
    await writeFile(join(cwd, "docs/wiki/how-to/wrong.md"), "---\ntitle: x\nkind: reference\nsources: []\nreviewed: yesterday\n---\n\nbody\n");
    await writeFile(join(cwd, "docs/wiki/untitled.md"), "---\nkind: gossip\nsources:\n  - docs/wiki/bare.md\n  - ../outside\nreviewed: 2026-10-29\n---\nbody\n");
    const result = await ways(cwd, "check");
    expect(result.code).toBe(1);
    for (const expected of [
      /front\s+docs\/wiki\/bare\.md\s+missing YAML frontmatter/,
      /front\s+docs\/wiki\/how-to\/wrong\.md\s+`kind: reference` in the how-to\/ folder, which holds how-to pages/,
      /front\s+docs\/wiki\/how-to\/wrong\.md\s+`sources` must list the repository paths/,
      /front\s+docs\/wiki\/how-to\/wrong\.md\s+`reviewed` must be a date/,
      /front\s+docs\/wiki\/untitled\.md\s+`title` is required/,
      /front\s+docs\/wiki\/untitled\.md\s+`kind` must be one of tutorial, how-to, reference, explanation/,
      /front\s+docs\/wiki\/untitled\.md\s+source docs\/wiki\/bare\.md is inside the wiki/,
      /front\s+docs\/wiki\/untitled\.md\s+source "\.\.\/outside": Path must be repository-relative/,
      /orphan\s+docs\/wiki\/bare\.md/,
    ]) expect(result.out).toMatch(expected);
  });

  it("finds broken links and anchors, follows good ones, ignores code and external links", async () => {
    const cwd = await wikiRepository();
    await page(cwd, "reference/target.md", { sources: ["src/greet.ts"], body: "# Target\n\n## Exact `flags` & more\n\nText.\n" });
    await page(cwd, "how-to/links.md", {
      kind: "how-to",
      sources: ["src/greet.ts"],
      body: [
        "# Links",
        "",
        "[fine](../reference/target.md) [anchor](../reference/target.md#exact-flags--more) [self](#links) [code](../../../src/greet.ts) [folder](../)",
        "[gone](../reference/nope.md) [bad anchor](../reference/target.md#missing-heading) [out](../../../../etc/passwd)",
        "[web](https://example.com/x.md) [mail](mailto:a@b.c) `[inline](not/a/link.md)`",
        "",
        "```md",
        "[in a fence](also/not/checked.md)",
        "```",
        "",
      ].join("\n"),
    });
    const result = await ways(cwd, "check");
    const broken = result.out.split("\n").filter((line) => /^broken/.test(line));
    expect(broken).toHaveLength(3);
    expect(result.out).toMatch(/broken\s+docs\/wiki\/how-to\/links\.md:\d+\s+\.\.\/reference\/nope\.md: no such file or folder/);
    expect(result.out).toMatch(/broken\s+docs\/wiki\/how-to\/links\.md:\d+\s+\.\.\/reference\/target\.md#missing-heading: no heading "#missing-heading" in docs\/wiki\/reference\/target\.md/);
    expect(result.out).toMatch(/broken\s+docs\/wiki\/how-to\/links\.md:\d+\s+\.\.\/\.\.\/\.\.\/\.\.\/etc\/passwd: points outside the repository/);
  });

  it("wants every page reachable from the index", async () => {
    const cwd = await wikiRepository();
    await page(cwd, "reference/greet.md", { sources: ["src/greet.ts"] });
    await writeFile(join(cwd, "docs/wiki/index.md"), "---\ntitle: Wiki\n---\n\n# Wiki\n");
    expect((await ways(cwd, "check")).out).toMatch(/orphan\s+docs\/wiki\/reference\/greet\.md\s+no page links here from index\.md/);
  });
});

describe("command examples", () => {
  it("checks `ways-check` blocks against the command registry, and leaves other blocks alone", async () => {
    const cwd = await wikiRepository();
    await page(cwd, "how-to/examples.md", {
      kind: "how-to",
      sources: ["src/greet.ts"],
      body: [
        "# Examples",
        "",
        "```sh ways-check",
        "# comments and blanks are skipped",
        "ways check --integrity-only",
        "ways outcome open greeting --goal=\"Greet users\" \\",
        "  --criterion=\"AC1:says hi\" --verify=\"AC1:grep -q hi greeting.txt\"",
        "npx --no-install ways wiki update --dry-run --agent=pi",
        "$ ways status --json | head -n 3",
        "ways frobnicate --now",
        "ways done --everything",
        "ways wiki nonsense",
        "ways status --help",
        "```",
        "",
        "```sh",
        "ways not-checked --nope",
        "```",
        "",
      ].join("\n"),
    });
    const result = await ways(cwd, "check");
    const examples = result.out.split("\n").filter((line) => /^example/.test(line));
    expect(examples).toHaveLength(3);
    expect(result.out).toMatch(/`ways frobnicate --now`: `ways frobnicate` is not a command/);
    expect(result.out).toMatch(/`ways done --everything`: `--everything` is not an option of `ways done`; `ways done --help`/);
    expect(result.out).toMatch(/`ways wiki nonsense`: `ways wiki nonsense` is not an action of `ways wiki` \(init, update, check, stale\)/);
  });
});

describe("coverage", () => {
  it("asks for a page that cites every module and mentions every command in scope", async () => {
    const cwd = await wikiRepository();
    await source(cwd, "src/alpha/a.ts", "a\n");
    await source(cwd, "src/beta/b.ts", "b\n");
    await source(cwd, "src/gamma/c.ts", "c\n");
    await writeFile(join(cwd, ".ways/wiki.json"), JSON.stringify({ scope: { modules: ["src/*/"], commands: ["deploy", "rollback"] } }));
    await page(cwd, "reference/alpha.md", { sources: ["src/alpha/"], body: "# Alpha\n\nRun `deploy` to ship.\n" });
    await page(cwd, "reference/beta.md", { sources: ["src/beta/b.ts"] });
    const result = await ways(cwd, "check");
    expect(result.code).toBe(1);
    expect(result.out.split("\n").filter((line) => /^gap/.test(line)).sort()).toEqual([
      "gap      docs/wiki  `rollback` is not mentioned in any page",
      "gap      docs/wiki  src/gamma/ is not cited in the `sources` of any page",
    ]);
    // A file inside the module, or the folder, counts; so does a mention.
    await page(cwd, "reference/gamma.md", { sources: ["src/gamma/c.ts"], body: "# Gamma\n\nAfter a failure, `rollback`.\n" });
    await ways(cwd, "update", "--stamp", "reference/alpha.md", "reference/beta.md", "reference/gamma.md");
    expect((await ways(cwd, "check")).out).not.toMatch(/gap/);
  });

  it("can require a page for every ways command", async () => {
    const cwd = await wikiRepository();
    await writeFile(join(cwd, ".ways/wiki.json"), JSON.stringify({ scope: { commands: "ways" } }));
    await page(cwd, "reference/commands.md", { sources: ["src/greet.ts"], body: "# Commands\n\n`ways check` runs the checks.\n" });
    const result = await ways(cwd, "check");
    const gaps = result.out.split("\n").filter((line) => /^gap/.test(line));
    // `ways check` is mentioned by the page, and `ways wiki` by the index `ways wiki init` wrote.
    expect(gaps).toHaveLength(COMMANDS.length - 2);
    expect(result.out).toContain("`ways evals` is not mentioned in any page");
    expect(result.out).not.toContain("`ways check` is not mentioned");
    expect(result.out).not.toContain("`ways wiki` is not mentioned");
  });

  it("reports an unusable .ways/wiki.json instead of ignoring it", async () => {
    const cwd = await wikiRepository();
    await writeFile(join(cwd, ".ways/wiki.json"), JSON.stringify({ agent: "gpt", scope: { modules: "src" } }));
    const result = await ways(cwd, "check");
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/config\s+\.ways\/wiki\.json\s+\.ways\/wiki\.json: "agent" must be "claude", "pi" or "command"/);
    expect(result.out).toMatch(/"scope\.modules" must be an array/);
  });
});

describe("the wiki of ways itself", () => {
  it("has working links, frontmatter, examples and coverage (freshness is CI's `ways wiki check`)", async () => {
    const report = await checkWiki(process.cwd());
    expect(report.exists).toBe(true);
    expect(report.pages).toBeGreaterThanOrEqual(10);
    expect(report.issues.filter((issue) => issue.code !== "stale").map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)).toEqual([]);
  });

  it("is checked in CI, and bootstrap gives consumers the same step without failing when there is no wiki", async () => {
    expect(await readFile(join(process.cwd(), ".github/workflows/ci.yml"), "utf8")).toContain("node dist/cli.js wiki check");
    expect(await readFile(join(process.cwd(), "assets/bootstrap/ways.yml"), "utf8")).toContain("npx --no-install ways wiki check");
  });
});

describe("the board", () => {
  it("remembers the job ways launched a session for", () => {
    const event = (type: WaysEvent["type"], ts: string, role?: string): WaysEvent => ({ v: 1, ts, session: "wiki-1", agent: "claude", type, hook: "wiki", worktree: "/r", branch: "main", work: null, result: "ok", ms: 1, ...(role ? { role } : {}) });
    const [session] = summarizeSessions([event("session.started", "2026-10-29T10:00:00Z", "documentalist"), event("agent.stopped", "2026-10-29T10:05:00Z")]);
    expect(session).toMatchObject({ session: "wiki-1", role: "documentalist" });
  });
});
