import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Addresses } from "./keystore.js";
import type { SignerMethod, SignerResponse } from "./protocol.js";
import type { HlApproveAgentResult, HlSignRequest, Signature, SignerApi, SolSignRequest, SolSignResult } from "./signer.js";
import type { EvmTxRequest } from "./evm.js";

export interface SignerProcessOptions {
  keystorePath: string;
  passphraseFile?: string;
  solanaRpcUrl?: string;
  arbitrumRpcUrl?: string;
  /** RPC per EVM chain id. */
  evmRpcUrls?: Record<number, string>;
  /** Run the signer as another OS user, e.g. ["sudo", "-u", "fren-signer"]. */
  commandPrefix?: string[];
}

export class SignerError extends Error {
  constructor(
    message: string,
    readonly rule: boolean,
  ) {
    super(message);
    this.name = "SignerError";
  }
}

/** Talks to the signer child process. Implements the same interface as the in-process signer. */
export class SignerProcess implements SignerApi {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly ready: Promise<void>;

  constructor(opts: SignerProcessOptions) {
    const server = fileURLToPath(new URL("./server.js", import.meta.url));
    const [cmd, ...prefixArgs] = [...(opts.commandPrefix ?? []), process.execPath, server];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      FREN_KEYSTORE: opts.keystorePath,
      ...(opts.passphraseFile ? { FREN_PASSPHRASE_FILE: opts.passphraseFile } : {}),
      ...(process.env.FREN_PASSPHRASE ? { FREN_PASSPHRASE: process.env.FREN_PASSPHRASE } : {}),
      ...(opts.solanaRpcUrl ? { FREN_SOLANA_RPC: opts.solanaRpcUrl } : {}),
      ...(opts.arbitrumRpcUrl ? { FREN_ARBITRUM_RPC: opts.arbitrumRpcUrl } : {}),
      ...(opts.evmRpcUrls ? { FREN_EVM_RPCS: JSON.stringify(opts.evmRpcUrls) } : {}),
    };
    this.child = spawn(cmd!, prefixArgs, { env, stdio: ["pipe", "pipe", "pipe"] });

    let markReady!: () => void;
    let failReady!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      markReady = res;
      failReady = rej;
    });
    let stderr = "";
    this.child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    this.child.on("exit", (code) => {
      const err = new SignerError(`Signer exited (${String(code)}): ${stderr.trim()}`, false);
      failReady(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as SignerResponse;
      if (msg.id === 0) {
        markReady();
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ("error" in msg) p.reject(new SignerError(msg.error.message, msg.error.rule));
      else p.resolve(msg.result);
    });
  }

  private async call<T>(method: SignerMethod, params?: unknown): Promise<T> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  addresses() {
    return this.call<Addresses>("addresses");
  }
  hlSignL1(req: HlSignRequest) {
    return this.call<Signature>("hlSignL1", req);
  }
  hlApproveAgent(req: { isTestnet: boolean }) {
    return this.call<HlApproveAgentResult>("hlApproveAgent", req);
  }
  solSignTransaction(req: SolSignRequest) {
    return this.call<SolSignResult>("solSignTransaction", req);
  }
  hlDepositFromArbitrum(req: { amountUsd: number; isTestnet: boolean }) {
    return this.call<{ txHash: `0x${string}` }>("hlDepositFromArbitrum", req);
  }

  evmSendTransaction(req: EvmTxRequest) {
    return this.call<{ txHash: `0x${string}` }>("evmSendTransaction", req);
  }

  close() {
    this.child.stdin.end();
  }
}
