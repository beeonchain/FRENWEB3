import { checkEvmTransaction, createSigner, generateKeys, type EvmTxRequest, type SignerApi } from "@fren/signer";
import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_DOG, buildTestFren, RH_FROG } from "./testing.js";

const NEW_COIN = "NewCoin111111111111111111111111111111111pump";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const codeFrom = (sent: string[]) => /\/ok ([A-Z0-9]{6})/.exec(sent.at(-1) ?? "")?.[1] ?? "";

const swap = (leg: Record<string, unknown>, when: unknown[] = []) => ({
  request: "test",
  steps: [{ leg: { kind: "swap", side: "buy", amount: { type: "usd", usd: 50 }, ...leg }, when }],
});

/** The real signer's rules, with sending stubbed out: what would hit the chain is recorded instead. */
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

describe("tokens on Base and Robinhood Chain", () => {
  it("buys and sells a Base token by contract address in paper mode", async () => {
    const t = buildTestFren();
    const res = await t.fren.submit(swap({ venue: "relay", chain: "base", token: BASE_DOG }));
    // Unverified CA: the owner confirms first.
    expect(res.verdict).toBe("needs_code");
    expect(res.text).toMatch(/Buy \$50.00 of DOG on Base/);
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/Paper: Bought 5,000 DOG on Base for \$50.00/);

    const status = await t.fren.status();
    expect(status).toMatch(/5000 DOG \(Base\) worth \$50.00/);

    const sell = await t.fren.submit({
      request: "sell half my dog",
      steps: [{ leg: { kind: "swap", venue: "relay", chain: "base", side: "sell", token: BASE_DOG, amount: { type: "fraction", fraction: 0.5 } } }],
    });
    expect(sell.text).toMatch(/Paper: Sold 2,500 DOG on Base for \$25.00/);
  });

  it("buys a verified Base token by ticker but refuses an unverified ticker", async () => {
    const t = buildTestFren();
    expect((await t.fren.submit(swap({ venue: "relay", chain: "base", token: "BRETT" }))).text).toMatch(/Bought 1,000 BRETT on Base/);
    const dog = await t.fren.submit(swap({ venue: "relay", chain: "base", token: "DOG" }));
    expect(dog.verdict).toBe("rejected");
    expect(dog.text).toMatch(/unverified tokens on Base use the ticker DOG. Send me the contract address/);
  });

  it("refuses a plan that sends a Base token to Jupiter", async () => {
    const t = buildTestFren();
    const res = await t.fren.submit(swap({ venue: "jupiter", chain: "base", token: BASE_DOG }));
    expect(res.verdict).toBe("invalid");
    expect(res.text).toMatch(/jupiter only trades Solana tokens/);
  });

  it("live: pays from Arbitrum USDC, tops up gas on Robinhood Chain, and shrinks the approval to the exact amount", async () => {
    const { signer, sent } = recordingSigner();
    const t = buildTestFren({ signer, live: true, evmBalances: { [`arbitrum:${ARB_USDC}`]: 500_000_000n, [`base:${BASE_USDC}`]: 10_000_000n } });
    await t.fren.changeLimits("autoApproveUsd=0");
    const res = await t.fren.submit(swap({ venue: "relay", chain: "robinhood", token: RH_FROG }));
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(res.text).toMatch(/about \$2 of ETH on Robinhood Chain/);
    expect(out).toMatch(/✅ Bought 25,000 FROG on Robinhood Chain for \$50.00/);

    const q = t.fake.relayQuotes.at(-1)!;
    expect(q).toMatchObject({ originChainId: 42161, destinationChainId: 4663, originCurrency: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amount: "50000000", topupGas: true });
    expect(sent).toHaveLength(2);
    const approve = decodeFunctionData({ abi: erc20Abi, data: sent[0]!.data });
    expect(approve.args[1]).toBe(50_000_000n);
    expect(sent[1]!.to).toBe("0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f");
    expect(t.evmTxs).toHaveLength(2);
  });

  it("live: the signer refuses a Relay step that targets a contract off its list", async () => {
    const { signer, sent } = recordingSigner();
    const t = buildTestFren({ signer, live: true, evmBalances: { [`base:${BASE_USDC}`]: 500_000_000n } });
    t.fake.relaySteps = (body) => [
      { id: "deposit", kind: "transaction", items: [{ status: "incomplete", data: { from: body.user, to: "0x9999999999999999999999999999999999999999", data: "0xa9059cbb", value: "0", chainId: body.originChainId } }] },
    ];
    await t.fren.submit(swap({ venue: "relay", chain: "base", token: BASE_DOG }));
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/❌ .*not on the signer's allow list/);
    expect(sent).toHaveLength(0);
  });
});

describe("pump.fun and launch snipes", () => {
  it("snipes a Solana coin the moment it starts trading", async () => {
    const t = buildTestFren();
    const res = await t.fren.submit(swap({ venue: "jupiter", token: NEW_COIN }, [{ type: "tradable", venue: "jupiter", token: NEW_COIN }]));
    expect(res.verdict).toBe("needs_code");
    expect(res.text).toMatch(/Launch snipe/);
    expect(res.text).toMatch(/NewCoi…pump starts trading/);
    const armed = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(armed).toMatch(/Watching: Buy \$50.00 of NewCoi…pump/);

    await t.fren.snipeTick();
    expect(t.store.paperHoldings()).toHaveLength(0);
    expect(await t.fren.status()).toMatch(/⏳ NewCoi…pump starts trading \(not trading yet\)/);

    // The coin launches on pump.fun: its curve exists, Jupiter can't route it yet.
    t.pump.addCurve(NEW_COIN, 0.000_000_05);
    t.fake.jupUnroutable.add(NEW_COIN);
    await t.fren.snipeTick();
    expect(t.notifier.sent.at(-1)).toMatch(/Triggered[\s\S]*✅ NewCoi…pump starts trading[\s\S]*Paper: Bought 5,000,000 NewCoi…pump for \$50.00/);
    expect(t.store.paperHoldings()[0]).toMatchObject({ mint: NEW_COIN });
  });

  it("never fires a snipe twice when the watcher and the snipe loop run together", async () => {
    const t = buildTestFren();
    t.pump.addCurve(NEW_COIN, 0.000_000_05);
    t.fake.jupUnroutable.add(NEW_COIN);
    await t.fren.changeLimits("autoApproveUsd=0");
    await t.fren.submit(swap({ venue: "jupiter", token: NEW_COIN }, [{ type: "tradable", venue: "jupiter", token: NEW_COIN }]));
    await t.fren.approve(codeFrom(t.notifier.sent));
    await Promise.all([t.fren.tick(), t.fren.snipeTick(), t.fren.snipeTick()]);
    expect(t.store.recentFills(10)).toHaveLength(1);
  });

  it("tells the owner a coin is still on its pump.fun curve before they approve", async () => {
    const t = buildTestFren();
    t.fake.tokens.push({ id: NEW_COIN, symbol: "NEWC", isVerified: false, usdPrice: 0.00001 });
    t.pump.addCurve(NEW_COIN, 0.000_000_05, 37);
    const res = await t.fren.submit(swap({ venue: "jupiter", token: NEW_COIN }));
    expect(res.text).toMatch(/pump.fun coin still on its bonding curve, 37% of the way to graduating, market cap about \$10,000/);
  });
});
