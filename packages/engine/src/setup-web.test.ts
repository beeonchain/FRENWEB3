import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { frenPaths } from "./config.js";
import type { Runner, SetupDeps } from "./setup.js";
import { createSetupServer, latestQr } from "./setup-web.js";

const TOKEN = "123456789:AAtesttokentesttokentesttokentest";
const SETUP_TOKEN = "s3cr3t-setup-token-0123456789abcdef";

function fakeTelegram() {
  const sent: string[] = [];
  let served = false;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const [, token, method] = String(url).match(/bot([^/]+)\/(\w+)$/)!;
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (token !== TOKEN) return json({ ok: false, error_code: 401 });
    if (method === "getMe") return json({ ok: true, result: { username: "my_fren_bot" } });
    if (method === "getUpdates") {
      const result = served
        ? []
        : [{ update_id: 9, message: { chat: { type: "private" }, from: { id: 777000123, is_bot: false, first_name: "Bee" } } }];
      served = true;
      return json({ ok: true, result });
    }
    sent.push(String(init?.body));
    return json({ ok: true, result: {} });
  }) as typeof fetch;
  return { fetchFn, sent };
}

let server: ReturnType<typeof createSetupServer> | undefined;
afterEach(() => server?.close());

async function start() {
  const home = mkdtempSync(join(tmpdir(), "fren-web-"));
  const runs: string[] = [];
  const run: Runner = async (file, args) => {
    runs.push(`${file} ${args.join(" ")}`);
    if (args[0] === "models") return { code: 0, stdout: JSON.stringify({ defaultModel: "x/y", auth: { missingProvidersInUse: ["x"] } }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const tg = fakeTelegram();
  const deps: SetupDeps = {
    paths: frenPaths(join(home, ".fren")),
    io: { ask: async () => "", say: () => {}, close: () => {} },
    run,
    fetchFn: tg.fetchFn,
    sleep: async () => {},
    openclawBin: "openclaw",
    pluginDir: "/app/plugin",
    frenCommand: ["node", "cli.js"],
    platform: "linux",
    home,
    user: "fren",
    writeFile: () => {},
    exists: existsSync,
  };
  const doneFile = join(home, "setup-done");
  server = createSetupServer(deps, { token: SETUP_TOKEN, doneFile });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = `fren_setup=${SETUP_TOKEN}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { base, call, runs, deps, doneFile, tg };
}

describe("web setup", () => {
  it("refuses anyone without the setup token", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/setup`)).status).toBe(403);
    expect((await fetch(`${base}/setup?t=wrong-token-wrong-token-wrong-tok`)).status).toBe(403);
    expect((await fetch(`${base}/api/state`, { headers: { cookie: "fren_setup=nope" } })).status).toBe(403);
  });

  it("swaps the token in the link for a cookie and serves the page", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/setup?t=${SETUP_TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
    const page = await fetch(`${base}/setup`, { headers: { cookie: `fren_setup=${SETUP_TOKEN}` } });
    expect(await page.text()).toContain("Set up your Fren");
  });

  it("refuses posts from other sites", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/done`, {
      method: "POST",
      headers: { cookie: `fren_setup=${SETUP_TOKEN}`, "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("goes from model key to Telegram to wallets, backup and done", async () => {
    const { call, runs, deps, doneFile, tg } = await start();
    expect((await call("GET", "/api/state")).json.modelReady).toBe(false);

    expect((await call("POST", "/api/model", { provider: "anthropic", apiKey: "sk-ant-0123456789" })).status).toBe(200);
    expect(runs.some((r) => r.includes("onboard --non-interactive") && r.includes("--auth-choice apiKey --anthropic-api-key sk-ant-0123456789"))).toBe(true);

    expect((await call("POST", "/api/telegram/token", { token: "bad" })).json.error).toMatch(/didn't work/);
    expect((await call("POST", "/api/telegram/token", { token: TOKEN })).json.bot).toBe("my_fren_bot");
    const found = await call("POST", "/api/telegram/find");
    expect(found.json.candidates).toEqual([{ id: "777000123", name: "Bee" }]);
    expect((await call("POST", "/api/finish", { network: "mainnet" })).status).toBe(400);
    expect((await call("POST", "/api/telegram/confirm", { id: "777000123" })).status).toBe(200);
    expect(runs).toContain(`openclaw config set commands.ownerAllowFrom ["telegram:777000123"]`);
    expect(tg.sent.some((b) => b.includes("Fren found you"))).toBe(true);

    expect((await call("POST", "/api/done")).status).toBe(400);
    const fin = await call("POST", "/api/finish", { network: "mainnet" });
    expect((fin.json.addresses as { solana: string }).solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(JSON.parse(readFileSync(deps.paths.config, "utf8")).telegram.ownerChatId).toBe("777000123");

    const backup = await call("GET", "/api/backup");
    expect(backup.json.passphrase).toBe(readFileSync(deps.paths.passphrase, "utf8").trim());
    expect(backup.json.keystore).toEqual(JSON.parse(readFileSync(deps.paths.keystore, "utf8")));

    expect((await call("POST", "/api/done")).status).toBe(200);
    expect(existsSync(doneFile)).toBe(true);
    expect((await call("GET", "/api/state")).json.done).toBe(true);
  });

  it("checks the WhatsApp number before starting", async () => {
    const { call } = await start();
    expect((await call("POST", "/api/whatsapp/start", { number: "07700 900123" })).json.error).toMatch(/country code/);
  });
});

describe("latestQr", () => {
  const block = (c: string) => Array.from({ length: 14 }, () => `\x1b[47m\x1b[30m ${c.repeat(30)} \x1b[0m`).join("\n");
  it("returns the newest QR without colour codes", () => {
    const out = `Waiting...\nscan this QR:\n${block("█▄")}\n\nnew QR:\n${block("▀█")}\n`;
    const qr = latestQr(out)!;
    expect(qr.split("\n")).toHaveLength(14);
    expect(qr).toContain("▀█▀█");
    expect(qr).not.toContain("\x1b");
  });
  it("ignores output without a QR", () => {
    expect(latestQr("Waiting for WhatsApp connection...\n█ one line\n")).toBeNull();
  });
});
