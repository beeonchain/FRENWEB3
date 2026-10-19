import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { addressesOf, generateKeys, readKeystore, readKeystoreAddresses, writeKeystore } from "./keystore.js";
import { SOLANA_PROGRAMS, associatedTokenAddress, checkSolanaTransaction } from "./rules.js";
import { createSigner } from "./signer.js";

const PASS = "correct horse battery staple";

function txFor(payer: PublicKey, ixs: TransactionInstruction[]) {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

describe("keystore", () => {
  it("round-trips, refuses overwrite, and keeps the file private", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-ks-"));
    const path = join(dir, "keystore.json");
    const keys = generateKeys();
    const addrs = writeKeystore(path, keys, PASS);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readKeystore(path, PASS)).toEqual(keys);
    expect(readKeystoreAddresses(path)).toEqual(addrs);
    expect(() => readKeystore(path, "wrong passphrase!!")).toThrow(/Wrong passphrase/);
    expect(() => writeKeystore(path, keys, PASS)).toThrow(/Refusing to overwrite/);
  });
});

describe("hyperliquid rules", () => {
  const signer = createSigner(generateKeys());

  it("signs trading actions with the agent key", async () => {
    const sig = await signer.hlSignL1({
      action: { type: "cancel", cancels: [{ a: 0, o: 1 }] },
      nonce: 1,
      isTestnet: true,
    });
    expect(sig.r).toMatch(/^0x[0-9a-f]+$/);
  });

  it("refuses withdrawals, transfers and anything unlisted", async () => {
    for (const type of ["withdraw3", "usdSend", "spotSend", "approveAgent", "approveBuilderFee", "vaultTransfer"]) {
      await expect(signer.hlSignL1({ action: { type }, nonce: 1, isTestnet: true })).rejects.toThrow(/not allowed/);
    }
  });

  it("refuses Hyperliquid deposits small enough to be lost", async () => {
    await expect(signer.hlDepositFromArbitrum({ amountUsd: 4, isTestnet: true })).rejects.toThrow(/at least 5 USDC/);
  });

  it("only approves its own agent", async () => {
    const keys = generateKeys();
    const res = await createSigner(keys).hlApproveAgent({ isTestnet: true });
    expect(res.action.agentAddress).toBe(addressesOf(keys).hlAgent.toLowerCase());
  });
});

describe("solana rules", () => {
  const keys = generateKeys();
  const owner = new PublicKey(addressesOf(keys).solana);
  const stranger = Keypair.generate().publicKey;
  const wsol = associatedTokenAddress(owner, new PublicKey("So11111111111111111111111111111111111111112"), SOLANA_PROGRAMS.token);

  it("allows wrapping SOL into the wallet's own account plus a Jupiter route", () => {
    const tx = txFor(owner, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: 1_000_000 }),
      new TransactionInstruction({ programId: new PublicKey(SOLANA_PROGRAMS.jupiterV6), keys: [], data: Buffer.from([1, 2, 3]) }),
    ]);
    const report = checkSolanaTransaction(tx, owner);
    expect(report.priorityFeeLamports).toBe(300);
  });

  it("refuses a SOL transfer to someone else", () => {
    const tx = txFor(owner, [SystemProgram.transfer({ fromPubkey: owner, toPubkey: stranger, lamports: 1 })]);
    expect(() => checkSolanaTransaction(tx, owner)).toThrow(/not to the wallet's own account/);
  });

  it("refuses unknown programs", () => {
    const tx = txFor(owner, [new TransactionInstruction({ programId: stranger, keys: [], data: Buffer.alloc(0) })]);
    expect(() => checkSolanaTransaction(tx, owner)).toThrow(/allow list/);
  });

  it("refuses a top-level token transfer or approval", () => {
    const transfer = new TransactionInstruction({
      programId: new PublicKey(SOLANA_PROGRAMS.token),
      keys: [
        { pubkey: wsol, isSigner: false, isWritable: true },
        { pubkey: stranger, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
    });
    expect(() => checkSolanaTransaction(txFor(owner, [transfer]), owner)).toThrow(/Token instruction 3/);
  });

  it("refuses when someone else pays the fee", () => {
    const tx = txFor(stranger, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]);
    expect(() => checkSolanaTransaction(tx, owner)).toThrow(/fee/);
  });

  it("caps the priority fee", () => {
    const tx = txFor(owner, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }),
    ]);
    expect(() => checkSolanaTransaction(tx, owner)).toThrow(/Priority fee/);
  });

  it("signs an allowed transaction", async () => {
    const tx = txFor(owner, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })]);
    const res = await createSigner(keys).solSignTransaction({
      txBase64: Buffer.from(tx.serialize()).toString("base64"),
      maxSolSpendLamports: 10_000_000,
    });
    const signed = VersionedTransaction.deserialize(Buffer.from(res.signedTxBase64, "base64"));
    expect(signed.signatures[0]!.some((b) => b !== 0)).toBe(true);
  });
});

describe("signer process", () => {
  it("runs out of process and answers over stdio", async () => {
    // Uses the built output so the child can be spawned with plain node.
    const { SignerProcess } = await import("../dist/client.js");
    const dir = mkdtempSync(join(tmpdir(), "jarvis-sp-"));
    const ks = join(dir, "keystore.json");
    const passFile = join(dir, "pass");
    writeFileSync(passFile, PASS, { mode: 0o600 });
    const addrs = writeKeystore(ks, generateKeys(), PASS);
    const proc = new SignerProcess({ keystorePath: ks, passphraseFile: passFile });
    try {
      expect(await proc.addresses()).toEqual(addrs);
      await expect(proc.hlSignL1({ action: { type: "withdraw3" }, nonce: 1, isTestnet: true })).rejects.toThrow(
        /not allowed/,
      );
    } finally {
      proc.close();
    }
  });
});
