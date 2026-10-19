import { checkEvmTransaction, createSigner, generateKeys, type EvmTxRequest, type SignerApi } from "@fren/signer";
import { recoverMessageAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { buildTestFren, optionName } from "./testing.js";

const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const DAY = 86_400_000;

const codeFrom = (sent: string[]) => /\/ok ([A-Z0-9]{6})/.exec(sent.at(-1) ?? "")?.[1] ?? "";

function recordingSigner() {
  const real = createSigner(generateKeys());
  const sent: EvmTxRequest[] = [];
  const signer: SignerApi = {
    ...real,
    async evmSendTransaction(req) {
      checkEvmTransaction(req);
      sent.push(req);
      return { txHash: `0x${String(sent.length).padStart(64, "0")}` };
    },
  };
  return { signer, sent };
}

/** "ETH hits $4,000 by <60 days out>": options either side of the date, and Polymarket markets around it. */
function betWorld(opts: Parameters<typeof buildTestFren>[0] = {}) {
  const t = buildTestFren(opts);
  t.store.setLimits({ ...t.store.getLimits(), maxTradeUsd: 2_000, maxDailyUsd: 5_000 });
  const by = new Date(Date.now() + 60 * DAY);
  const call = optionName("ETH", 55, 4000);
  t.fake.addOption(call, { ask: 120, bid: 110, spot: 3_500 });
  t.fake.addOption(optionName("ETH", 55, 3800), { ask: 200, bid: 190, spot: 3_500 });
  t.fake.addOption(optionName("ETH", 90, 4000), { ask: 260, bid: 250, spot: 3_500 });
  t.fake.addOption(optionName("ETH", 55, 4000, "P"), { ask: 600, bid: 590, spot: 3_500 });
  const end = by.toISOString();
  t.poly.addMarket({ slug: "eth-4k", question: "Will Ethereum reach $4,000 by December 31?", endDate: end, yesAsk: 0.3 });
  t.poly.addMarket({ slug: "eth-14k", question: "Will Ethereum reach $14,000 by December 31?", endDate: end, yesAsk: 0.01 });
  t.poly.addMarket({ slug: "btc-4k", question: "Will Bitcoin dip to $4,000 by December 31?", endDate: end, yesAsk: 0.01 });
  return { ...t, by, call };
}

const query = (by: Date, budgetUsd = 1_000) => ({ asset: "ETH", target: 4_000, direction: "above" as const, by: by.toISOString(), budgetUsd });

describe("ETH hits $4,000 by a date: option vs Polymarket", () => {
  it("quotes the nearest call before the date and the matching Polymarket market side by side", async () => {
    const t = betWorld();
    const q = await t.fren.quoteBet(query(t.by), "eth 4k by december, $1000");
    expect(q.text).toMatch(/^ETH above \$4,000 by .*, with \$1,000\. ETH is \$3,500 now\./);
    expect(q.text).toMatch(/1\) Option on Derive: 8\.33 contracts of the ETH \$4,000 call expiring .* at \$120 each \(\$1,000 of your \$1,000\)/);
    expect(q.text).toMatch(/Break-even \$4,120/);
    expect(q.text).toMatch(/At \$4,400 you'd get \$3,332; at \$5,000, \$8,330/);
    expect(q.text).toMatch(/2\) Polymarket: "Will Ethereum reach \$4,000 by December 31\?" Yes at 30¢ a share/);
    expect(q.text).toMatch(/trades at \$4,000 for a moment/);
    expect(q.text).not.toMatch(/14,000|Bitcoin/);
    expect(q.plans.derive!.steps[0]!.leg).toMatchObject({ kind: "option", instrument: t.call, side: "buy", amount: { type: "usd", usd: 1_000 } });
    expect(q.plans.polymarket!.steps[0]!.leg).toMatchObject({ kind: "prediction", market: "eth-4k", outcome: "Yes", limitPrice: 0.33 });
  });

  it("says plainly when one side has nothing", async () => {
    const t = betWorld();
    const q = await t.fren.quoteBet({ ...query(t.by), asset: "SOL", target: 500 });
    expect(q.text).toMatch(/1\) Option on Derive: nothing listed for SOL/);
    expect(q.text).toMatch(/2\) Polymarket: no open market on SOL reaching \$500/);
    expect(q.plans).toEqual({});
  });

  it("paper: buys the option, sells half, and settles the rest at expiry", async () => {
    const t = betWorld();
    const q = await t.fren.quoteBet(query(t.by, 600));
    const res = await t.fren.submit(q.plans.derive!);
    expect(res.verdict).toBe("needs_code");
    expect(res.text).toMatch(/Buy \$600 of the ETH \$4,000 call expiring .* on Derive/);
    expect(res.text).toMatch(/break-even \$4,120/);
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/📝 Paper: Bought 4\.95 contracts of the ETH \$4,000 call expiring .* for \$600 \(\$120 each plus fees\)/);
    expect(await t.fren.status()).toMatch(/4\.95 contracts of the ETH \$4,000 call expiring .* worth \$569/);

    const sell = await t.fren.submit({ request: "sell half", steps: [{ leg: { kind: "option", venue: "derive", side: "sell", instrument: t.call, amount: { type: "fraction", fraction: 0.5 } } }] });
    expect(sell.text).toMatch(/Paper: Sold 2\.47 contracts of the ETH \$4,000 call .* for \$\d+/);

    const before = t.store.paperUsdc();
    t.fake.settleOption(t.call, 4_500);
    const expiry = Date.now() + 55 * DAY;
    const lines = await t.derive.settlePaper(new Date(expiry + DAY));
    expect(lines[0]).toMatch(/🏁 Paper: ETH \$4,000 call .* settled at \$4,500\. Paid \$1,240 on 2\.48 contracts/);
    expect(t.store.paperUsdc() - before).toBeCloseTo(1_240, 6);
    expect(await t.fren.status()).not.toMatch(/call expiring/);
  });

  it("paper: bets on Polymarket and gets paid $1 a share when it resolves Yes", async () => {
    const t = betWorld();
    const q = await t.fren.quoteBet(query(t.by, 300));
    const res = await t.fren.submit(q.plans.polymarket!);
    expect(res.text).toMatch(/Bet \$300 on "Yes" for "Will Ethereum reach \$4,000 by December 31\?" on Polymarket at up to 33¢ a share/);
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(await t.fren.status()).toMatch(/1000 shares of Yes · Will Ethereum reach \$4,000 by December 31\? worth \$290/);
    expect(out).toMatch(/📝 Paper: Bought 1,000 "Yes" shares in "Will Ethereum reach \$4,000 by December 31\?" for \$300 at 30¢ each/);
    const before = t.store.paperUsdc();
    t.poly.resolve("eth-4k", "Yes");
    await t.fren.tick();
    expect(t.notifier.sent.at(-1)).toMatch(/🏁 Paper: "Will Ethereum reach \$4,000 by December 31\?" resolved "Yes"\. Your 1,000 shares paid \$1,000/);
    expect(t.store.paperUsdc() - before).toBeCloseTo(1_000, 6);
    expect(await t.fren.status()).not.toMatch(/shares of/);
  });

  it("refuses an option name Derive doesn't list and a Polymarket outcome that doesn't exist", async () => {
    const t = betWorld();
    const bad = await t.fren.submit({ request: "x", steps: [{ leg: { kind: "option", venue: "derive", side: "buy", instrument: optionName("ETH", 55, 4100), amount: { type: "usd", usd: 50 } } }] });
    expect(bad.verdict).toBe("rejected");
    expect(bad.text).toMatch(/Derive has no live option/);
    const out = await t.fren.submit({ request: "x", steps: [{ leg: { kind: "prediction", venue: "polymarket", side: "buy", market: "eth-4k", outcome: "Maybe", amount: { type: "usd", usd: 50 } } }] });
    expect(out.text).toMatch(/has outcomes "Yes" and "No", not "Maybe"/);
  });
});

describe("live options on Derive", () => {
  it("needs a funded Derive account, then sends an order signed by Fren's option-only session key", async () => {
    const { signer } = recordingSigner();
    const t = betWorld({ signer, live: true });
    const plan = (await t.fren.quoteBet(query(t.by, 600))).plans.derive!;

    await t.fren.submit(plan);
    expect(await t.fren.approve(codeFrom(t.notifier.sent))).toMatch(/❌ .*Couldn't set up Fren's Derive trading key.*fund Derive with \$X/);

    t.fake.deriveSubaccounts = [1234];
    await t.fren.submit(plan);
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/✅ Bought 4\.76 contracts of the ETH \$4,000 call expiring .* for \$573 at \$120 each on Derive/);

    const addrs = await signer.addresses();
    const reg = t.fake.deriveCalls.find((c) => c.method === "private/set_session_key")!;
    expect(reg.body).toMatchObject({ public_session_key: addrs.deriveSession, protocol_scopes: ["trade:orderbook:option"] });
    const order = t.fake.deriveCalls.find((c) => c.method === "private/order")!;
    expect(order.body).toMatchObject({ subaccount_id: 1234, instrument_name: t.call, direction: "buy", limit_price: "126", amount: "4.76", order_type: "limit", time_in_force: "ioc", signer: addrs.deriveSession });
    expect(order.headers["X-DeriveWallet"]).toBe(addrs.evm);
    expect(await recoverMessageAddress({ message: order.headers["X-DeriveTimestamp"]!, signature: order.headers["X-DeriveSignature"] as Hex })).toBe(addrs.deriveSession);
  });

  it("says so when nothing fills, and only sells options it holds", async () => {
    const { signer } = recordingSigner();
    const t = betWorld({ signer, live: true });
    t.fake.deriveSubaccounts = [1234];
    t.fake.deriveFillRatio = 0;
    await t.fren.submit((await t.fren.quoteBet(query(t.by, 600))).plans.derive!);
    expect(await t.fren.approve(codeFrom(t.notifier.sent))).toMatch(/Nothing filled at up to \$126 per contract, so nothing changed/);

    const sell = await t.fren.submit({ request: "sell", steps: [{ leg: { kind: "option", venue: "derive", side: "sell", instrument: t.call, amount: { type: "fraction", fraction: 1 } } }] });
    expect(sell.text).toMatch(/You hold no ETH \$4,000 call .* on Derive/);
  });
});

describe("live bets on Polymarket", () => {
  const bet = (t: ReturnType<typeof betWorld>) => t.fren.submit({ request: "bet", steps: [{ leg: { kind: "prediction", venue: "polymarket", side: "buy", market: "eth-4k", amount: { type: "usd", usd: 50 }, limitPrice: 0.33 } }] });

  it("places the bet at the limit price", async () => {
    const { signer } = recordingSigner();
    const t = betWorld({ signer, live: true });
    const res = await bet(t);
    expect(res.text).toMatch(/✅ Bought 167 "Yes" shares .* for \$50\.00 at 30¢ each · https:\/\/polygonscan\.com\/tx\/0xpolytx/);
    expect(t.polyTrader.orders).toEqual([{ side: "buy", assetId: "eth-4k-yes", usd: 50, limit: 0.33 }]);
  });

  it("won't bet from a blocked region, when the region check is down, or in close-only mode", async () => {
    const { signer } = recordingSigner();
    const blocked = betWorld({ signer, live: true, geoblocked: async () => true });
    expect((await bet(blocked)).text).toMatch(/doesn't allow new bets from this machine's location/);
    const down = betWorld({ signer, live: true, geoblocked: async () => Promise.reject(new Error("503")) });
    expect((await bet(down)).text).toMatch(/Couldn't reach Polymarket's region check/);
    const closeOnly = betWorld({ signer, live: true });
    closeOnly.polyTrader.closedOnlyMode = true;
    expect((await bet(closeOnly)).text).toMatch(/only lets this account close positions/);
    for (const t of [blocked, down, closeOnly]) expect(t.polyTrader.orders).toEqual([]);
  });
});

describe("funding Derive and Polymarket", () => {
  it("does nothing in paper mode", async () => {
    const t = betWorld({ signer: recordingSigner().signer });
    expect((await t.fren.requestFunding("derive", 500)).text).toMatch(/Paper mode trades Derive from your paper balance/);
  });

  it("bridges Arbitrum USDC to Polymarket's deposit wallet, only after the owner's code", async () => {
    const { signer, sent } = recordingSigner();
    const t = betWorld({ signer, live: true, evmBalances: { [`arbitrum:${ARB_USDC}`]: 1_000_000_000n } });
    await t.fren.requestFunding("polymarket", 500);
    expect(t.notifier.sent.at(-1)).toMatch(/Send \$500 USDC from Arbitrum to your Polymarket account at 0x9011000000000000000000000000000000000001\?/);
    expect(sent).toHaveLength(0);
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/✅ Sent \$500 USDC from Arbitrum to your Polymarket wallet[\s\S]*pUSD in your Polymarket wallet 0x9011/);
    expect(t.fake.relayQuotes.at(-1)).toMatchObject({ originChainId: 42161, destinationChainId: 137, destinationCurrency: PUSD, recipient: "0x9011000000000000000000000000000000000001", amount: "500000000" });
    expect(sent).toHaveLength(2);
  });

  it("opens a Derive account by bridging to its deposit address on Ethereum", async () => {
    const { signer } = recordingSigner();
    const t = betWorld({ signer, live: true, evmBalances: { [`arbitrum:${ARB_USDC}`]: 1_000_000_000n } });
    await t.fren.requestFunding("derive", 200);
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/✅ Sent \$200 USDC from Arbitrum to your Derive account[\s\S]*first deposit opens the account/);
    expect(t.fake.relayQuotes.at(-1)).toMatchObject({ destinationChainId: 1, destinationCurrency: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", recipient: "0xde9051700000000000000000000000000000beef" });
    expect(t.fake.deriveCalls.find((c) => c.method === "public/register_deposit_address")!.body).toMatchObject({ manager_id: 7 });
  });

  it("sends nothing if the deposit address changed after the owner approved it", async () => {
    const { signer, sent } = recordingSigner();
    const t = betWorld({ signer, live: true, evmBalances: { [`arbitrum:${ARB_USDC}`]: 1_000_000_000n } });
    await t.fren.requestFunding("polymarket", 100);
    t.polyTrader.wallet = async () => "0x6666666666666666666666666666666666666666";
    expect(await t.fren.approve(codeFrom(t.notifier.sent))).toMatch(/different deposit address .* Nothing was sent/);
    expect(sent).toHaveLength(0);
  });
});
