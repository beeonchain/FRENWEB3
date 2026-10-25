import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { frenPaths } from "./config.js";
import { findTelegramOwner, runSetup, systemdUnit, type Prompt, type Runner, type SetupDeps } from "./setup.js";

const TOKEN = "123456789:AAtesttokentesttokentesttokentest";

function scriptedIo(answers: string[]): Prompt & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    ask: async (q, fallback) => {
      out.push(`? ${q}`);
      const a = answers.shift();
      if (a === undefined) throw new Error(`No answer scripted for "${q}"`);
      return a === "" && fallback !== undefined ? fallback : a;
    },
    say: (t) => out.push(t),
    close: () => {},
  };
}

/** Telegram Bot API fake: getMe works for TOKEN; getUpdates returns `updates` once. */
function fakeTelegram(updates: unknown[], getUpdatesError?: number) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let served = false;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const [, token, method] = String(url).match(/bot([^/]+)\/(\w+)$/)!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method: method!, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (token !== TOKEN) return json({ ok: false, error_code: 401 });
    if (method === "getMe") return json({ ok: true, result: { username: "my_fren_bot" } });
    if (method === "getUpdates") {
      if (getUpdatesError) return json({ ok: false, error_code: getUpdatesError });
      const result = served ? [] : updates;
      served = true;
      return json({ ok: true, result });
    }
    return json({ ok: true, result: {} });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function fakeRunner(modelsReady: boolean) {
  const runs: string[] = [];
  const run: Runner = async (file, args, opts) => {
    runs.push(`${opts?.interactive ? "[tty] " : ""}${file} ${args.join(" ")}`);
    if (args[0] === "--version") return { code: 0, stdout: "OpenClaw 2026.10.5 (1b58cb9)", stderr: "" };
    if (args[0] === "models") {
      return { code: 0, stdout: JSON.stringify({ defaultModel: "anthropic/claude", auth: { missingProvidersInUse: modelsReady ? [] : ["anthropic"] } }), stderr: "" };
    }
    if (file === "systemctl" || file === "launchctl" || file === "loginctl") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, runs };
}

function deps(over: Partial<SetupDeps> & Pick<SetupDeps, "io" | "run" | "fetchFn">): SetupDeps {
  const home = mkdtempSync(join(tmpdir(), "fren-setup-"));
  const files: Record<string, string> = {};
  return {
    paths: frenPaths(join(home, ".fren")),
    sleep: async () => {},
    openclawBin: "openclaw",
    pluginDir: "/app/packages/openclaw-plugin",
    frenCommand: ["/usr/bin/node", "/app/packages/engine/dist/cli.js"],
    platform: "linux",
    home,
    user: "fren",
    writeFile: (p, t) => (files[p] = t),
    exists: () => false,
    ...over,
  };
}

const startMessage = {
  update_id: 41,
  message: { chat: { type: "private" }, from: { id: 777000123, is_bot: false, first_name: "Bee", username: "beeonchain" } },
};

describe("fren setup", () => {
  it("links Telegram with the owner as the only sender, creates wallets and installs the plugin", async () => {
    const tg = fakeTelegram([startMessage]);
    const { run, runs } = fakeRunner(false);
    // channel 1 (telegram), token, "is that you" yes, network 1 (mainnet), no Jupiter key
    const io = scriptedIo(["1", TOKEN, "y", "1", ""]);
    const d = deps({ io, run, fetchFn: tg.fetchFn });

    const res = await runSetup(d, { server: true });

    expect(res.channel).toBe("telegram");
    expect(res.network).toBe("mainnet");
    expect(res.addresses.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(runs).toContain("[tty] openclaw onboard --flow quickstart --skip-channels --skip-ui --skip-search --skip-daemon");
    expect(runs).toContain(`openclaw config set channels.telegram.allowFrom ["777000123"]`);
    expect(runs).toContain("openclaw config set channels.telegram.dmPolicy allowlist");
    expect(runs).toContain(`openclaw config set commands.ownerAllowFrom ["telegram:777000123"]`);
    expect(runs).toContain(`openclaw channels add --channel telegram --token ${TOKEN}`);
    expect(runs).toContain("openclaw plugins install --link --accept-capabilities --force /app/packages/openclaw-plugin");
    // Server mode: the VPS installer owns the services.
    expect(runs.some((r) => r.startsWith("systemctl") || r.startsWith("openclaw daemon"))).toBe(false);

    const cfg = JSON.parse(readFileSync(d.paths.config, "utf8"));
    expect(cfg.network).toBe("mainnet");
    expect(cfg.telegram).toEqual({ botToken: TOKEN, ownerChatId: "777000123" });
    // The old /start is acknowledged so the agent doesn't answer it later.
    expect(tg.calls.filter((c) => c.method === "getUpdates").at(-1)?.body.offset).toBe(42);
  });

  it("skips OpenClaw's model login when a model is already set up", async () => {
    const tg = fakeTelegram([startMessage]);
    const { run, runs } = fakeRunner(true);
    const io = scriptedIo(["n", "1", TOKEN, "y", "2", ""]);
    const res = await runSetup(deps({ io, run, fetchFn: tg.fetchFn }), { server: true });
    expect(res.network).toBe("testnet");
    expect(runs.some((r) => r.includes("onboard"))).toBe(false);
  });

  it("asks for the token again when it's wrong", async () => {
    const tg = fakeTelegram([startMessage]);
    const { run } = fakeRunner(true);
    const io = scriptedIo(["n", "1", "nope", TOKEN, "y", "1", ""]);
    await runSetup(deps({ io, run, fetchFn: tg.fetchFn }), { server: true });
    expect(io.out).toContain("That token didn't work. Copy it again from BotFather, the whole thing.");
  });

  it("links WhatsApp with the QR login and sends codes to the owner's own number", async () => {
    const tg = fakeTelegram([]);
    const { run, runs } = fakeRunner(true);
    const io = scriptedIo(["n", "2", "+44 7700 900123", "1", ""]);
    const d = deps({ io, run, fetchFn: tg.fetchFn });
    const res = await runSetup(d, { server: true });
    expect(res.channel).toBe("whatsapp");
    expect(runs).toContain("[tty] openclaw channels add --channel whatsapp");
    expect(runs).toContain(`openclaw config set channels.whatsapp.allowFrom ["+447700900123"]`);
    expect(runs).toContain(`openclaw config set commands.ownerAllowFrom ["whatsapp:+447700900123"]`);
    // Not linked during "channels add", so it asks for the QR again.
    expect(runs).toContain("[tty] openclaw channels login --channel whatsapp");
    expect(JSON.parse(readFileSync(d.paths.config, "utf8")).notify).toEqual([{ channel: "whatsapp", to: "+447700900123" }]);
  });

  it("installs services locally and keeps the same wallets on a second run", async () => {
    const tg = fakeTelegram([startMessage]);
    const { run, runs } = fakeRunner(true);
    const d = deps({ io: scriptedIo(["n", "1", TOKEN, "y", "1", ""]), run, fetchFn: tg.fetchFn });
    const first = await runSetup(d, { server: false });
    expect(runs).toContain("openclaw daemon restart");
    const again = await runSetup({ ...d, io: scriptedIo(["n", "1", TOKEN, "y", "1", ""]), fetchFn: fakeTelegram([startMessage]).fetchFn }, { server: false });
    expect(again.addresses).toEqual(first.addresses);
  });

  it("fails clearly when OpenClaw is missing", async () => {
    const run: Runner = async () => ({ code: 127, stdout: "", stderr: "not found" });
    await expect(runSetup(deps({ io: scriptedIo([]), run, fetchFn: fakeTelegram([]).fetchFn }), { server: false })).rejects.toThrow(/OpenClaw isn't installed/);
  });
});

describe("findTelegramOwner", () => {
  it("falls back to asking when OpenClaw already reads the bot", async () => {
    const io = scriptedIo(["abc", "777000123"]);
    const owner = await findTelegramOwner({ io, fetchFn: fakeTelegram([], 409).fetchFn, sleep: async () => {} }, TOKEN, "my_fren_bot");
    expect(owner.id).toBe("777000123");
    expect(io.out).toContain("OpenClaw is already reading this bot, so I can't spot your message.");
  });

  it("ignores bots and group messages", async () => {
    const group = { update_id: 1, message: { chat: { type: "group" }, from: { id: 5, is_bot: false, first_name: "X" } } };
    const bot = { update_id: 2, message: { chat: { type: "private" }, from: { id: 6, is_bot: true, first_name: "B" } } };
    const io = scriptedIo(["y"]);
    const owner = await findTelegramOwner({ io, fetchFn: fakeTelegram([group, bot, startMessage]).fetchFn, sleep: async () => {} }, TOKEN, "b");
    expect(owner).toEqual({ id: "777000123", name: "Bee (@beeonchain)" });
  });
});

describe("systemdUnit", () => {
  it("runs as the given user on a server", () => {
    const u = systemdUnit({ node: "/usr/bin/node", cli: "/opt/fren/cli.js", pathEnv: "/usr/bin", frenHome: "/home/fren/.fren", user: "fren" });
    expect(u).toContain("User=fren");
    expect(u).toContain("ExecStart=/usr/bin/node /opt/fren/cli.js start");
    expect(u).toContain("WantedBy=multi-user.target");
  });
});
