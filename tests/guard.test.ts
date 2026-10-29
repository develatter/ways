import { describe, expect, it } from "vitest";
import { guard, readShell, repoPath } from "../src/hooks/guard.js";

const TOP = "/repo";

function bash(command: string, enforcement: "observe" | "enforce" = "observe", cwd = TOP): ReturnType<typeof guard> {
  return guard({ tool: "Bash", toolInput: { command }, top: TOP, cwd, enforcement });
}

describe("the PreToolUse guard", () => {
  it("refuses file-tool writes to work records in every mode, from any agent's tool names", () => {
    for (const [tool, input] of [
      ["Write", { file_path: "/repo/.ways/work/x.json", content: "{}" }],
      ["Edit", { file_path: ".ways/work/x.json", old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: "/repo/.ways/work/x.json", edits: [] }],
      ["write", { path: ".ways/work/x.json", content: "{}" }],
      ["edit", { path: "./.ways/work/x.json" }],
    ] as const) {
      for (const enforcement of ["observe", "enforce"] as const) {
        const verdict = guard({ tool, toolInput: input, top: TOP, cwd: TOP, enforcement });
        expect(verdict.code, `${tool} ${enforcement}`).toBe("record-write");
        expect(verdict.deny).toMatch(/^ways: refused: \.ways\/work\/x\.json is a work record.*`ways done`.*`ways review`.*`ways approve`/);
      }
    }
  });

  it("allows other writes and reports the repository paths they name", () => {
    expect(guard({ tool: "Write", toolInput: { file_path: "/repo/src/a.ts" }, top: TOP, cwd: TOP, enforcement: "enforce" })).toEqual({ paths: ["src/a.ts"] });
    expect(guard({ tool: "Edit", toolInput: { file_path: "/elsewhere/.ways/work/x.json" }, top: TOP, cwd: TOP, enforcement: "enforce" })).toEqual({ paths: [] });
    expect(guard({ tool: "Write", toolInput: { file_path: "../.ways/workshop.md" }, top: TOP, cwd: "/repo/src", enforcement: "observe" })).toEqual({ paths: [".ways/workshop.md"] });
    expect(guard({ tool: "read", toolInput: { path: "src/b.ts" }, top: TOP, cwd: TOP, enforcement: "observe" })).toEqual({ paths: ["src/b.ts"] });
  });

  it("confines each role ways launches to its own scope", () => {
    const write = (role: string, path: string): ReturnType<typeof guard> => guard({ tool: "Write", toolInput: { file_path: path }, top: TOP, cwd: TOP, enforcement: "observe", role });
    expect(write("documentalist", "docs/wiki/a.md")).toEqual({ paths: ["docs/wiki/a.md"] });
    expect(write("documentalist", ".ways/knowledge/x.md")).toMatchObject({ code: "role-scope", deny: expect.stringMatching(/outside docs\/wiki\/.*the documentalist/) });
    for (const allowed of [".ways/map-notes.json", ".ways/knowledge/conventions/x.md", ".ways/agents-proposal.md", "MAP.md"]) expect(write("onboarder", allowed), allowed).toEqual({ paths: [allowed] });
    for (const refused of ["src/a.ts", "AGENTS.md", ".ways/config.json", "docs/wiki/a.md"]) expect(write("onboarder", refused), refused).toMatchObject({ code: "role-scope", deny: expect.stringMatching(/the onboarder/) });
    expect(guard({ tool: "Bash", toolInput: { command: "echo x > src/a.ts" }, top: TOP, cwd: TOP, enforcement: "observe", role: "onboarder" })).toMatchObject({ code: "role-scope" });
    expect(guard({ tool: "Bash", toolInput: { command: "export WAYS_DISABLE=1" }, top: TOP, cwd: TOP, enforcement: "observe", role: "onboarder" })).toMatchObject({ code: "hooks-bypass" });
    // An unknown role is no role: nothing is confined.
    expect(write("someone", "src/a.ts")).toEqual({ paths: ["src/a.ts"] });
  });

  it("refuses shell commands that write, move or delete a record", () => {
    for (const command of [
      "echo '{}' > .ways/work/x.json",
      "jq . a.json >> .ways/work/x.json",
      "cat a | tee .ways/work/x.json",
      "rm -f .ways/work/x.json",
      "mv /tmp/x .ways/work/x.json",
      "mv .ways/work/x.json /tmp/x",
      "cp /tmp/x .ways/work/x.json",
      "sed -i 's/a/b/' .ways/work/x.json",
      "git rm .ways/work/x.json",
      "true && printf x 1> \".ways/work/x.json\"",
      "cd src; echo x > ../.ways/work/x.json",
      "echo x >| .ways/work/x.json",
      "echo x &> .ways/work/x.json",
      "dd if=/dev/zero of=.ways/work/x.json",
    ]) {
      expect(bash(command).code, command).toBe("record-write");
    }
    expect(bash("echo x > ../.ways/work/x.json", "observe", "/repo/src").code).toBe("record-write");
    expect(bash("cd .ways/work && echo '{}' > x.json").code).toBe("record-write");
    expect(bash("cd /repo/.ways && rm work/x.json").code).toBe("record-write");
    expect(bash("cd src && echo x > out.txt")).toEqual({ paths: [] });
  });

  it("does not take reads, descriptor duplication or /dev/null for writes", () => {
    for (const command of [
      "cat .ways/work/x.json",
      "jq .criteria .ways/work/x.json 2>&1",
      "npm test >&2",
      "npm test > /dev/null 2>&1",
      "cp .ways/work/x.json /tmp/review-base.json",
      "git show HEAD:.ways/work/x.json > /tmp/x.json",
      "git restore --staged .ways/work/x.json && git restore .ways/work/x.json",
      "grep -r '.ways/work' docs > notes.txt",
      "echo 'echo > .ways/work/x.json'",
    ]) {
      expect(bash(command), command).toEqual({ paths: [] });
    }
  });

  it("refuses switching the commit hooks off only in enforce mode", () => {
    for (const command of ["WAYS_DISABLE=1 git commit -m x", "export WAYS_DISABLE=1; git commit -m x", "git -c core.hooksPath=/dev/null commit -m x", "git config core.hooksPath .nothing", "git config --unset core.hooksPath", "env WAYS_DISABLE=1 git commit -m x"]) {
      expect(bash(command, "enforce").code, command).toBe("hooks-bypass");
      expect(bash(command, "observe"), command).toEqual({ paths: [] });
    }
    expect(bash("git config core.hooksPath", "enforce")).toEqual({ paths: [] });
    expect(bash("git commit --no-verify -m x", "enforce")).toEqual({ paths: [] });
  });

  it("reads quoted and escaped words like a shell", () => {
    expect(readShell(`echo "a > b" > 'out file'`).writes).toEqual(["out file"]);
    expect(readShell("echo a\\ b > c\\ d").writes).toEqual(["c d"]);
    expect(readShell("printf x 2>/dev/null >out").writes).toEqual(["out"]);
  });

  it("confines paths to the worktree", () => {
    expect(repoPath(TOP, TOP, "/repo/a")).toBe("a");
    expect(repoPath(TOP, TOP, "/repository/a")).toBeUndefined();
    expect(repoPath(TOP, TOP, "../x")).toBeUndefined();
    expect(repoPath(TOP, TOP, "/repo")).toBeUndefined();
    expect(repoPath(TOP, TOP, "a\0b")).toBeUndefined();
  });
});
