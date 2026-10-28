import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../src/domain/types.js";
import { reviewBlocks, reviewNotes } from "../src/work/review.js";

const base: ReviewResult = {
  schemaVersion: 1,
  workId: "x",
  reviewer: "independent-agent",
  digest: "0000000000000000000000000000000000000000000000000000000000000000",
  verdict: "pass",
  findings: [],
};

describe("review gate", () => {
  it("blocks unresolved severe findings", () => {
    expect(reviewBlocks({
      schemaVersion: 1,
      workId: "x",
      reviewer: "independent-agent",
      digest: "0000000000000000000000000000000000000000000000000000000000000000",
      verdict: "pass",
      findings: [{ id: "F1", severity: "high", summary: "Broken", disposition: "accepted" }],
    })).toContain("F1");
  });

  it("never blocks on medium or low findings, whatever their disposition", () => {
    for (const severity of ["medium", "low"] as const) {
      for (const disposition of ["open", "fixed", "accepted", "deferred"] as const) {
        expect(reviewBlocks({ ...base, findings: [{ id: "F2", severity, summary: "Naming", disposition }] })).toEqual([]);
      }
    }
  });

  it("blocks critical and high findings until they are fixed", () => {
    for (const severity of ["critical", "high"] as const) {
      expect(reviewBlocks({ ...base, findings: [{ id: "F3", severity, summary: "Broken", disposition: "open" }] })).toEqual(["F3"]);
      expect(reviewBlocks({ ...base, findings: [{ id: "F3", severity, summary: "Broken", disposition: "deferred" }] })).toEqual(["F3"]);
      expect(reviewBlocks({ ...base, findings: [{ id: "F3", severity, summary: "Broken", disposition: "fixed" }] })).toEqual([]);
    }
  });

  it("still blocks on a verdict other than pass, and lists non-blocking findings as notes", () => {
    expect(reviewBlocks({ ...base, verdict: "fail" })).toEqual(["verdict"]);
    const findings = [
      { id: "F1", severity: "high", summary: "Broken", disposition: "fixed" },
      { id: "F2", severity: "medium", summary: "Naming", disposition: "open" },
      { id: "F4", severity: "low", summary: "Typo", disposition: "deferred" },
    ] as const;
    expect(reviewNotes({ ...base, findings: [...findings] })).toEqual(["F2 (medium, open): Naming", "F4 (low, deferred): Typo"]);
  });
});
