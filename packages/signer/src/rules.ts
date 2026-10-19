import { PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";

/**
 * Hard rules the signer applies to everything it is asked to sign. These run
 * inside the signer process, after the engine's policy engine, so a bug or a
 * compromise in the engine still cannot make the signer move funds out.
 */

// ---------------------------------------------------------------------------
// Hyperliquid

/** L1 actions the agent key may sign. Withdrawals and transfers are user-signed actions and are never exposed. */
export const HL_ALLOWED_L1_ACTIONS = new Set([
  "order",
  "cancel",
  "cancelByCloid",
  "modify",
  "batchModify",
  "updateLeverage",
  "updateIsolatedMargin",
  "scheduleCancel",
]);

export function checkHyperliquidAction(action: unknown): void {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    throw new SignerRuleError("Hyperliquid action must be an object.");
  }
  const type = (action as { type?: unknown }).type;
  if (typeof type !== "string" || !HL_ALLOWED_L1_ACTIONS.has(type)) {
    throw new SignerRuleError(`Hyperliquid action "${String(type)}" is not allowed for the trading key.`);
  }
}

// ---------------------------------------------------------------------------
// Solana

export const SOLANA_PROGRAMS = {
  system: SystemProgram.programId.toBase58(),
  computeBudget: "ComputeBudget111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
} as const;

const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export interface SolanaTxRules {
  /** Programs allowed as top-level instructions, beyond the always-allowed plumbing. */
  extraPrograms?: string[];
  /** Cap on the priority fee the transaction may pay, in lamports. */
  maxPriorityFeeLamports?: number;
}

export interface SolanaTxReport {
  programs: string[];
  priorityFeeLamports: number;
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), mint.toBuffer()],
    new PublicKey(SOLANA_PROGRAMS.associatedToken),
  )[0];
}

/**
 * Inspect a Jupiter-style swap transaction before signing.
 *
 * - The wallet must be the fee payer.
 * - Only allow-listed programs may be invoked at the top level.
 * - Top-level SOL transfers may only go to the wallet's own wrapped-SOL account.
 * - Top-level token instructions are limited to SyncNative and closing an
 *   account back to the wallet; approvals, authority changes and transfers are refused.
 * - The priority fee is capped.
 *
 * Inner instructions run inside allow-listed programs (the Jupiter router and
 * the AMMs it calls); simulation in the signer covers what this static check cannot.
 */
export function checkSolanaTransaction(tx: VersionedTransaction, owner: PublicKey, rules: SolanaTxRules = {}): SolanaTxReport {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  const ownerB58 = owner.toBase58();
  if (keys[0]?.toBase58() !== ownerB58) throw new SignerRuleError("The wallet must pay the fee for its own transactions.");

  const allowed = new Set<string>([...Object.values(SOLANA_PROGRAMS), ...(rules.extraPrograms ?? [])]);
  const wsolAccounts = new Set([
    associatedTokenAddress(owner, NATIVE_MINT, SOLANA_PROGRAMS.token).toBase58(),
    associatedTokenAddress(owner, NATIVE_MINT, SOLANA_PROGRAMS.token2022).toBase58(),
  ]);

  const keyAt = (i: number): string => {
    const k = keys[i];
    if (!k) throw new SignerRuleError("Instruction references an account from a lookup table where a known account is required.");
    return k.toBase58();
  };

  let cuLimit = 200_000;
  let cuPriceMicroLamports = 0n;
  const programs: string[] = [];

  for (const ix of msg.compiledInstructions) {
    const program = keyAt(ix.programIdIndex);
    programs.push(program);
    if (!allowed.has(program)) throw new SignerRuleError(`Program ${program} is not on the signer's allow list.`);
    const data = Buffer.from(ix.data);

    if (program === SOLANA_PROGRAMS.system) {
      const kind = data.readUInt32LE(0);
      if (kind !== 2) throw new SignerRuleError(`System instruction ${kind} is not allowed.`);
      const dest = keyAt(ix.accountKeyIndexes[1] ?? -1);
      if (dest !== ownerB58 && !wsolAccounts.has(dest)) {
        throw new SignerRuleError(`SOL transfer to ${dest} is not to the wallet's own account.`);
      }
    } else if (program === SOLANA_PROGRAMS.token || program === SOLANA_PROGRAMS.token2022) {
      const kind = data[0];
      if (kind === 17) continue; // SyncNative
      if (kind === 9) {
        // CloseAccount: [account, destination, owner]
        const dest = keyAt(ix.accountKeyIndexes[1] ?? -1);
        if (dest !== ownerB58) throw new SignerRuleError("Closing a token account must return the rent to the wallet.");
        continue;
      }
      throw new SignerRuleError(`Token instruction ${String(kind)} is not allowed at the top level.`);
    } else if (program === SOLANA_PROGRAMS.associatedToken) {
      // Create / CreateIdempotent: [payer, ata, wallet, mint, system, tokenProgram]
      const kind = data.length === 0 ? 0 : data[0];
      if (kind !== 0 && kind !== 1) throw new SignerRuleError(`Associated-token instruction ${String(kind)} is not allowed.`);
      const wallet = keyAt(ix.accountKeyIndexes[2] ?? -1);
      if (wallet !== ownerB58) throw new SignerRuleError("Token accounts may only be created for the wallet itself.");
    } else if (program === SOLANA_PROGRAMS.computeBudget) {
      if (data[0] === 2) cuLimit = data.readUInt32LE(1);
      if (data[0] === 3) cuPriceMicroLamports = data.readBigUInt64LE(1);
    }
  }

  const priorityFeeLamports = Number((cuPriceMicroLamports * BigInt(cuLimit)) / 1_000_000n);
  const cap = rules.maxPriorityFeeLamports ?? 5_000_000;
  if (priorityFeeLamports > cap) {
    throw new SignerRuleError(`Priority fee of ${priorityFeeLamports} lamports is over the ${cap} lamport cap.`);
  }
  return { programs, priorityFeeLamports };
}

export class SignerRuleError extends Error {
  override name = "SignerRuleError";
}
