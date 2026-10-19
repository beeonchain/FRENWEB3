import { existsSync, readFileSync } from "node:fs";
import { SignerProcess, type SignerApi } from "@fren/signer";
import { createApi } from "./api.js";
import { Connection } from "@solana/web3.js";
import { hyperliquidApiUrl, frenPaths, loadConfig, relayApiUrl, type FrenConfig, type FrenPaths } from "./config.js";
import { Fren } from "./engine.js";
import type { Fetch } from "./http.js";
import { TelegramNotifier } from "./notify.js";
import { Store } from "./store.js";
import { HyperliquidVenue } from "./venues/hyperliquid.js";
import { JupiterVenue } from "./venues/jupiter.js";
import { OnlinePumpFun } from "./venues/pumpfun.js";
import { RelayVenue } from "./venues/relay.js";

export interface BuildOptions {
  config: FrenConfig;
  store: Store;
  signer: SignerApi | null;
  fetchFn?: Fetch;
}

/** Wire the engine from its parts. Used by the daemon and by tests with fakes. */
export function buildFren({ config, store, signer, fetchFn = fetch }: BuildOptions): Fren {
  const isTestnet = config.network === "testnet";
  return new Fren({
    store,
    signer,
    isTestnet,
    notifier: new TelegramNotifier(store, fetchFn, config.telegram),
    hyperliquid: new HyperliquidVenue({ fetchFn, apiUrl: hyperliquidApiUrl(config), isTestnet, store, signer }),
    jupiter: new JupiterVenue({
      fetchFn,
      apiUrl: config.jupiterApiUrl,
      ...(config.jupiterApiKey ? { apiKey: config.jupiterApiKey } : {}),
      solanaRpcUrl: config.solanaRpcUrl,
      store,
      signer,
      pumpFun: new OnlinePumpFun(new Connection(config.solanaRpcUrl, { commitment: "confirmed", fetch: fetchFn })),
      snipeTipLamports: config.snipeTipLamports,
    }),
    relay: new RelayVenue({
      fetchFn,
      apiUrl: relayApiUrl(config),
      ...(config.relayApiKey ? { apiKey: config.relayApiKey } : {}),
      isTestnet,
      store,
      signer,
      rpcUrls: config.evmRpcUrls,
    }),
  });
}

export async function startDaemon(paths: FrenPaths = frenPaths()) {
  const config = loadConfig(paths);
  if (!existsSync(paths.apiToken)) throw new Error(`No API token at ${paths.apiToken}. Run \`fren init\` first.`);
  const token = readFileSync(paths.apiToken, "utf8").trim();
  const store = new Store(paths.db, config.paperStartingUsd);

  let signer: SignerProcess | null = null;
  if (existsSync(paths.keystore)) {
    signer = new SignerProcess({
      keystorePath: paths.keystore,
      passphraseFile: paths.passphrase,
      solanaRpcUrl: config.solanaRpcUrl,
      evmRpcUrls: evmRpcsById(config),
      ...(process.env.FREN_SIGNER_PREFIX ? { commandPrefix: process.env.FREN_SIGNER_PREFIX.split(" ") } : {}),
    });
    await signer.ready;
  }

  const fren = buildFren({ config, store, signer });
  const server = createApi(fren, token);
  await new Promise<void>((res) => server.listen(config.api.port, config.api.host, res));

  const timer = setInterval(() => {
    fren.tick().catch((err: Error) => console.error(`watcher: ${err.message}`));
  }, config.watcherIntervalMs);
  const snipeTimer = setInterval(() => {
    fren.snipeTick().catch((err: Error) => console.error(`snipes: ${err.message}`));
  }, config.snipeIntervalMs);

  const limits = fren.limits();
  console.log(
    `frend listening on http://${config.api.host}:${config.api.port} · ${config.network} · ${limits.mode} mode${limits.paused ? " · stopped" : ""}`,
  );

  const shutdown = () => {
    clearInterval(timer);
    clearInterval(snipeTimer);
    server.close();
    signer?.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { fren, server, stop: shutdown };
}

/** The signer wants RPCs by chain id; the config names chains. */
function evmRpcsById(config: FrenConfig): Record<number, string> {
  const ids = config.network === "mainnet" ? { base: 8453, robinhood: 4663, arbitrum: 42161 } : { base: 84532, robinhood: 46630, arbitrum: 421614 };
  const out: Record<number, string> = {};
  for (const [name, url] of Object.entries(config.evmRpcUrls)) if (url) out[ids[name as keyof typeof ids]] = url;
  return out;
}
