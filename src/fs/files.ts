import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export { sha256, stableJson } from "./digest.js";

export async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
  await rename(temporary, path);
}
