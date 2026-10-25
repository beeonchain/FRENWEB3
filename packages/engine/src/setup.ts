import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { FrenPaths, InitOptions } from "./config.js";
import { initFren } from "./config.js";
import type { Fetch } from "./http.js";

/**
 * `fren setup`: the guided first run. It asks a handful of questions and does
 * everything the README's quick start does by hand: OpenClaw's model login,
 * Telegram or WhatsApp with you as the only allowed sender and owner, wallets,
 * the plugin, and background services. Safe to run again: wallets are kept.
 */

export interface Prompt {
  ask(question: string, fallback?: string): Promise<string>;
  say(text: string): void;
  close(): void;
}

/** Runs a program. `interactive` hands it the terminal (QR codes, OpenClaw's own prompts). */
export type Runner = (file: string, args: string[], opts?: { interactive?: boolean }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SetupDeps {
  paths: FrenPaths;
  io: Prompt;
  run: Runner;
  fetchFn: Fetch;
  sleep(ms: number): Promise<void>;
  openclawBin: string;
  /** packages/openclaw-plugin in this checkout. */
  pluginDir: string;
  /** How to start the engine: [node, cli.js]. */
  frenCommand: string[];
  platform: NodeJS.Platform;
  home: string;
  user: string;
  writeFile(path: string, text: string): void;
  exists(path: string): boolean;
}

export interface SetupOptions {
  /** The VPS installer runs the engine and gateway as system services itself. */
  server: boolean;
}

export interface SetupResult {
  channel: "telegram" | "whatsapp";
  network: "mainnet" | "testnet";
  addresses: { solana: string; evm: string; hlAgent: string };
}

const E164 = /^\+[1-9]\d{6,14}$/;

export async function runSetup(deps: SetupDeps, opts: SetupOptions): Promise<SetupResult> {
  const { io } = deps;
  try {
    io.say(`
  ┌───────────────────────────────────────────┐
  │  Fren setup: a few questions, ~5 minutes  │
  └───────────────────────────────────────────┘
`);
    const oc = await openclawVersion(deps);
    if (!oc) {
      throw new Error(`OpenClaw isn't installed (looked for "${deps.openclawBin}"). Install it with:\n  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard\nthen run \`fren setup\` again.`);
    }
    io.say(`✓ OpenClaw ${oc}`);

    await modelLogin(deps, opts);

    const channel = await choose(io, "Where do you want to talk to Fren?", [
      ["telegram", "Telegram (recommended: approval codes go on a private line the AI never sees)"],
      ["whatsapp", "WhatsApp"],
    ]);
    const line = channel === "telegram" ? await setupTelegram(deps) : await setupWhatsApp(deps);

    const network = await choose(io, "Which network?", [
      ["mainnet", "Mainnet: real prices, play money until you switch to live (recommended)"],
      ["testnet", "Testnet: Hyperliquid testnet, for trying things out"],
    ]);
    const jupiterApiKey = (await io.ask("Jupiter API key for fast launch snipes (free at portal.jup.ag, Enter to skip)", "")).trim();

    io.say("Creating wallets and installing the Fren plugin into OpenClaw…");
    const { addresses } = await finishSetup(deps, { network, jupiterApiKey, line });
    io.say(`✓ Wallets ready in ${deps.paths.home} (encrypted; keys never leave this machine)\n✓ Plugin installed`);

    if (!opts.server) await installServices(deps);

    io.say(`
  ✓ Fren is set up (${network}, paper mode: no real money moves until you say so).

  Fund it by sending USDC to:
    Solana (spot, meme coins, Solana yield):   ${addresses.solana}
    Arbitrum or Base (perps, bets, EVM coins):  ${addresses.evm}
  plus a little SOL (~0.05) for Solana fees and ETH on Arbitrum or Base for gas.

  Then message your bot: "what's my wallet", "long BTC 5x with $20", "stop everything".
  When you're ready for real money: /limits mode=live

  Back up ${deps.paths.keystore} and ${deps.paths.passphrase} somewhere safe.
  Lose them and the funds in these wallets are gone.
`);
    return { channel, network, addresses };
  } finally {
    io.close();
  }
}

/** True when OpenClaw has a default model and credentials for it. */
export async function modelReady(deps: Pick<SetupDeps, "run" | "openclawBin">): Promise<boolean> {
  const status = await deps.run(deps.openclawBin, ["models", "status", "--json"]);
  try {
    const s = JSON.parse(status.stdout) as { defaultModel?: string; auth?: { missingProvidersInUse?: string[] } };
    return status.code === 0 && !!s.defaultModel && (s.auth?.missingProvidersInUse ?? []).length === 0;
  } catch {
    return false;
  }
}

/** API-key logins OpenClaw can do without prompts, for the web setup. */
export const MODEL_PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", authChoice: "apiKey", flag: "--anthropic-api-key", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { label: "OpenAI", authChoice: "openai-api-key", flag: "--openai-api-key", keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { label: "OpenRouter (any model)", authChoice: "openrouter-api-key", flag: "--openrouter-api-key", keyUrl: "https://openrouter.ai/keys" },
  gemini: { label: "Google Gemini", authChoice: "gemini-api-key", flag: "--gemini-api-key", keyUrl: "https://aistudio.google.com/apikey" },
} as const;
export type ModelProvider = keyof typeof MODEL_PROVIDERS;

export async function configureModelKey(deps: Pick<SetupDeps, "run" | "openclawBin">, provider: ModelProvider, apiKey: string): Promise<void> {
  const p = MODEL_PROVIDERS[provider];
  const r = await deps.run(deps.openclawBin, [
    "onboard", "--non-interactive", "--accept-risk", "--flow", "quickstart",
    "--auth-choice", p.authChoice, p.flag, apiKey,
    "--skip-channels", "--skip-daemon", "--skip-ui", "--skip-search", "--skip-health", "--skip-skills",
  ]);
  if (r.code !== 0) throw new Error(`OpenClaw didn't accept that key: ${lastLines(r)}`);
}

function lastLines(r: { stdout: string; stderr: string }): string {
  return (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n");
}

/** Wallets, config and the plugin: the last step of both setups. */
export async function finishSetup(
  deps: Pick<SetupDeps, "run" | "openclawBin" | "paths" | "pluginDir">,
  o: { network: "mainnet" | "testnet"; jupiterApiKey?: string; line: Pick<InitOptions, "telegram" | "notify"> },
) {
  const res = initFren(deps.paths, { network: o.network, ...(o.jupiterApiKey ? { jupiterApiKey: o.jupiterApiKey } : {}), ...o.line });
  await mustRun(deps, deps.openclawBin, ["plugins", "install", "--link", "--accept-capabilities", "--force", deps.pluginDir], "install the Fren plugin");
  return res;
}

export async function openclawVersion(deps: SetupDeps): Promise<string | null> {
  try {
    const r = await deps.run(deps.openclawBin, ["--version"]);
    if (r.code !== 0) return null;
    return r.stdout.match(/\d{4}\.\d+\.\d+/)?.[0] ?? r.stdout.trim();
  } catch {
    return null;
  }
}

/** OpenClaw's onboarding picks the AI model and logs in. Skipped when a model already has auth. */
async function modelLogin(deps: SetupDeps, opts: SetupOptions): Promise<void> {
  const ready = await modelReady(deps);
  if (ready && !(await yes(deps.io, "OpenClaw already has an AI model set up. Change it?", false))) return;
  deps.io.say(`
Next, OpenClaw asks which AI model Fren should think with, and logs you in
(an Anthropic, OpenAI or OpenRouter account, or an API key). Skip its chat
channel step: Fren sets that up right after.
`);
  const args = ["onboard", "--flow", "quickstart", "--skip-channels", "--skip-ui", "--skip-search"];
  // On a VPS the installer runs the gateway as a system service; locally OpenClaw installs its own.
  args.push(opts.server ? "--skip-daemon" : "--install-daemon");
  const r = await deps.run(deps.openclawBin, args, { interactive: true });
  if (r.code !== 0) throw new Error("OpenClaw's setup didn't finish. Run `fren setup` again to retry.");
}

async function setupTelegram(deps: SetupDeps): Promise<{ telegram: { botToken: string; ownerChatId: string } }> {
  const { io } = deps;
  io.say(`
Make a Telegram bot (takes a minute):
  1. Open https://t.me/BotFather and send /newbot
  2. Pick a name and a username ending in "bot"
  3. Copy the token it gives you (looks like 123456789:AA...)
`);
  let token = "";
  let bot = "";
  for (;;) {
    token = (await io.ask("Bot token")).trim();
    const found = await telegramBot(deps.fetchFn, token);
    if (found) {
      bot = found;
      break;
    }
    io.say("That token didn't work. Copy it again from BotFather, the whole thing.");
  }
  io.say(`✓ Bot @${bot}`);

  const owner = await findTelegramOwner(deps, token, bot);
  const line = await configureTelegram(deps, token, owner.id);
  io.say(`✓ Telegram linked: only ${owner.name} can use @${bot}`);
  return line;
}

/** You are the only one who can talk to the bot, and the owner for /ok, /stop and /limits. */
export async function configureTelegram(deps: Pick<SetupDeps, "run" | "openclawBin" | "fetchFn">, token: string, ownerId: string) {
  await setConfig(deps, "channels.telegram.allowFrom", JSON.stringify([ownerId]));
  await setConfig(deps, "channels.telegram.dmPolicy", "allowlist");
  await setConfig(deps, "commands.ownerAllowFrom", JSON.stringify([`telegram:${ownerId}`]));
  await mustRun(deps, deps.openclawBin, ["channels", "add", "--channel", "telegram", "--token", token], "add the Telegram channel");
  await telegram(deps.fetchFn, token, "sendMessage", { chat_id: ownerId, text: "✅ Fren found you. Setup is finishing; I'll be ready in a minute." });
  return { telegram: { botToken: token, ownerChatId: ownerId } };
}

export async function telegramBot(fetchFn: Fetch, token: string): Promise<string | null> {
  const me = await telegram<{ username: string }>(fetchFn, token, "getMe");
  return me.ok ? me.result.username : null;
}

/** One look for a private message to the bot (long-polls up to `waitS`). */
export async function pollTelegramOwner(fetchFn: Fetch, token: string, offset: number, waitS = 20) {
  const r = await telegram<TgUpdate[]>(fetchFn, token, "getUpdates", { offset, timeout: waitS, allowed_updates: ["message"] });
  if (!r.ok) return { busy: r.error_code === 409, offset, candidates: [] as { id: string; name: string }[] };
  const candidates: { id: string; name: string }[] = [];
  for (const u of r.result) {
    offset = u.update_id + 1;
    const from = u.message?.from;
    if (!from || from.is_bot || u.message?.chat.type !== "private") continue;
    candidates.push({ id: String(from.id), name: tgName(from) });
  }
  return { busy: false, offset, candidates };
}

function tgName(from: { first_name: string; last_name?: string; username?: string }): string {
  return [from.first_name, from.last_name].filter(Boolean).join(" ") + (from.username ? ` (@${from.username})` : "");
}

/** Mark updates read so the agent doesn't answer an old "/start" later. */
export async function ackTelegram(fetchFn: Fetch, token: string, offset: number): Promise<void> {
  await telegram(fetchFn, token, "getUpdates", { offset, timeout: 0 });
}

/**
 * Your Telegram user id, read from the message you send the bot, so nobody
 * has to look it up. Falls back to asking when OpenClaw is already reading
 * this bot (Telegram allows one reader) or nothing arrives.
 */
export async function findTelegramOwner(deps: Pick<SetupDeps, "io" | "fetchFn" | "sleep">, token: string, bot: string): Promise<{ id: string; name: string }> {
  const { io } = deps;
  io.say(`Now open https://t.me/${bot} on your phone and press Start (or send it any message).`);
  let offset = 0;
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const r = await pollTelegramOwner(deps.fetchFn, token, offset);
    if (r.busy) {
      io.say("OpenClaw is already reading this bot, so I can't spot your message.");
      break;
    }
    if (r.offset === offset && !r.candidates.length) {
      // An error (not a 409) or nothing new.
      await deps.sleep(500);
    }
    offset = r.offset;
    for (const c of r.candidates) {
      if (await yes(io, `Got a message from ${c.name}. Is that you?`, true)) {
        await ackTelegram(deps.fetchFn, token, offset);
        return c;
      }
    }
  }
  io.say("Message @userinfobot on Telegram and it replies with your numeric user id.");
  for (;;) {
    const id = (await io.ask("Your Telegram user id")).trim();
    if (/^\d{1,15}$/.test(id)) return { id, name: id };
    io.say("That's the number @userinfobot shows as Id, digits only.");
  }
}

interface TgUpdate {
  update_id: number;
  message?: { chat: { type: string }; from?: { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string } };
}

type TgResult<T> = { ok: true; result: T } | { ok: false; error_code: number; description?: string };

async function telegram<T>(fetchFn: Fetch, token: string, method: string, body?: unknown): Promise<TgResult<T>> {
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return (await res.json()) as TgResult<T>;
  } catch {
    return { ok: false, error_code: 0 };
  }
}

async function setupWhatsApp(deps: SetupDeps): Promise<{ notify: { channel: string; to: string }[] }> {
  const { io } = deps;
  io.say(`
WhatsApp works best with a spare number for Fren (an old phone or a second
SIM with WhatsApp on it). You chat with that number from your own phone.
You can also link your own number and talk to Fren in "Message yourself".
`);
  let mine = "";
  for (;;) {
    mine = normalizePhone(await io.ask("Your own WhatsApp number, with country code (e.g. +447700900123)")) ?? "";
    if (mine) break;
    io.say("Start with + and your country code, digits only after that.");
  }
  io.say(`
OpenClaw adds WhatsApp next. Say yes to installing its WhatsApp plugin and to
"Link WhatsApp now", then on the phone with Fren's WhatsApp:
  Settings → Linked devices → Link a device, and scan the QR code.
`);
  await mustRun(deps, deps.openclawBin, ["channels", "add", "--channel", "whatsapp"], "add the WhatsApp channel", true);
  if (!deps.exists(whatsappCreds(deps.home))) {
    await mustRun(deps, deps.openclawBin, ["channels", "login", "--channel", "whatsapp"], "link WhatsApp", true);
  }
  const line = await configureWhatsAppOwner(deps, mine);
  io.say(`✓ WhatsApp linked: only ${mine} can use it`);
  return line;
}

export function whatsappCreds(home: string): string {
  return join(home, ".openclaw/credentials/whatsapp/default/creds.json");
}

export async function configureWhatsAppOwner(deps: Pick<SetupDeps, "run" | "openclawBin">, number: string) {
  await setConfig(deps, "channels.whatsapp.allowFrom", JSON.stringify([number]));
  await setConfig(deps, "channels.whatsapp.dmPolicy", "allowlist");
  await setConfig(deps, "commands.ownerAllowFrom", JSON.stringify([`whatsapp:${number}`]));
  return { notify: [{ channel: "whatsapp", to: number }] };
}

export function normalizePhone(raw: string): string | null {
  const n = raw.replace(/[\s()-]/g, "");
  return E164.test(n) ? n : null;
}

async function setConfig(deps: Pick<SetupDeps, "run" | "openclawBin">, path: string, value: string): Promise<void> {
  await mustRun(deps, deps.openclawBin, ["config", "set", path, value], `set ${path}`);
}

async function mustRun(deps: Pick<SetupDeps, "run">, file: string, args: string[], what: string, interactive = false): Promise<string> {
  const r = await deps.run(file, args, { interactive });
  if (r.code !== 0) throw new Error(`Couldn't ${what}: ${lastLines(r)}`);
  return r.stdout;
}

/** The engine as a login service (launchd on macOS, systemd --user on Linux), then a gateway restart to load the plugin. */
async function installServices(deps: SetupDeps): Promise<void> {
  const { io } = deps;
  const [node, cli] = deps.frenCommand as [string, string];
  const pathEnv = [dirname(node), dirname(await whichOr(deps, deps.openclawBin)), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":");
  let engine = false;
  if (deps.platform === "darwin") {
    const plist = join(deps.home, "Library/LaunchAgents/sh.fren.engine.plist");
    deps.writeFile(plist, launchdPlist(node, cli, pathEnv, deps.paths.home));
    await deps.run("launchctl", ["unload", plist]);
    engine = (await deps.run("launchctl", ["load", "-w", plist])).code === 0;
  } else if (deps.platform === "linux" && (await deps.run("systemctl", ["--user", "show-environment"])).code === 0) {
    deps.writeFile(join(deps.home, ".config/systemd/user/fren.service"), systemdUnit({ node, cli, pathEnv, frenHome: deps.paths.home }));
    await deps.run("systemctl", ["--user", "daemon-reload"]);
    engine = (await deps.run("systemctl", ["--user", "enable", "--now", "fren.service"])).code === 0;
    // Keep running after you log out.
    await deps.run("loginctl", ["enable-linger", deps.user]);
  }
  if (engine) io.say("✓ Fren engine runs in the background and starts at login");
  else io.say(`! Couldn't install a background service here. Keep this running in its own terminal:\n    ${node} ${cli} start`);

  const gw = await deps.run(deps.openclawBin, ["daemon", "restart"]);
  if (gw.code !== 0) {
    const installed = await deps.run(deps.openclawBin, ["daemon", "install"]);
    if (installed.code !== 0) io.say(`! Start the OpenClaw gateway yourself: ${deps.openclawBin} gateway run`);
  }
  io.say("✓ OpenClaw gateway restarted with Fren loaded");
}

async function whichOr(deps: SetupDeps, bin: string): Promise<string> {
  if (bin.includes("/")) return resolve(bin);
  const r = await deps.run("sh", ["-c", `command -v ${bin}`]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "/usr/local/bin/openclaw";
}

export function systemdUnit(o: { node: string; cli: string; pathEnv: string; frenHome: string; user?: string }): string {
  return `[Unit]
Description=Fren engine (policy, signer, watcher)
After=network-online.target
Wants=network-online.target

[Service]
${o.user ? `User=${o.user}\n` : ""}Environment=FREN_HOME=${o.frenHome}
Environment=PATH=${o.pathEnv}
ExecStart=${o.node} ${o.cli} start
Restart=always
RestartSec=5

[Install]
WantedBy=${o.user ? "multi-user.target" : "default.target"}
`;
}

export function launchdPlist(node: string, cli: string, pathEnv: string, frenHome: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>sh.fren.engine</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${cli}</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>FREN_HOME</key><string>${frenHome}</string><key>PATH</key><string>${pathEnv}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${frenHome}/engine.log</string>
  <key>StandardErrorPath</key><string>${frenHome}/engine.log</string>
</dict>
</plist>
`;
}

async function choose<T extends string>(io: Prompt, question: string, options: [T, string][]): Promise<T> {
  io.say(`\n${question}`);
  options.forEach(([, label], i) => io.say(`  ${i + 1}) ${label}`));
  for (;;) {
    const a = (await io.ask("Pick one", "1")).trim();
    const picked = options[Number(a) - 1] ?? options.find(([v]) => v === a.toLowerCase());
    if (picked) return picked[0];
    io.say(`Type a number from 1 to ${options.length}.`);
  }
}

async function yes(io: Prompt, question: string, fallback: boolean): Promise<boolean> {
  const a = (await io.ask(`${question} [${fallback ? "Y/n" : "y/N"}]`, fallback ? "y" : "n")).trim().toLowerCase();
  return a.startsWith("y");
}

/** The real terminal, programs and network. */
export function systemSetupDeps(paths: FrenPaths): SetupDeps {
  // One readline at a time: it's closed while an interactive program (OpenClaw's
  // own prompts, the WhatsApp QR) has the terminal, so the two don't fight over it.
  let rl: ReturnType<typeof createInterface> | undefined;
  const terminal = () => (rl ??= createInterface({ input: process.stdin, output: process.stdout }));
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    paths,
    io: {
      ask: async (q, fallback) => {
        const a = await terminal().question(fallback ? `${q} (${fallback}): ` : `${q}: `);
        return a.trim() === "" && fallback !== undefined ? fallback : a;
      },
      say: (t) => console.log(t),
      close: () => {
        rl?.close();
        rl = undefined;
      },
    },
    run: (file, args, opts) =>
      new Promise((done) => {
        if (opts?.interactive) {
          rl?.close();
          rl = undefined;
        }
        const child = spawn(file, args, { stdio: opts?.interactive ? "inherit" : ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", (err) => done({ code: 127, stdout, stderr: err.message }));
        child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
      }),
    fetchFn: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    openclawBin: process.env.OPENCLAW_BIN ?? "openclaw",
    pluginDir: resolve(here, "../../openclaw-plugin"),
    frenCommand: [process.execPath, resolve(here, "cli.js")],
    platform: platform(),
    home: homedir(),
    user: userInfo().username,
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    exists: existsSync,
  };
}
