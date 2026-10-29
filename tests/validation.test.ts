import { describe, expect, it } from "vitest";
import { validateConfig, validateWorkRecord, validationDetails } from "../src/domain/validation.js";

const record = {
  schemaVersion: 2,
  id: "auth-refresh",
  kind: "outcome",
  goal: "Refresh tokens before expiry",
  criteria: [{ id: "AC1", text: "refreshes 60 s early", verify: ["npm", "test"], strength: "test" }],
  policy: { review: "required", approval: "none" },
  openedAt: "2026-01-01T00:00:00Z",
};

describe("contracts", () => {
  it("accepts the lean config and refuses the 0.2 one", () => {
    expect(validateConfig({ schemaVersion: 2, harnessVersion: "0.3.0", enforcement: "observe", testCommand: ["npm", "test"] })).toBe(true);
    expect(validateConfig({ schemaVersion: 2, harnessVersion: "0.3.0", enforcement: "strict", testCommand: ["npm", "test"] })).toBe(false);
    expect(validateConfig({ schemaVersion: 1, harnessVersion: "0.2.2", testCommand: ["npm", "test"] })).toBe(false);
    expect(validateConfig({ schemaVersion: 2, harnessVersion: "0.3.0", testCommand: ["npm", "test"], memory: {} })).toBe(false);
  });

  it("accepts a work record and rejects unknown fields and bad strengths", () => {
    expect(validateWorkRecord(record)).toBe(true);
    expect(validateWorkRecord({ ...record, surprise: true })).toBe(false);
    expect(validateWorkRecord({ ...record, criteria: [{ ...record.criteria[0], strength: "vibes" }] })).toBe(false);
    expect(validateWorkRecord({ ...record, criteria: [{ id: "ac1", text: "x", strength: "review-only" }] })).toBe(false);
  });

  it("reports useful schema errors", () => {
    const result = validationDetails("work", { ...record, kind: "sdd" });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("allowed values");
  });

  it("validates timestamps for real calendar dates", () => {
    for (const openedAt of ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.123Z", "2024-02-29T23:59:59+05:30"]) expect(validateWorkRecord({ ...record, openedAt })).toBe(true);
    for (const openedAt of ["2024-02-29t23:59:59Z", "2024-02-29T23:59:60Z", "2023-02-29T23:59:59Z", "2026-04-31T23:59:59Z"]) expect(validateWorkRecord({ ...record, openedAt })).toBe(false);
  });

  it("accepts a submitted review with optional dispositions only", () => {
    const review = { reviewer: "ways-reviewer", commit: "a".repeat(40), verdict: "pass", findings: [{ id: "F1", severity: "low", summary: "nit" }] };
    expect(validationDetails("review", review).valid).toBe(true);
    expect(validationDetails("review", { ...review, digest: "0".repeat(64) }).valid).toBe(false);
    expect(validationDetails("review", { ...review, findings: [{ id: "F1", severity: "blocker", summary: "x" }] }).valid).toBe(false);
  });
});
