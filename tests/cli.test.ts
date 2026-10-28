import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { HARNESS_VERSION } from "../src/index.js";
import { GitRepository } from "../src/git/git.js";

const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

afterEach(() => {
  log.mockClear();
  error.mockClear();
});

describe("CLI", () => {
  it("prints its version", async () => {
    expect(await run(["--version"])).toBe(0);
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(log).toHaveBeenCalledWith(pkg.version);
    expect(HARNESS_VERSION).toBe(pkg.version);
  });

  it("prints the same version from the built binary", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(execFileSync(process.execPath, [process.env.WAYS_CLI!, "--version"], { encoding: "utf8" }).trim()).toBe(pkg.version);
  });

  it("serves the reviewed bootstrap discovery lifecycle with explicit branch configuration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ways-cli-memory-"));
    const git = new GitRepository(cwd);
    await git.run(["init", "-q"]);
    await git.run(["config", "user.name", "Ways Test"]);
    await git.run(["config", "user.email", "ways@example.test"]);
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, ".gitkeep"), "");
    await git.run(["add", ".gitkeep"]);
    await git.run(["commit", "-q", "-m", "initial"]);

    expect(await run([
      "bootstrap", "--no-adapters", "--test-command=[\"true\"]",
      "--release-branch=master", "--integration-branch=next", "--relevant-path=src/**",
    ], cwd)).toBe(0);
    const config = JSON.parse(await readFile(join(cwd, ".ways/config.json"), "utf8"));
    expect(config.memory).toMatchObject({ releaseBranch: "master", integrationBranch: "next", relevantPaths: ["src/**"] });
    expect(log.mock.calls.at(-1)?.[0]).toContain("discovery review");

    expect(await run(["memory", "discovery", "request"], cwd)).toBe(0);
    expect(await run(["memory", "discovery", "digest"], cwd)).toBe(0);
    const digest = String(log.mock.calls.at(-1)?.[0]);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(cwd, "discovery-review.json"), JSON.stringify({
      schemaVersion: 1, workId: "memory-discovery", reviewer: "independent/reviewer",
      digest, verdict: "pass", findings: [],
    }));
    expect(await run(["memory", "discovery", "complete", "discovery-review.json"], cwd)).toBe(0);
    await expect(readFile(join(cwd, ".ways/memory/discovery.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(run(["memory", "discovery", "request"], cwd)).rejects.toThrow("explicitly requested");
    expect(await run(["memory", "discovery", "request", "--rediscover"], cwd)).toBe(0);
  });

  it("rejects unknown commands", async () => {
    expect(await run(["unknown"])).toBe(1);
    expect(error).toHaveBeenCalledWith("Unknown command: unknown");
  });
});
