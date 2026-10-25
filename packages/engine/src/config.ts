import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeys, readKeystoreAddresses, writeKeystore } from "@fren/signer";
import { z } from "zod";

export const FrenConfig = z.object({
  /** "testnet" uses Hyperliquid testnet; Jupiter has no testnet, so use paper mode for spot there. */
  network: z.enum(["mainnet", "testnet"]).default("testnet"),
  solanaRpcUrl: z.string().url().default("https://api.mainnet-beta.solana.com"),
  hyperliquidApiUrl: z.string().url().optional(),
  /** Jupiter API base. Works without a key at a low rate limit; set jupiterApiKey (free at portal.jup.ag) for snipes. */
  jupiterApiUrl: z.string().url().default("https://api.jup.ag"),
  jupiterApiKey: z.string().optional(),
  /** Relay API, for tokens on Base, Robinhood Chain and Arbitrum. */
  relayApiUrl: z.string().url().optional(),
  relayApiKey: z.string().optional(),
  /** Kamino's API, for USDC lending rates and transactions. */
  kaminoApiUrl: z.string().url().default("https://api.kamino.finance"),
  /** Derive (options) API base; defaults to mainnet or testnet by network. */
  deriveApiUrl: z.string().url().optional(),
  /** RPC overrides for EVM chains. */
  evmRpcUrls: z.object({ base: z.string().url(), robinhood: z.string().url(), arbitrum: z.string().url() }).partial().default({}),
  /** Jito tip on launch snipes, in lamports (0.001 SOL default; the signer refuses more than 0.01 SOL). */
  snipeTipLamports: z.number().int().min(0).max(10_000_000).default(1_000_000),
  api: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(7420),
    })
    .default({ host: "127.0.0.1", port: 7420 }),
  /**
   * Direct line to the owner for confirmation codes and watcher alerts. Uses the
   * same bot as OpenClaw's Telegram channel; Fren only calls sendMessage, so it
   * does not compete with OpenClaw for updates. Tried before `notify`.
   */
  telegram: z.object({ botToken: z.string().min(10), ownerChatId: z.string().min(1) }).optional(),
  /**
   * Reach the owner on any channel the OpenClaw gateway is connected to, such as
   * WhatsApp: { channel: "whatsapp", to: "+15551234567" }. Tried in order, after
   * `telegram`; the first that works gets the message.
   */
  notify: z
    .array(z.object({ channel: z.string().min(1), to: z.string().min(1), account: z.string().min(1).optional() }))
    .default([]),
  /** The OpenClaw CLI, for `notify`. */
  openclawBin: z.string().default("openclaw"),
  watcherIntervalMs: z.number().int().min(2000).default(15_000),
  /** How often launch snipes check whether their token trades yet. */
  snipeIntervalMs: z.number().int().min(500).default(2_000),
  /** Starting paper balance in USDC. */
  paperStartingUsd: z.number().positive().default(10_000),
});
export type FrenConfig = z.infer<typeof FrenConfig>;

export function frenHome(): string {
  return process.env.FREN_HOME ?? join(homedir(), ".fren");
}

export interface FrenPaths {
  home: string;
  config: string;
  keystore: string;
  passphrase: string;
  apiToken: string;
  db: string;
}

export function frenPaths(home = frenHome()): FrenPaths {
  return {
    home,
    config: join(home, "config.json"),
    keystore: join(home, "keystore.json"),
    passphrase: join(home, "signer.pass"),
    apiToken: join(home, "api-token"),
    db: join(home, "fren.sqlite"),
  };
}

export function loadConfig(paths: FrenPaths): FrenConfig {
  const raw = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, "utf8")) : {};
  return FrenConfig.parse(raw);
}

export function relayApiUrl(cfg: FrenConfig): string {
  if (cfg.relayApiUrl) return cfg.relayApiUrl;
  return cfg.network === "mainnet" ? "https://api.relay.link" : "https://api.testnets.relay.link";
}

export function hyperliquidApiUrl(cfg: FrenConfig): string {
  if (cfg.hyperliquidApiUrl) return cfg.hyperliquidApiUrl;
  return cfg.network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";
}

export function deriveApiUrl(cfg: FrenConfig): string {
  if (cfg.deriveApiUrl) return cfg.deriveApiUrl;
  return cfg.network === "mainnet" ? "https://api.derive.xyz/v3" : "https://testnet.api.derive.xyz/v3";
}

/** Jupiter Lend: the keyed API when there's a Jupiter key, else Jupiter's keyless host. */
export function jupiterLendApiUrl(cfg: FrenConfig): string {
  return cfg.jupiterApiKey ? `${cfg.jupiterApiUrl}/lend/v1` : "https://lite-api.jup.ag/lend/v1";
}

/** `channel:target`, e.g. whatsapp:+15551234567. */
export function parseNotify(spec: string): { channel: string; to: string } {
  const at = spec.indexOf(":");
  if (at <= 0 || at === spec.length - 1) throw new Error(`--notify takes channel:target, e.g. whatsapp:+15551234567 (got "${spec}").`);
  return { channel: spec.slice(0, at).toLowerCase(), to: spec.slice(at + 1) };
}

export interface InitOptions {
  network?: "mainnet" | "testnet";
  solanaRpcUrl?: string;
  jupiterApiKey?: string;
  /** Replaces the notify list when given and non-empty. */
  notify?: { channel: string; to: string }[];
  telegram?: { botToken: string; ownerChatId: string };
}

/**
 * Create (or keep) the passphrase, API token and keystore, and merge options
 * into the config. Existing wallets are never replaced.
 */
export function initFren(paths: FrenPaths, opts: InitOptions) {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.passphrase)) writeFileSync(paths.passphrase, randomBytes(32).toString("base64url"), { mode: 0o600 });
  if (!existsSync(paths.apiToken)) writeFileSync(paths.apiToken, randomBytes(32).toString("base64url"), { mode: 0o600 });
  if (!existsSync(paths.keystore)) {
    writeKeystore(paths.keystore, generateKeys(), readFileSync(paths.passphrase, "utf8").trim());
  }
  const existing = existsSync(paths.config) ? (JSON.parse(readFileSync(paths.config, "utf8")) as Record<string, unknown>) : {};
  const config = FrenConfig.parse({
    ...existing,
    ...(opts.network ? { network: opts.network } : {}),
    ...(opts.solanaRpcUrl ? { solanaRpcUrl: opts.solanaRpcUrl } : {}),
    ...(opts.jupiterApiKey ? { jupiterApiKey: opts.jupiterApiKey } : {}),
    ...(opts.notify?.length ? { notify: opts.notify } : {}),
    ...(opts.telegram ? { telegram: opts.telegram } : {}),
  });
  writeFileSync(paths.config, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { config, addresses: readKeystoreAddresses(paths.keystore) };
}
