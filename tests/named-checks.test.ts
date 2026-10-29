import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { bootstrap } from "../src/bootstrap/bootstrap.js";
import { runChecks, treeKillArgs } from "../src/check/check.js";
import { validateConfig } from "../src/domain/validation.js";
import { GitRepository } from "../src/git/git.js";

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ways-named-checks-"));
  const git = new GitRepository(cwd);
  await git.run(["init", "-q"]);
  await git.run(["config", "user.name", "Ways Test"]);
  await git.run(["config", "user.email", "ways@example.test"]);
  await writeFile(join(cwd, ".gitkeep"), "");
  await git.run(["add", ".gitkeep"]);
  await git.run(["commit", "-q", "-m", "initial"]);
  return cwd;
}

const pass = [process.execPath, "-e", "process.exit(0)"];

describe("named environment checks", () => {
  it("validates the additive contract and records deterministic named results", async () => {
    const cwd = await repository();
    await bootstrap({
      cwd,
      testCommand: pass,
      agents: [],
      commands: {
        required: ["lint", "test"],
        test: pass,
        lint: [process.execPath, "-e", "process.exit(3)"],
      },
    });
    const result = await runChecks(cwd);
    expect(result.checks?.map(({ name, status }) => [name, status])).toEqual([
      ["test", "passed"],
      ["lint", "failed"],
      ["typecheck", "skipped"],
      ["build", "skipped"],
      ["e2e", "skipped"],
    ]);
    expect(result.passed).toBe(false);
  });

  it("records duration, output digest and tail instead of streaming when capturing", async () => {
    const cwd = await repository();
    await bootstrap({ cwd, testCommand: [process.execPath, "-e", "for (let i = 1; i <= 30; i++) console.log('line ' + i); process.exit(2)"], agents: [] });
    const [check] = (await runChecks(cwd, { capture: true })).checks;
    expect(check).toMatchObject({ name: "test", status: "failed", exitCode: 2, outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/), durationMs: expect.any(Number) });
    expect(check?.tail?.split("\n")).toEqual(Array.from({ length: 20 }, (_, index) => `line ${index + 11}`));
  });

  it("distinguishes unavailable required commands and bounded timeouts", async () => {
    const cwd = await repository();
    await bootstrap({
      cwd,
      testCommand: pass,
      agents: [],
      commands: {
        required: ["test", "lint"],
        // Exercise the real child-process timeout and process-tree cleanup boundary.
        test: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
        lint: ["ways-command-that-does-not-exist"],
        timeoutMs: 30,
      },
    });
    const result = await runChecks(cwd);
    expect(result.checks?.find((check) => check.name === "test")?.status).toBe("timed-out");
    expect(result.checks?.find((check) => check.name === "lint")?.status).toBe("unavailable");
  });

  it("skips the commands when integrity fails", async () => {
    const cwd = await repository();
    await bootstrap({ cwd, testCommand: pass, agents: [], commands: { required: ["test"], test: pass } });
    await writeFile(join(cwd, "scripts/check.sh"), "#!/bin/sh\n");
    const result = await runChecks(cwd);
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "test")).toMatchObject({ status: "skipped", detail: "Skipped because integrity checks failed" });
  });

  it("terminates the harness on interruption without running later checks", async () => {
    const cwd = await repository();
    const marker = join(cwd, "later-check-ran");
    await bootstrap({
      cwd,
      testCommand: pass,
      agents: [],
      commands: {
        required: ["test", "lint"],
        test: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
        lint: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      },
    });
    const script = `import { runChecks } from ${JSON.stringify(new URL("../dist/check/check.js", import.meta.url).href)}; await runChecks(${JSON.stringify(cwd)});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGTERM");
    const [code, signal] = await exit;
    if (code !== null) throw new Error(stderr || `child exited ${code}`);
    expect(code).toBeNull();
    expect(signal).toBe("SIGTERM");
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses Windows taskkill tree arguments without requiring a Windows host", () => {
    expect(treeKillArgs(42, "SIGTERM", "win32")).toEqual(["/PID", "42", "/T"]);
    expect(treeKillArgs(42, "SIGKILL", "win32")).toEqual(["/PID", "42", "/T", "/F"]);
    expect(treeKillArgs(42, "SIGTERM", "darwin")).toBeUndefined();
  });

  it("bootstraps legacy whitespace arguments unchanged", async () => {
    const cwd = await repository();
    await expect(bootstrap({ cwd, testCommand: [process.execPath, "-e", " "], agents: [] })).resolves.toBeDefined();
  });

  it("rejects every present invalid commands option", async () => {
    for (const option of ["--commands=", "--commands=null", "--commands=false", "--commands=0"]) {
      const cwd = await repository();
      await expect(run(["bootstrap", "--no-adapters", option], cwd)).rejects.toThrow();
    }
  });

  it("rejects empty or unknown commands while accepting legacy configuration", () => {
    expect(validateConfig({ schemaVersion: 2, harnessVersion: "test", testCommand: ["true"] })).toBe(true);
    expect(validateConfig({
      schemaVersion: 2,
      harnessVersion: "test",
      testCommand: ["true"],
      commands: { required: ["test"], test: [] },
    })).toBe(false);
    expect(validateConfig({
      schemaVersion: 2,
      harnessVersion: "test",
      testCommand: ["true"],
      commands: { required: ["unknown"], test: ["true"] },
    })).toBe(false);
    expect(validateConfig({ schemaVersion: 2, harnessVersion: "test", testCommand: [" "] })).toBe(true);
    expect(validateConfig({ schemaVersion: 2, harnessVersion: "test", testCommand: ["bad\0"] })).toBe(true);
    expect(validateConfig({
      schemaVersion: 2,
      harnessVersion: "test",
      testCommand: ["true"],
      commands: { required: ["test"], test: ["bad\0"] },
    })).toBe(false);
  });
});
