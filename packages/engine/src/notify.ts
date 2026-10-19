import type { Fetch } from "./http.js";
import type { Store } from "./store.js";

/**
 * Messages to the owner that must not pass through the agent: confirmation
 * codes (so an injected prompt can't read and replay them) and watcher alerts
 * (which happen when no conversation is open).
 */
export interface Notifier {
  /** True when the owner has a private line (Telegram) that bypasses the agent. */
  readonly hasPrivateLine: boolean;
  /** Send to the owner. Returns false when there's no private line. */
  sendPrivate(text: string): Promise<boolean>;
  /** Watcher alerts. Logged as events for the plugin to relay, and sent privately when possible. */
  alert(text: string): Promise<void>;
}

export class TelegramNotifier implements Notifier {
  readonly hasPrivateLine: boolean;

  constructor(
    private readonly store: Store,
    private readonly fetchFn: Fetch,
    private readonly telegram?: { botToken: string; ownerChatId: string },
  ) {
    this.hasPrivateLine = Boolean(telegram);
  }

  async sendPrivate(text: string): Promise<boolean> {
    if (!this.telegram) return false;
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.telegram.ownerChatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  }

  async alert(text: string): Promise<void> {
    this.store.addEvent(text);
    await this.sendPrivate(text).catch(() => false);
  }
}

/** For tests and for setups without Telegram. */
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
