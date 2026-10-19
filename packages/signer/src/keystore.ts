import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deriveSessionKeyOf } from "./derive.js";

/**
 * Every key Fren holds. Lives only inside the signer process; the engine and
 * the agent see addresses, never this object.
 */
export interface KeyMaterial {
  /** Solana ed25519 secret key (64 bytes), base64. */
  solanaSecret: string;
  /** EVM master key. Owns the Hyperliquid account; used only to approve the agent key. */
  evmMaster: `0x${string}`;
  /** Hyperliquid API ("agent") key. Can trade, cannot withdraw. */
  hlAgent: `0x${string}`;
}

export interface Addresses {
  solana: string;
  evm: `0x${string}`;
  hlAgent: `0x${string}`;
  /** Derive session key (option trading only). Missing from keystores written before options. */
  deriveSession?: `0x${string}`;
}

interface KeystoreFile {
  version: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
  addresses: Addresses;
}

const KDF = { N: 1 << 15, r: 8, p: 1 };

export function generateKeys(): KeyMaterial {
  return {
    solanaSecret: Buffer.from(Keypair.generate().secretKey).toString("base64"),
    evmMaster: generatePrivateKey(),
    hlAgent: generatePrivateKey(),
  };
}

export function addressesOf(keys: KeyMaterial): Addresses {
  return {
    solana: Keypair.fromSecretKey(Buffer.from(keys.solanaSecret, "base64")).publicKey.toBase58(),
    evm: privateKeyToAccount(keys.evmMaster).address,
    hlAgent: privateKeyToAccount(keys.hlAgent).address,
    deriveSession: privateKeyToAccount(deriveSessionKeyOf(keys.evmMaster)).address,
  };
}

function deriveKey(passphrase: string, salt: Buffer, kdf = KDF): Buffer {
  return scryptSync(passphrase, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r });
}

export function encryptKeystore(keys: KeyMaterial, passphrase: string): KeystoreFile {
  if (passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
  return {
    version: 1,
    kdf: { name: "scrypt", ...KDF, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    ciphertext: ciphertext.toString("base64"),
    addresses: addressesOf(keys),
  };
}

export function decryptKeystore(file: KeystoreFile, passphrase: string): KeyMaterial {
  const key = deriveKey(passphrase, Buffer.from(file.kdf.salt, "base64"), file.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64"));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, "base64"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new Error("Wrong passphrase or corrupted keystore.");
  }
  return JSON.parse(plain.toString("utf8")) as KeyMaterial;
}

export function writeKeystore(path: string, keys: KeyMaterial, passphrase: string): Addresses {
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing keystore at ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file = encryptKeystore(keys, passphrase);
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
  return file.addresses;
}

export function readKeystore(path: string, passphrase: string): KeyMaterial {
  const file = JSON.parse(readFileSync(path, "utf8")) as KeystoreFile;
  if (file.version !== 1) throw new Error(`Unsupported keystore version ${String(file.version)}`);
  return decryptKeystore(file, passphrase);
}

/** Addresses are stored in the clear so the engine can show them without unlocking. */
export function readKeystoreAddresses(path: string): Addresses {
  return (JSON.parse(readFileSync(path, "utf8")) as KeystoreFile).addresses;
}
