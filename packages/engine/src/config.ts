import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const JarvisConfig = z.object({
  /** "testnet" uses Hyperliquid testnet; Jupiter has no testnet, so use paper mode for spot there. */
  network: z.enum(["mainnet", "testnet"]).default("testnet"),
  solanaRpcUrl: z.string().url().default("https://api.mainnet-beta.solana.com"),
  hyperliquidApiUrl: z.string().url().optional(),
  /** Jupiter Swap API base. lite-api needs no key; set jupiterApiKey to use api.jup.ag. */
  jupiterApiUrl: z.string().url().default("https://lite-api.jup.ag"),
  jupiterApiKey: z.string().optional(),
  api: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(7420),
    })
    .default({ host: "127.0.0.1", port: 7420 }),
  /**
   * Direct line to the owner for confirmation codes and watcher alerts. Uses the
   * same bot as OpenClaw's Telegram channel; Jarvis only calls sendMessage, so it
   * does not compete with OpenClaw for updates.
   */
  telegram: z.object({ botToken: z.string().min(10), ownerChatId: z.string().min(1) }).optional(),
  watcherIntervalMs: z.number().int().min(2000).default(15_000),
  /** Starting paper balance in USDC. */
  paperStartingUsd: z.number().positive().default(10_000),
});
export type JarvisConfig = z.infer<typeof JarvisConfig>;

export function jarvisHome(): string {
  return process.env.JARVIS_HOME ?? join(homedir(), ".jarvis");
}

export interface JarvisPaths {
  home: string;
  config: string;
  keystore: string;
  passphrase: string;
  apiToken: string;
  db: string;
}

export function jarvisPaths(home = jarvisHome()): JarvisPaths {
  return {
    home,
    config: join(home, "config.json"),
    keystore: join(home, "keystore.json"),
    passphrase: join(home, "signer.pass"),
    apiToken: join(home, "api-token"),
    db: join(home, "jarvis.sqlite"),
  };
}

export function loadConfig(paths: JarvisPaths): JarvisConfig {
  const raw = existsSync(paths.config) ? JSON.parse(readFileSync(paths.config, "utf8")) : {};
  return JarvisConfig.parse(raw);
}

export function hyperliquidApiUrl(cfg: JarvisConfig): string {
  if (cfg.hyperliquidApiUrl) return cfg.hyperliquidApiUrl;
  return cfg.network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";
}
