import { existsSync, readFileSync } from "node:fs";
import { SignerProcess, type SignerApi } from "@jarvis/signer";
import { createApi } from "./api.js";
import { hyperliquidApiUrl, jarvisPaths, loadConfig, type JarvisConfig, type JarvisPaths } from "./config.js";
import { Jarvis } from "./engine.js";
import type { Fetch } from "./http.js";
import { TelegramNotifier } from "./notify.js";
import { Store } from "./store.js";
import { HyperliquidVenue } from "./venues/hyperliquid.js";
import { JupiterVenue } from "./venues/jupiter.js";

export interface BuildOptions {
  config: JarvisConfig;
  store: Store;
  signer: SignerApi | null;
  fetchFn?: Fetch;
}

/** Wire the engine from its parts. Used by the daemon and by tests with fakes. */
export function buildJarvis({ config, store, signer, fetchFn = fetch }: BuildOptions): Jarvis {
  const isTestnet = config.network === "testnet";
  const jupiterUrl = config.jupiterApiKey ? "https://api.jup.ag" : config.jupiterApiUrl;
  return new Jarvis({
    store,
    signer,
    isTestnet,
    notifier: new TelegramNotifier(store, fetchFn, config.telegram),
    hyperliquid: new HyperliquidVenue({ fetchFn, apiUrl: hyperliquidApiUrl(config), isTestnet, store, signer }),
    jupiter: new JupiterVenue({
      fetchFn,
      apiUrl: jupiterUrl,
      ...(config.jupiterApiKey ? { apiKey: config.jupiterApiKey } : {}),
      solanaRpcUrl: config.solanaRpcUrl,
      store,
      signer,
    }),
  });
}

export async function startDaemon(paths: JarvisPaths = jarvisPaths()) {
  const config = loadConfig(paths);
  if (!existsSync(paths.apiToken)) throw new Error(`No API token at ${paths.apiToken}. Run \`jarvis init\` first.`);
  const token = readFileSync(paths.apiToken, "utf8").trim();
  const store = new Store(paths.db, config.paperStartingUsd);

  let signer: SignerProcess | null = null;
  if (existsSync(paths.keystore)) {
    signer = new SignerProcess({
      keystorePath: paths.keystore,
      passphraseFile: paths.passphrase,
      solanaRpcUrl: config.solanaRpcUrl,
      ...(process.env.JARVIS_SIGNER_PREFIX ? { commandPrefix: process.env.JARVIS_SIGNER_PREFIX.split(" ") } : {}),
    });
    await signer.ready;
  }

  const jarvis = buildJarvis({ config, store, signer });
  const server = createApi(jarvis, token);
  await new Promise<void>((res) => server.listen(config.api.port, config.api.host, res));

  const timer = setInterval(() => {
    jarvis.tick().catch((err: Error) => console.error(`watcher: ${err.message}`));
  }, config.watcherIntervalMs);

  const limits = jarvis.limits();
  console.log(
    `jarvisd listening on http://${config.api.host}:${config.api.port} · ${config.network} · ${limits.mode} mode${limits.paused ? " · stopped" : ""}`,
  );

  const shutdown = () => {
    clearInterval(timer);
    server.close();
    signer?.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { jarvis, server, stop: shutdown };
}
