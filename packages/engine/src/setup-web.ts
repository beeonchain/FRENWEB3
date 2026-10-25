import { spawn, type ChildProcess } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { readKeystoreAddresses } from "@fren/signer";
import {
  ackTelegram,
  configureModelKey,
  configureTelegram,
  configureWhatsAppOwner,
  finishSetup,
  MODEL_PROVIDERS,
  modelReady,
  normalizePhone,
  pollTelegramOwner,
  telegramBot,
  type ModelProvider,
  type SetupDeps,
} from "./setup.js";
import { SETUP_PAGE } from "./setup-page.js";

/**
 * `fren setup --web`: the same setup as the terminal one, as a page in the
 * browser, for a VPS nobody has to SSH into. It listens on localhost behind
 * Caddy (HTTPS) and only answers someone holding the one-time token from the
 * setup link. Keys are made here and stay here; the only copy that leaves is
 * the backup the owner downloads.
 */

export interface WebSetupOptions {
  token: string;
  host?: string;
  port?: number;
  /** Written when the owner finishes, so the installer's watcher can start Fren and close this page. */
  doneFile?: string;
}

type Line = { telegram?: { botToken: string; ownerChatId: string }; notify?: { channel: string; to: string }[] };

interface State {
  line?: Line;
  channel?: "telegram" | "whatsapp";
  telegram?: { token: string; bot: string; offset: number; candidates: { id: string; name: string }[] };
  whatsapp?: { number: string; proc?: ChildProcess; qr?: string; linked: boolean; error?: string };
  finished?: { network: string; addresses: { solana: string; evm: string; hlAgent: string } };
  done: boolean;
}

const COOKIE = "fren_setup";

export function createSetupServer(deps: SetupDeps, opts: WebSetupOptions): Server {
  const state: State = { done: false };
  const expected = Buffer.from(opts.token);

  const authed = (req: IncomingMessage, url: URL): boolean => {
    const given = url.searchParams.get("t") ?? cookie(req, COOKIE) ?? "";
    const b = Buffer.from(given);
    return b.length === expected.length && timingSafeEqual(b, expected);
  };

  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    "GET /api/state": async () => ({
      modelReady: await modelReady(deps),
      providers: Object.entries(MODEL_PROVIDERS).map(([id, p]) => ({ id, label: p.label, keyUrl: p.keyUrl })),
      channel: state.line ? state.channel : null,
      telegramBot: state.telegram?.bot ?? null,
      finished: state.finished ?? null,
      done: state.done,
    }),

    "POST /api/model": async (b) => {
      const provider = String(b.provider ?? "") as ModelProvider;
      const apiKey = String(b.apiKey ?? "").trim();
      if (!(provider in MODEL_PROVIDERS)) throw new UserError("Pick a provider.");
      if (apiKey.length < 10) throw new UserError("Paste the whole API key.");
      await configureModelKey(deps, provider, apiKey);
      return { ok: true };
    },

    "POST /api/telegram/token": async (b) => {
      const token = String(b.token ?? "").trim();
      const bot = /^\d+:[\w-]{20,}$/.test(token) ? await telegramBot(deps.fetchFn, token) : null;
      if (!bot) throw new UserError("That token didn't work. Copy it again from BotFather, the whole thing.");
      state.telegram = { token, bot, offset: 0, candidates: [] };
      return { bot };
    },

    /** Long-polls Telegram for the owner's first message to the bot. */
    "POST /api/telegram/find": async () => {
      const tg = state.telegram;
      if (!tg) throw new UserError("Add the bot token first.");
      const r = await pollTelegramOwner(deps.fetchFn, tg.token, tg.offset, 15);
      tg.offset = r.offset;
      for (const c of r.candidates) if (!tg.candidates.some((x) => x.id === c.id)) tg.candidates.push(c);
      return { candidates: tg.candidates, busy: r.busy };
    },

    "POST /api/telegram/confirm": async (b) => {
      const tg = state.telegram;
      if (!tg) throw new UserError("Add the bot token first.");
      const id = String(b.id ?? "").trim();
      if (!/^\d{1,15}$/.test(id)) throw new UserError("That's the number @userinfobot shows as Id, digits only.");
      await ackTelegram(deps.fetchFn, tg.token, tg.offset);
      state.line = await configureTelegram(deps, tg.token, id);
      state.channel = "telegram";
      return { ok: true };
    },

    /** Adds WhatsApp and starts the QR login; the page polls /api/whatsapp/qr. */
    "POST /api/whatsapp/start": async (b) => {
      const number = normalizePhone(String(b.number ?? ""));
      if (!number) throw new UserError("Start with + and your country code, digits only after that.");
      state.whatsapp?.proc?.kill();
      await mustOk(deps, ["plugins", "install", "@openclaw/whatsapp", "--force"], "install OpenClaw's WhatsApp plugin");
      await mustOk(deps, ["channels", "add", "--channel", "whatsapp", "--account", "default"], "add WhatsApp");
      const wa: NonNullable<State["whatsapp"]> = { number, linked: false };
      state.whatsapp = wa;
      startWhatsAppLogin(deps, wa, async () => {
        state.line = await configureWhatsAppOwner(deps, number);
        state.channel = "whatsapp";
      });
      return { ok: true };
    },

    "GET /api/whatsapp/qr": async () => {
      const wa = state.whatsapp;
      if (!wa) throw new UserError("Enter your number first.");
      return { qr: wa.qr ?? null, linked: wa.linked && !!state.line, error: wa.error ?? null };
    },

    "POST /api/finish": async (b) => {
      if (!state.line) throw new UserError("Connect Telegram or WhatsApp first.");
      const network = b.network === "testnet" ? "testnet" : "mainnet";
      const jupiterApiKey = String(b.jupiterApiKey ?? "").trim();
      const { addresses } = await finishSetup(deps, { network, ...(jupiterApiKey ? { jupiterApiKey } : {}), line: state.line });
      state.finished = { network, addresses };
      return state.finished;
    },

    "POST /api/done": async () => {
      if (!state.finished) throw new UserError("Finish setup first.");
      state.done = true;
      if (opts.doneFile) writeFileSync(opts.doneFile, new Date().toISOString());
      return { ok: true };
    },
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://setup");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    if (!authed(req, url)) return send(res, 403, "text/plain", "This setup link isn't valid. Use the link from the Fren VPS page.");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/setup")) {
      if (url.searchParams.has("t")) {
        // Trade the token in the URL for a cookie, and drop it from the address bar.
        res.setHeader("set-cookie", `${COOKIE}=${opts.token}; Path=/; HttpOnly; Secure; SameSite=Strict`);
        res.setHeader("location", "/setup");
        return send(res, 303, "text/plain", "");
      }
      return send(res, 200, "text/html; charset=utf-8", SETUP_PAGE);
    }

    if (req.method === "GET" && url.pathname === "/api/backup") {
      if (!state.finished) return sendJson(res, 400, { error: "Finish setup first." });
      const backup = {
        what: "Fren wallet backup. Anyone with this file controls these wallets. Keep it offline.",
        createdAt: new Date().toISOString(),
        addresses: readKeystoreAddresses(deps.paths.keystore),
        restore: "Put keystore into ~/.fren/keystore.json and passphrase into ~/.fren/signer.pass, then run fren setup.",
        keystore: JSON.parse(readFileSync(deps.paths.keystore, "utf8")) as unknown,
        passphrase: readFileSync(deps.paths.passphrase, "utf8").trim(),
      };
      res.setHeader("content-disposition", `attachment; filename="fren-wallet-backup.json"`);
      return send(res, 200, "application/json", JSON.stringify(backup, null, 2));
    }

    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return sendJson(res, 404, { error: "Not found." });
    if (req.method === "POST" && !sameOrigin(req)) return sendJson(res, 403, { error: "Cross-site request refused." });
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      sendJson(res, 200, await route(body));
    } catch (err) {
      const msg = err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message}`;
      sendJson(res, err instanceof UserError ? 400 : 500, { error: msg });
    }
  });
}

/** Runs `openclaw channels login` and keeps the latest QR it prints. */
function startWhatsAppLogin(deps: SetupDeps, wa: NonNullable<State["whatsapp"]>, onLinked: () => Promise<void>) {
  const proc = spawn(deps.openclawBin, ["channels", "login", "--channel", "whatsapp"], { stdio: ["ignore", "pipe", "pipe"] });
  wa.proc = proc;
  let buf = "";
  const take = (d: Buffer) => {
    buf = (buf + d.toString()).slice(-200_000);
    const qr = latestQr(buf);
    if (qr) wa.qr = qr;
  };
  proc.stdout?.on("data", take);
  proc.stderr?.on("data", take);
  proc.on("close", async (code) => {
    if (code === 0 || deps.exists(join(deps.home, ".openclaw/credentials/whatsapp/default/creds.json"))) {
      wa.linked = true;
      try {
        await onLinked();
      } catch (err) {
        wa.error = (err as Error).message;
      }
    } else if (!wa.linked) {
      wa.error = "The QR code expired before it was scanned. Press Try again.";
    }
  });
}

/** The last QR block in terminal output, without colour codes. */
export function latestQr(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[█▀▄]/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  let start = end;
  while (start > 0 && /[█▀▄]/.test(lines[start - 1]!)) start--;
  // A QR is at least 21 modules tall: half as many lines with half blocks.
  return end - start >= 10 ? lines.slice(start, end + 1).join("\n") : null;
}

async function mustOk(deps: SetupDeps, args: string[], what: string): Promise<void> {
  const r = await deps.run(deps.openclawBin, args);
  if (r.code !== 0) throw new Error(`Couldn't ${what}: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
}

class UserError extends Error {}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** The page only posts JSON to itself; refuse anything a different site's page could send. */
function sameOrigin(req: IncomingMessage): boolean {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return false;
  const origin = req.headers.origin;
  return !origin || origin === `https://${req.headers.host}` || origin === `http://${req.headers.host}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 64_000) throw new UserError("Request too large.");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new UserError("Bad request.");
  }
}

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  send(res, status, "application/json", JSON.stringify(body));
}

/** For the CLI: serve until the owner presses Done. */
export async function serveSetup(deps: SetupDeps, opts: WebSetupOptions): Promise<void> {
  const server = createSetupServer(deps, opts);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7421;
  await new Promise<void>((r) => server.listen(port, host, r));
  console.log(`Fren web setup on http://${host}:${port}`);
  await new Promise<void>((resolveDone) => {
    const timer = setInterval(() => {
      if (opts.doneFile && safeExists(deps, opts.doneFile)) {
        clearInterval(timer);
        // Let the page get its last answer before closing.
        setTimeout(() => server.close(() => resolveDone()), 1500);
      }
    }, 1000);
  });
}

function safeExists(deps: SetupDeps, p: string): boolean {
  try {
    return deps.exists(p);
  } catch {
    return false;
  }
}
