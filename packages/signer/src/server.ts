#!/usr/bin/env node
/**
 * The signer process. Started by the engine as a child process; holds the
 * decrypted keys in memory and answers a fixed set of requests on stdin/stdout.
 *
 * It has no listening socket and no outbound network except the optional
 * Solana RPC used for simulation. Run it as its own OS user (see docs/SECURITY.md)
 * so the agent process cannot read the keystore file.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { readKeystore } from "./keystore.js";
import { SIGNER_METHODS, type SignerRequest, type SignerResponse } from "./protocol.js";
import { SignerRuleError } from "./rules.js";
import { createSigner, type SignerApi } from "./signer.js";

function passphrase(): string {
  const file = process.env.JARVIS_PASSPHRASE_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  const env = process.env.JARVIS_PASSPHRASE;
  if (env) return env;
  throw new Error("Set JARVIS_PASSPHRASE_FILE (preferred) or JARVIS_PASSPHRASE.");
}

function main() {
  const keystorePath = process.env.JARVIS_KEYSTORE;
  if (!keystorePath) throw new Error("Set JARVIS_KEYSTORE to the keystore path.");
  const keys = readKeystore(keystorePath, passphrase());
  delete process.env.JARVIS_PASSPHRASE;
  const signer: SignerApi = createSigner(keys, {
    ...(process.env.JARVIS_SOLANA_RPC ? { solanaRpcUrl: process.env.JARVIS_SOLANA_RPC } : {}),
    ...(process.env.JARVIS_ARBITRUM_RPC ? { arbitrumRpcUrl: process.env.JARVIS_ARBITRUM_RPC } : {}),
  });

  const write = (res: SignerResponse) => process.stdout.write(`${JSON.stringify(res)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let req: SignerRequest;
    try {
      req = JSON.parse(line) as SignerRequest;
    } catch {
      return;
    }
    if (!SIGNER_METHODS.includes(req.method)) {
      write({ id: req.id, error: { message: `Unknown method ${String(req.method)}`, rule: true } });
      return;
    }
    const fn = signer[req.method] as (p: unknown) => Promise<unknown>;
    fn(req.params).then(
      (result) => write({ id: req.id, result }),
      (err: unknown) =>
        write({
          id: req.id,
          error: { message: err instanceof Error ? err.message : String(err), rule: err instanceof SignerRuleError },
        }),
    );
  });
  rl.on("close", () => process.exit(0));
  process.stdout.write(`${JSON.stringify({ id: 0, result: "ready" })}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`jarvis-signer: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
