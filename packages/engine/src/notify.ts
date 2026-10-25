import { execFile } from "node:child_process";
import type { Fetch } from "./http.js";
import type { Store } from "./store.js";

/**
 * Messages to the owner that must not pass through the agent: confirmation
 * codes (so an injected prompt can't read and replay them) and watcher alerts
 * (which happen when no conversation is open).
 */
export interface Notifier {
  /** True when the owner has a direct line (Telegram, WhatsApp, ...) that bypasses the agent. */
  readonly hasPrivateLine: boolean;
  /** Send to the owner. Returns false when there's no line or none of them worked. */
  sendPrivate(text: string): Promise<boolean>;
  /** Watcher alerts. Logged as events for the plugin to relay, and sent to the owner when possible. */
  alert(text: string): Promise<void>;
}

/** One way to reach the owner. */
export interface OwnerLine {
  readonly name: string;
  send(text: string): Promise<boolean>;
}

/**
 * The Telegram Bot API, called directly. Bots don't receive their own
 * messages, so OpenClaw never sees what goes out here: the most private line.
 */
export class TelegramLine implements OwnerLine {
  readonly name = "telegram";

  constructor(
    private readonly fetchFn: Fetch,
    private readonly cfg: { botToken: string; ownerChatId: string },
  ) {}

  async send(text: string): Promise<boolean> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.cfg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.cfg.ownerChatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  }
}

/** Runs a program without a shell. Resolves with its exit code. */
export type Exec = (file: string, args: string[]) => Promise<{ code: number; stderr: string }>;

export const execNoShell: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 1 << 20 }, (err, _stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stderr: String(stderr ?? "") });
    });
  });

export interface GatewayTarget {
  /** An OpenClaw channel: whatsapp, telegram, signal, discord, imessage, ... */
  channel: string;
  /** The owner on that channel, as `openclaw message send --target` takes it: +15551234567 on WhatsApp and Signal. */
  to: string;
  /** The channel account, when the gateway has several. */
  account?: string;
}

/**
 * Any channel OpenClaw is connected to, through the gateway's own sender
 * (`openclaw message send`). The message skips the model, but the gateway
 * records it in that conversation's history, so the agent can read it later.
 */
export class GatewayLine implements OwnerLine {
  readonly name: string;

  constructor(
    private readonly target: GatewayTarget,
    private readonly exec: Exec = execNoShell,
    private readonly bin = "openclaw",
  ) {
    this.name = target.channel;
  }

  async send(text: string): Promise<boolean> {
    // `--message=` keeps a message that starts with "-" from reading as a flag.
    const args = ["message", "send", "--channel", this.target.channel, "--target", this.target.to, `--message=${text}`];
    if (this.target.account) args.push("--account", this.target.account);
    const { code } = await this.exec(this.bin, args);
    return code === 0;
  }
}

/** Reaches the owner on the first line that works, in the order given. */
export class OwnerNotifier implements Notifier {
  readonly hasPrivateLine: boolean;

  constructor(
    private readonly store: Store,
    private readonly lines: OwnerLine[],
  ) {
    this.hasPrivateLine = lines.length > 0;
  }

  async sendPrivate(text: string): Promise<boolean> {
    for (const line of this.lines) {
      if (await line.send(text).catch(() => false)) return true;
    }
    return false;
  }

  async alert(text: string): Promise<void> {
    this.store.addEvent(text);
    await this.sendPrivate(text);
  }
}

/** For tests and for setups without a line to the owner. */
export class MemoryNotifier implements Notifier {
  readonly sent: string[] = [];
  constructor(
    private readonly store: Store,
    readonly hasPrivateLine = true,
  ) {}
  async sendPrivate(text: string) {
    if (!this.hasPrivateLine) return false;
    this.sent.push(text);
    return true;
  }
  async alert(text: string) {
    this.store.addEvent(text);
    await this.sendPrivate(text);
  }
}
