#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generateKeys, readKeystoreAddresses, writeKeystore } from "@jarvis/signer";
import { jarvisPaths, JarvisConfig, loadConfig } from "./config.js";
import { startDaemon } from "./daemon.js";

const HELP = `jarvis: self-hosted on-chain trading agent backend

  jarvis init [--network testnet|mainnet] [--telegram-token T --telegram-chat ID]
      Create wallets, an API token and a config in $JARVIS_HOME (default ~/.jarvis).
  jarvis start
      Run the engine: signer process, local API for OpenClaw and the watcher.
  jarvis wallet
      Print wallet addresses.
  jarvis status
      Ask the running engine for positions and watched conditions.
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const paths = jarvisPaths();

  switch (cmd) {
    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: {
          network: { type: "string", default: "testnet" },
          "telegram-token": { type: "string" },
          "telegram-chat": { type: "string" },
          "solana-rpc": { type: "string" },
        },
      });
      mkdirSync(paths.home, { recursive: true, mode: 0o700 });
      if (!existsSync(paths.passphrase)) writeFileSync(paths.passphrase, randomBytes(32).toString("base64url"), { mode: 0o600 });
      if (!existsSync(paths.apiToken)) writeFileSync(paths.apiToken, randomBytes(32).toString("base64url"), { mode: 0o600 });
      if (!existsSync(paths.keystore)) {
        writeKeystore(paths.keystore, generateKeys(), readFileSync(paths.passphrase, "utf8").trim());
      }
      const existing = existsSync(paths.config) ? (JSON.parse(readFileSync(paths.config, "utf8")) as Record<string, unknown>) : {};
      const config = JarvisConfig.parse({
        ...existing,
        network: values.network,
        ...(values["solana-rpc"] ? { solanaRpcUrl: values["solana-rpc"] } : {}),
        ...(values["telegram-token"] && values["telegram-chat"]
          ? { telegram: { botToken: values["telegram-token"], ownerChatId: values["telegram-chat"] } }
          : {}),
      });
      writeFileSync(paths.config, JSON.stringify(config, null, 2), { mode: 0o600 });
      const a = readKeystoreAddresses(paths.keystore);
      console.log(`Jarvis is set up in ${paths.home} (${config.network}, paper mode until you switch it).

Solana wallet:      ${a.solana}
EVM / Hyperliquid:  ${a.evm}
Trading-only key:   ${a.hlAgent}

Next: \`jarvis start\`, then install the OpenClaw plugin (see README).`);
      if (!config.telegram) {
        console.log(`\nTip: add --telegram-token and --telegram-chat so confirmation codes reach you directly, never through the agent.`);
      }
      return;
    }
    case "start":
      await startDaemon(paths);
      return;
    case "wallet": {
      const a = readKeystoreAddresses(paths.keystore);
      console.log(`Solana: ${a.solana}\nEVM:    ${a.evm}\nAgent:  ${a.hlAgent}`);
      return;
    }
    case "status": {
      const cfg = loadConfig(paths);
      const token = readFileSync(paths.apiToken, "utf8").trim();
      const res = await fetch(`http://${cfg.api.host}:${cfg.api.port}/status`, { headers: { authorization: `Bearer ${token}` } });
      console.log(((await res.json()) as { text: string }).text);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
