import { readFileSync } from "node:fs";

export const HARNESS_NAME = "ways";

/** The package version: `package.json` is the single source, so `ways --version` cannot drift from what is published. */
export const HARNESS_VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** Compares `major.minor.patch` numerically; any prerelease suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
