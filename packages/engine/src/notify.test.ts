import { describe, expect, it } from "vitest";
import { FrenConfig } from "./config.js";
import { ownerLines } from "./daemon.js";
import { GatewayLine, OwnerNotifier, type Exec, type OwnerLine } from "./notify.js";
import { Store } from "./store.js";

function fakeExec(code = 0) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return { code, stderr: code ? "no active WhatsApp listener" : "" };
  };
  return { exec, calls };
}

const line = (name: string, ok: boolean | Error, log: string[]): OwnerLine => ({
  name,
  async send(text) {
    log.push(`${name}: ${text}`);
    if (ok instanceof Error) throw ok;
    return ok;
  },
});

describe("reaching the owner", () => {
  it("sends on WhatsApp through the OpenClaw gateway, without a shell", async () => {
    const { exec, calls } = fakeExec();
    const wa = new GatewayLine({ channel: "whatsapp", to: "+15551234567" }, exec);
    expect(await wa.send("🔐 Buy $600 of SOL\n\nReply /ok ABC123 within 10 min.")).toBe(true);
    expect(calls).toEqual([
      {
        file: "openclaw",
        args: ["message", "send", "--channel", "whatsapp", "--target", "+15551234567", "--message=🔐 Buy $600 of SOL\n\nReply /ok ABC123 within 10 min."],
      },
    ]);
  });

  it("names the account when the gateway has several, and reports a failed send", async () => {
    const { exec, calls } = fakeExec(1);
    const wa = new GatewayLine({ channel: "whatsapp", to: "+15551234567", account: "work" }, exec, "/opt/openclaw/bin/openclaw");
    expect(await wa.send("-5% on SOL")).toBe(false);
    expect(calls[0]!.file).toBe("/opt/openclaw/bin/openclaw");
    expect(calls[0]!.args.slice(-2)).toEqual(["--account", "work"]);
    // A message that starts with "-" stays one value instead of reading as a flag.
    expect(calls[0]!.args).toContain("--message=-5% on SOL");
  });

  it("falls through to the next line when one fails, and logs alerts either way", async () => {
    const store = new Store(":memory:");
    const log: string[] = [];
    const n = new OwnerNotifier(store, [line("telegram", new Error("offline"), log), line("whatsapp", false, log), line("signal", true, log)]);
    expect(n.hasPrivateLine).toBe(true);
    expect(await n.sendPrivate("code")).toBe(true);
    expect(log).toEqual(["telegram: code", "whatsapp: code", "signal: code"]);

    const none = new OwnerNotifier(store, []);
    expect(none.hasPrivateLine).toBe(false);
    expect(await none.sendPrivate("code")).toBe(false);
    await none.alert("⚡ Triggered");
    expect(store.eventsSince(0).map((e) => e.text)).toContain("⚡ Triggered");
  });

  it("puts direct Telegram first, then each notify target in order", () => {
    const config = FrenConfig.parse({
      telegram: { botToken: "123456:abcdefghij", ownerChatId: "42" },
      notify: [
        { channel: "whatsapp", to: "+15551234567" },
        { channel: "signal", to: "+15557654321" },
      ],
    });
    expect(ownerLines(config, fetch).map((l) => l.name)).toEqual(["telegram", "whatsapp", "signal"]);
    expect(ownerLines(FrenConfig.parse({}), fetch)).toEqual([]);
  });
});
