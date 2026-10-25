import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
   * does not compete with OpenClaw for updates.
   */
  telegram: z.object({ botToken: z.string().min(10), ownerChatId: z.string().min(1) }).optional(),
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
