#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generateKeys, readKeystoreAddresses, writeKeystore } from "@fren/signer";
import { frenPaths, FrenConfig, loadConfig } from "./config.js";
import { startDaemon } from "./daemon.js";

const HELP = `fren: self-hosted on-chain trading agent backend

  fren init [--network testnet|mainnet] [--notify whatsapp:+15551234567]
            [--telegram-token T --telegram-chat ID]
      Create wallets, an API token and a config in $FREN_HOME (default ~/.fren).
      --notify sends codes and alerts to you on any channel OpenClaw is connected
      to (whatsapp, telegram, signal, discord...); repeat it for a fallback.
  fren start
      Run the engine: signer process, local API for OpenClaw and the watcher.
  fren wallet
      Print wallet addresses.
  fren status
      Ask the running engine for positions and watched conditions.
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const paths = frenPaths();

  switch (cmd) {
    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: {
          network: { type: "string", default: "testnet" },
          "telegram-token": { type: "string" },
          "telegram-chat": { type: "string" },
          notify: { type: "string", multiple: true },
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
      const notify = (values.notify ?? []).map((spec) => {
        const at = spec.indexOf(":");
        if (at <= 0 || at === spec.length - 1) throw new Error(`--notify takes channel:target, e.g. whatsapp:+15551234567 (got "${spec}").`);
        return { channel: spec.slice(0, at).toLowerCase(), to: spec.slice(at + 1) };
      });
      const config = FrenConfig.parse({
        ...existing,
        network: values.network,
        ...(values["solana-rpc"] ? { solanaRpcUrl: values["solana-rpc"] } : {}),
        ...(notify.length ? { notify } : {}),
        ...(values["telegram-token"] && values["telegram-chat"]
          ? { telegram: { botToken: values["telegram-token"], ownerChatId: values["telegram-chat"] } }
          : {}),
      });
      writeFileSync(paths.config, JSON.stringify(config, null, 2), { mode: 0o600 });
      const a = readKeystoreAddresses(paths.keystore);
      console.log(`Fren is set up in ${paths.home} (${config.network}, paper mode until you switch it).

Solana wallet:      ${a.solana}
EVM / Hyperliquid:  ${a.evm}
Trading-only key:   ${a.hlAgent}

Next: \`fren start\`, then install the OpenClaw plugin (see README).`);
      const lines = [...(config.telegram ? ["Telegram (direct)"] : []), ...config.notify.map((n) => `${n.channel} ${n.to}`)];
      if (lines.length) {
        console.log(`\nCodes and alerts go to: ${lines.join(", then ")}.`);
      } else {
        console.log(`\nTip: add --notify whatsapp:+<your number> (or --telegram-token and --telegram-chat) so codes and alerts reach you directly, not through the agent.`);
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
