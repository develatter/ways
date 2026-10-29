import { crypto } from "../runtime/lazy.js";

/** Content digests and the canonical JSON they are taken over; no file system, so hooks can load it cheaply. */
export function sha256(content: string | Buffer): string {
  return crypto().createHash("sha256").update(content).digest("hex");
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
