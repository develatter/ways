import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAYS_DIR } from "../domain/constants.js";
import type { GitRepository } from "../git/git.js";

/**
 * SSH-signed approvals, with OpenSSH only (`ssh-keygen -Y sign|verify`, no
 * network, no dependency). The payload names the work, the evaluated commit
 * and the digest of what the human saw; the signature verifies against
 * `.ways/allowed_signers` as committed in the work's base, so the change being
 * approved cannot add its own key.
 *
 * A key the agent can use (any key loaded in the same user's ssh-agent) can
 * sign as well as the human; only a FIDO key (`ed25519-sk`), which needs a
 * physical touch per signature, tells them apart. See docs/VERIFICATION.md.
 */
export const NAMESPACE = "ways-approval";
export const ALLOWED_SIGNERS_PATH = `${WAYS_DIR}/allowed_signers`;

export function approvalPayload(id: string, input: string, digest: string): string {
  return `ways-approval v1\nwork: ${id}\ninput: ${input}\ndigest: ${digest}\n`;
}

function sshKeygen(args: string[], input: string, interactive = false): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("ssh-keygen", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", interactive ? "inherit" : "pipe"] });
  if (result.error) throw new Error(`Cannot run ssh-keygen (OpenSSH 8.2 or later is needed for signed approvals): ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function scratch<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ways-sig-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The signing key: `--key`, else Git's `user.signingkey` when `gpg.format` is ssh. Undefined when there is none. */
export async function signingKey(git: GitRepository, explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  try {
    if ((await git.run(["config", "gpg.format"])).trim() !== "ssh") return undefined;
    return (await git.run(["config", "user.signingkey"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Signs the payload; a FIDO key asks for its touch on the terminal. */
export function signPayload(payload: string, key: string): string {
  return scratch((dir) => {
    let file = key;
    if (key.startsWith("key::") || key.startsWith("ssh-")) {
      // A literal public key (as Git allows): ssh-keygen finds its private half in the agent.
      file = join(dir, "key.pub");
      writeFileSync(file, `${key.replace(/^key::/, "")}\n`);
    }
    const result = sshKeygen(["-Y", "sign", "-q", "-n", NAMESPACE, "-f", file], payload, true);
    if (result.status !== 0 || !result.stdout.includes("BEGIN SSH SIGNATURE")) {
      throw new Error(`ssh-keygen could not sign with ${key}: ${result.stderr.trim() || `exit ${result.status}`}`);
    }
    return result.stdout.trim();
  });
}

export async function allowedSigners(git: GitRepository, base: string): Promise<string | undefined> {
  try {
    const text = await git.run(["show", `${base}:${ALLOWED_SIGNERS_PATH}`]);
    return text.trim() ? `${text}\n` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The principal whose key in the base's `.ways/allowed_signers` made this
 * signature over the payload, or an error that says why not.
 */
export async function verifyPayload(git: GitRepository, base: string, payload: string, signature: string): Promise<string> {
  const signers = await allowedSigners(git, base);
  if (!signers) throw new Error(`${ALLOWED_SIGNERS_PATH} is not committed in the base ${base.slice(0, 12)}; add the human's key there in its own commit (\`<email> namespaces="${NAMESPACE}" <public key>\`), then approve`);
  return scratch((dir) => {
    const allowed = join(dir, "allowed_signers");
    const sig = join(dir, "approval.sig");
    writeFileSync(allowed, signers);
    writeFileSync(sig, `${signature.trim()}\n`);
    const found = sshKeygen(["-Y", "find-principals", "-s", sig, "-f", allowed], "");
    const principal = found.stdout.split("\n").map((line) => line.trim()).find(Boolean);
    if (found.status !== 0 || !principal) throw new Error(`The signature is not by any key in ${ALLOWED_SIGNERS_PATH} of the base ${base.slice(0, 12)}`);
    const verified = sshKeygen(["-Y", "verify", "-f", allowed, "-I", principal, "-n", NAMESPACE, "-s", sig], payload);
    if (verified.status !== 0) throw new Error(`The signature by ${principal} does not verify for this approval (other work, commit or evidence): ${verified.stderr.trim() || verified.stdout.trim()}`);
    return principal;
  });
}
