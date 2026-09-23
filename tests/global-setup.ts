import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gives each test run its own TMPDIR and removes it afterwards, so the many
 * disposable repositories tests create never accumulate in the shared /tmp.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "ways-vitest-"));
  process.env.TMPDIR = root;
  return () => rmSync(root, { recursive: true, force: true });
}
