#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readKeystoreAddresses } from "@fren/signer";
import { frenPaths, initFren, loadConfig, parseNotify } from "./config.js";
import { startDaemon } from "./daemon.js";
import { runSetup, systemSetupDeps } from "./setup.js";
import { serveSetup } from "./setup-web.js";

const HELP = `fren: self-hosted on-chain trading agent backend

  fren init [--network testnet|mainnet] [--notify whatsapp:+15551234567]
            [--telegram-token T --telegram-chat ID]
      Create wallets, an API token and a config in $FREN_HOME (default ~/.fren).
      --notify sends codes and alerts to you on any channel OpenClaw is connected
      to (whatsapp, telegram, signal, discord...); repeat it for a fallback.
  fren setup [--server]
      Guided setup: your AI model, Telegram or WhatsApp, wallets, the OpenClaw
      plugin and a background service. Safe to run again. --server is for the
      VPS installer, which sets up the services itself.
  fren setup --web --token T [--port 7421] [--done-file F]
      The same setup as a page in the browser (for a VPS), on 127.0.0.1,
      for whoever has the token. Writes F when the owner finishes.
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
      const notify = (values.notify ?? []).map(parseNotify);
      const { config, addresses: a } = initFren(paths, {
        network: values.network as "mainnet" | "testnet",
        solanaRpcUrl: values["solana-rpc"],
        notify,
        telegram:
          values["telegram-token"] && values["telegram-chat"]
            ? { botToken: values["telegram-token"], ownerChatId: values["telegram-chat"] }
            : undefined,
      });
      console.log(`Fren is set up in ${paths.home} (${config.network}, paper mode until you switch it).

Solana wallet:      ${a.solana}
EVM / Hyperliquid:  ${a.evm}
Trading-only key:   ${a.hlAgent}

Next: \`fren start\`, then install the OpenClaw plugin (see README), or run \`fren setup\` for the guided version.`);
      const lines = [...(config.telegram ? ["Telegram (direct)"] : []), ...config.notify.map((n) => `${n.channel} ${n.to}`)];
      if (lines.length) {
        console.log(`\nCodes and alerts go to: ${lines.join(", then ")}.`);
      } else {
        console.log(`\nTip: add --notify whatsapp:+<your number> (or --telegram-token and --telegram-chat) so codes and alerts reach you directly, not through the agent.`);
      }
      return;
    }
    case "setup": {
      const { values } = parseArgs({
        args: rest,
        options: {
          server: { type: "boolean", default: false },
          web: { type: "boolean", default: false },
          token: { type: "string" },
          port: { type: "string" },
          "done-file": { type: "string" },
        },
      });
      if (values.web) {
        const token = values.token ?? process.env.FREN_SETUP_TOKEN;
        if (!token || token.length < 24) throw new Error("--web needs --token (24+ characters) or FREN_SETUP_TOKEN.");
        await serveSetup(systemSetupDeps(paths), {
          token,
          ...(values.port ? { port: Number(values.port) } : {}),
          ...(values["done-file"] ? { doneFile: values["done-file"] } : {}),
        });
        return;
      }
      await runSetup(systemSetupDeps(paths), { server: values.server ?? false });
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
