import { createRequire } from "node:module";

/**
 * Agent hooks start a Node process per event, and loading `node:crypto` or
 * `node:child_process` costs more than the rest of a hook. Modules on that
 * path load them here, on first use, and use `fastHash` for cache keys.
 */
const require = createRequire(import.meta.url);

type GetBuiltin = (name: string) => unknown;

export function builtin<T>(name: "node:child_process" | "node:crypto"): T {
  const get = (process as unknown as { getBuiltinModule?: GetBuiltin }).getBuiltinModule;
  return (get ? get(name) : require(name)) as T;
}

export function childProcess(): typeof import("node:child_process") {
  return builtin<typeof import("node:child_process")>("node:child_process");
}

export function crypto(): typeof import("node:crypto") {
  return builtin<typeof import("node:crypto")>("node:crypto");
}

/** FNV-1a over UTF-16 code units, 64 bits as two 32-bit lanes. */
function fnv64(text: string, seed: number): string {
  let high = 0xcbf29ce4 ^ seed;
  let low = 0x84222325;
  for (let index = 0; index < text.length; index += 1) {
    low ^= text.charCodeAt(index);
    // Multiply the 64-bit value by the FNV prime 0x100000001b3.
    const lowProduct = Math.imul(low, 0x1b3);
    const carry = Math.floor(((low >>> 0) * 0x1b3) / 0x100000000);
    high = (Math.imul(high, 0x1b3) + (low << 8) + carry) >>> 0;
    low = lowProduct >>> 0;
  }
  return (high >>> 0).toString(16).padStart(8, "0") + (low >>> 0).toString(16).padStart(8, "0");
}

/** A 128-bit, non-cryptographic digest in hex: for cache keys and file names, never for integrity. */
export function fastHash(text: string): string {
  return fnv64(text, 0) + fnv64(text, 0x5bd1e995);
}
