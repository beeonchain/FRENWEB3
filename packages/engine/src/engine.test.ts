import { createSigner, generateKeys } from "@fren/signer";
import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "./api.js";
import type { MemoryNotifier } from "./notify.js";
import { buildTestFren } from "./testing.js";

function setup(opts: { privateLine?: boolean; live?: boolean } = {}) {
  return buildTestFren({ ...opts, signer: opts.live ? createSigner(generateKeys()) : null });
}

const codeFrom = (notifier: MemoryNotifier) => /\/ok ([A-Z0-9]{6})/.exec(notifier.sent.at(-1) ?? "")?.[1] ?? "";

const goldLong = (margin: number, leverage: number, extra: Record<string, unknown> = {}) => ({
  request: `long gold ${leverage}x with $${margin}`,
  steps: [
    {
      leg: { kind: "perp_open", venue: "hyperliquid", market: "xyz:gold", side: "long", sizing: { type: "margin", usd: margin }, leverage, ...extra },
    },
  ],
});

describe("paper trading end to end", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("runs a small trade straight away", async () => {
    const res = await t.fren.submit(goldLong(50, 10));
    expect(res.verdict).toBe("executed");
    expect(res.text).toContain("Paper mode");
    expect(res.text).toMatch(/Longed 0\.125 xyz:GOLD at \$4,000/);
    expect(t.store.paperUsdc()).toBeCloseTo(9_950);
  });

  it("asks for a private code above the auto-approve level, and the code never reaches the model", async () => {
    const res = await t.fren.submit(goldLong(300, 20, { stopLossPct: 50 }));
    expect(res.verdict).toBe("needs_code");
    const code = codeFrom(t.notifier);
    expect(code).toHaveLength(6);
    expect(res.text).not.toContain(code);
    expect(res.ownerCode).toBeUndefined();
    expect(t.store.paperPositions()).toHaveLength(0);

    const out = await t.fren.approve(code);
    expect(out).toMatch(/Longed .* xyz:GOLD/);
    expect(out).toMatch(/stop \$3,900/);
    expect(t.store.paperPositions()[0]).toMatchObject({ symbol: "xyz:GOLD", side: "long", leverage: 20 });
    expect(await t.fren.approve(code)).toMatch(/wrong or expired/);
  });

  it("hands the code back for out-of-band delivery when there is no private line", async () => {
    const t2 = setup({ privateLine: false });
    const res = await t2.fren.submit(goldLong(300, 10));
    expect(res.ownerCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(res.text).not.toContain(res.ownerCode!);
  });

  it("refuses leverage the market doesn't offer and explains why", async () => {
    await t.fren.changeLimits("maxLeverage=100");
    await t.fren.approve(codeFrom(t.notifier));
    const res = await t.fren.submit(goldLong(50, 100));
    expect(res.verdict).toBe("rejected");
    expect(res.text).toMatch(/xyz:GOLD allows at most 20x/);
  });

  it("suggests close matches for an unknown market", async () => {
    const res = await t.fren.submit({ ...goldLong(50, 5), steps: [{ leg: { ...goldLong(50, 5).steps[0]!.leg, market: "GOLDD" } }] });
    expect(res.verdict).toBe("rejected");
    expect(res.text).toMatch(/No Hyperliquid market called GOLDD/);
  });

  it("watches a funding condition and fires once it holds", async () => {
    const res = await t.fren.submit({
      request: "short SOL $50 when funding goes above 0.02%/h",
      steps: [
        {
          leg: { kind: "perp_open", venue: "hyperliquid", market: "SOL", side: "short", sizing: { type: "margin", usd: 50 }, leverage: 5 },
          when: [{ type: "funding", venue: "hyperliquid", market: "SOL", op: ">", value: 0.02 }],
        },
      ],
    });
    expect(res.text).toMatch(/Watching: Short SOL/);
    await t.fren.tick();
    expect(t.store.paperPositions()).toHaveLength(0);
    expect(await t.fren.status()).toMatch(/⏳ SOL funding > 0.02%\/h \(now 0.0100%\/h\)/);

    t.fake.setFunding("SOL", 0.03);
    await t.fren.tick();
    expect(t.store.paperPositions()[0]).toMatchObject({ symbol: "SOL", side: "short" });
    expect(t.notifier.sent.at(-1)).toMatch(/Triggered[\s\S]*✅ SOL funding[\s\S]*Shorted/);
    await t.fren.tick();
    expect(t.store.paperPositions()[0]!.size).toBeCloseTo(1.25);
  });

  it("closes paper positions when the stop is hit", async () => {
    await t.fren.submit(goldLong(50, 10, { stopLossPct: 20 }));
    t.fake.setMid("xyz:GOLD", 3_900);
    await t.fren.tick();
    expect(t.store.paperPositions()).toHaveLength(0);
    expect(t.notifier.sent.at(-1)).toMatch(/Stop hit, closed long xyz:GOLD at \$3,900, PnL -\$12.50/);
  });

  it("kill switch flattens, pauses, and needs the owner's code to resume", async () => {
    await t.fren.submit(goldLong(50, 10));
    const stopped = await t.fren.stop(true);
    expect(stopped).toMatch(/Stopped/);
    expect(stopped).toMatch(/Closed long xyz:GOLD/);
    expect(t.store.paperPositions()).toHaveLength(0);
    expect((await t.fren.submit(goldLong(10, 2))).verdict).toBe("rejected");

    await t.fren.requestResume();
    expect(await t.fren.approve(codeFrom(t.notifier))).toMatch(/back on/);
    expect((await t.fren.submit(goldLong(10, 2))).verdict).toBe("executed");
  });

  it("tightens limits at once but needs a code to loosen them", async () => {
    expect((await t.fren.changeLimits("maxTradeUsd=50")).text).toMatch(/Limits updated/);
    const loosen = await t.fren.changeLimits("maxTradeUsd=5000");
    expect(loosen.codeSentPrivately).toBe(true);
    expect(t.fren.limits().maxTradeUsd).toBe(50);
    await t.fren.approve(codeFrom(t.notifier));
    expect(t.fren.limits().maxTradeUsd).toBe(5000);
  });

  it("buys a verified token by ticker, refuses an ambiguous unverified ticker, and flags an unverified CA", async () => {
    const buy = (token: string, usd = 20) => ({
      request: `buy ${token}`,
      steps: [{ leg: { kind: "swap", venue: "jupiter", side: "buy", token, amount: { type: "usd", usd } } }],
    });
    const ok = await t.fren.submit(buy("JUP"));
    expect(ok.text).toMatch(/Bought 20 JUP for \$20.00/);

    const ambiguous = await t.fren.submit(buy("SHIT"));
    expect(ambiguous.verdict).toBe("rejected");
    expect(ambiguous.text).toMatch(/2 unverified tokens use the ticker SHIT/);

    const ca = await t.fren.submit(buy("PumpCoin1111111111111111111111111111111pump"));
    expect(ca.verdict).toBe("needs_code");
    expect(ca.text).toMatch(/not on a verified token list/);
  });
});

describe("live Hyperliquid path", () => {
  it("approves the trading key once, sets leverage, and sends a signed IOC order with its stop", async () => {
    const t = setup({ live: true });
    const res = await t.fren.submit(goldLong(50, 10, { stopLossPct: 30 }));
    expect(res.verdict).toBe("executed");
    const types = t.fake.exchange.map((b) => (b.action as { type: string }).type);
    expect(types).toEqual(["approveAgent", "updateLeverage", "order"]);
    const order = t.fake.exchange[2]!;
    expect(order.signature).toMatchObject({ r: expect.stringMatching(/^0x/), s: expect.stringMatching(/^0x/) });
    const action = order.action as { orders: { a: number; b: boolean; r: boolean; t: unknown }[]; grouping: string };
    expect(action.grouping).toBe("normalTpsl");
    expect(action.orders[0]).toMatchObject({ a: 110_000, b: true, r: false, t: { limit: { tif: "Ioc" } } });
    expect(action.orders[1]).toMatchObject({ b: false, r: true, t: { trigger: { tpsl: "sl", triggerPx: "3880" } } });

    await t.fren.submit(goldLong(50, 10));
    expect(t.fake.exchange.filter((b) => (b.action as { type: string }).type === "approveAgent")).toHaveLength(1);
  });

  it("reports an order that didn't fill instead of claiming success", async () => {
    const t = setup({ live: true });
    t.fake.orderStatus = () => ({ error: "Insufficient margin to place order." });
    const res = await t.fren.submit(goldLong(50, 10));
    expect(res.text).toMatch(/❌ .*Insufficient margin/);
  });
});

describe("API", () => {
  it("requires the bearer token and serves plans", async () => {
    const t = setup();
    const server = createApi(t.fren, "secret-token");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const anon = await fetch(`http://127.0.0.1:${port}/status`);
      expect(anon.status).toBe(401);
      const res = await fetch(`http://127.0.0.1:${port}/plans`, {
        method: "POST",
        headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
        body: JSON.stringify({ plan: goldLong(50, 10) }),
      });
      expect(((await res.json()) as { verdict: string }).verdict).toBe("executed");
    } finally {
      server.close();
    }
  });
});
