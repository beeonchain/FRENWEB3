import { checkEvmTransaction, createSigner, generateKeys, type EvmTxRequest, type SignerApi } from "@fren/signer";
import { decodeFunctionData, erc20Abi, maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_DOG, buildTestFren } from "./testing.js";
import { AAVE_MARKETS, AAVE_POOL_ABI } from "./venues/aave.js";
import { USDC_MINT } from "./venues/jupiter.js";
import { KAMINO_MAIN_MARKET, KAMINO_USDC_RESERVE } from "./venues/solana-lend.js";

const codeFrom = (sent: string[]) => /\/ok ([A-Z0-9]{6})/.exec(sent.at(-1) ?? "")?.[1] ?? "";
const ARB = AAVE_MARKETS.arbitrum;
const key = (chain: string, token: string) => `${chain}:${token.toLowerCase()}`;

const earn = (action: "deposit" | "withdraw", amount: Record<string, unknown>, protocol?: string) => ({
  request: "test",
  steps: [{ leg: { kind: "earn", venue: "yield", action, amount, ...(protocol ? { protocol } : {}) } }],
});

/**
 * The real signer's rules, with sending stubbed out. Aave transactions move
 * the fake balances the way the chain would, so later steps see the result.
 */
function chainSigner(balances: Record<string, bigint>) {
  const real = createSigner(generateKeys());
  const sent: EvmTxRequest[] = [];
  const signer: SignerApi = {
    ...real,
    async evmSendTransaction(req) {
      checkEvmTransaction(req, (await real.addresses()).evm);
      sent.push(req);
      if (req.to.toLowerCase() === ARB.pool.toLowerCase()) {
        const { functionName, args } = decodeFunctionData({ abi: AAVE_POOL_ABI, data: req.data });
        const usdc = key("arbitrum", ARB.usdc);
        const a = key("arbitrum", ARB.aToken);
        const amt = functionName === "withdraw" && args[1] === maxUint256 ? (balances[a] ?? 0n) : (args[1] as bigint);
        const sign = functionName === "supply" ? 1n : -1n;
        balances[usdc] = (balances[usdc] ?? 0n) - sign * amt;
        balances[a] = (balances[a] ?? 0n) + sign * amt;
      }
      return { txHash: `0x${String(sent.length).padStart(64, "0")}` };
    },
  };
  return { signer, sent };
}

describe("USDC yield", () => {
  it("compares rates across Jupiter Lend, Kamino and Aave, best first", async () => {
    const t = buildTestFren();
    const text = await t.fren.yieldRates();
    expect(text).toMatch(/Jupiter Lend \(Solana\): 5\.69%\n• Kamino \(Solana\): 4\.68%\n• Aave on Arbitrum: 4\.60%\n• Aave on Base: 4\.60%/);
    expect(text).toMatch(/Nothing lent out yet/);
  });

  it("paper: lends at the best rate without counting as a trade, earns interest, and pays it back", async () => {
    const t = buildTestFren();
    const res = await t.fren.submit(earn("deposit", { type: "usd", usd: 3_000 }));
    // Over the $500 per-trade cap, but lending isn't spending: it only needs the owner's code.
    expect(res.verdict).toBe("needs_code");
    expect(res.text).toMatch(/Lend \$3,000 of USDC on Jupiter Lend \(Solana\)/);
    expect(res.text).toMatch(/Earns about 5\.69% a year on \$3,000/);
    expect(await t.fren.approve(codeFrom(t.notifier.sent))).toMatch(/📝 Paper: Lent \$3,000 USDC on Jupiter Lend \(Solana\) at 5\.69% a year/);
    expect(t.store.paperUsdc()).toBe(7_000);
    expect(t.store.spentTodayUsd("paper")).toBe(0);
    expect(await t.fren.status()).toMatch(/\$3,000 USDC lent on Jupiter Lend \(Solana\)/);

    // A year passes.
    t.store.setKv("yield_at:jupiter_lend", String(Date.now() - 365 * 86_400_000));
    expect(await t.fren.status()).toMatch(/\$3,171 USDC lent on Jupiter Lend \(Solana\) \(\+\$171 interest\)/);
    const out = await t.fren.submit(earn("withdraw", { type: "fraction", fraction: 1 }));
    expect(out.verdict).toBe("executed");
    expect(out.text).toMatch(/📝 Paper: Took \$3,171 USDC back from Jupiter Lend \(Solana\), including \$171 of interest/);
    expect(t.store.paperUsdc()).toBeCloseTo(10_170.7, 0);
    expect(await t.fren.status()).not.toMatch(/lent on/);
  });

  it("paper: a trade that needs the cash takes it back from lending first", async () => {
    const t = buildTestFren();
    await t.fren.submit(earn("deposit", { type: "fraction", fraction: 0.99 }));
    await t.fren.approve(codeFrom(t.notifier.sent));
    expect(t.store.paperUsdc()).toBeCloseTo(100, 6);
    await t.fren.submit({ request: "buy", steps: [{ leg: { kind: "swap", venue: "jupiter", side: "buy", token: "JUP", amount: { type: "usd", usd: 400 } } }] });
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/↩️ Not enough idle USDC, so first:\n📝 Paper: Took \$300 USDC back from Jupiter Lend \(Solana\)\n📝 Paper: Bought 400 JUP for \$400/);
  });

  it("withdraws only what's there", async () => {
    const t = buildTestFren();
    const res = await t.fren.submit(earn("withdraw", { type: "usd", usd: 50 }));
    expect(res.text).toMatch(/❌ .*You have \$0.00 lent out, less than \$50/);
  });
});

describe("live USDC yield", () => {
  it("lends Solana USDC on Jupiter Lend through its API, and redeems every share to take it all back", async () => {
    const { signer } = chainSigner({});
    const t = buildTestFren({ signer, live: true });
    t.fake.solanaUsdc = 1_000;
    await t.fren.submit(earn("deposit", { type: "fraction", fraction: 1 }));
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/✅ Lent \$1,000 USDC on Jupiter Lend \(Solana\) at 5\.69% a year · https:\/\/solscan\.io\/tx\/sig1/);
    const sol = (await signer.addresses()).solana;
    expect(t.fake.lendCalls[0]).toEqual({ path: "/earn/deposit", body: { asset: USDC_MINT, signer: sol, amount: "1000000000" } });
    expect(t.solanaSent[0]).toEqual({ txBase64: "jup-tx-1", maxSolSpendLamports: 10_000_000 });

    const back = await t.fren.submit(earn("withdraw", { type: "fraction", fraction: 1 }));
    expect(back.text).toMatch(/✅ Took \$1,000 USDC back from Jupiter Lend \(Solana\)/);
    expect(t.fake.lendCalls[1]).toEqual({ path: "/earn/redeem", body: { asset: USDC_MINT, signer: sol, shares: "940000000" } });
  });

  it("lends on Kamino's main USDC reserve when asked, in USDC units", async () => {
    const { signer } = chainSigner({});
    const t = buildTestFren({ signer, live: true });
    t.fake.solanaUsdc = 500;
    await t.fren.submit(earn("deposit", { type: "usd", usd: 300 }, "kamino"));
    expect(await t.fren.approve(codeFrom(t.notifier.sent))).toMatch(/✅ Lent \$300 USDC on Kamino \(Solana\) at 4\.68% a year/);
    expect(t.fake.lendCalls[0]).toEqual({
      path: "/ktx/klend/deposit",
      body: { wallet: (await signer.addresses()).solana, market: KAMINO_MAIN_MARKET, reserve: KAMINO_USDC_RESERVE, amount: "300.000000" },
    });
    expect(t.solanaSent[0]!.maxSolSpendLamports).toBe(50_000_000);
    expect(await t.fren.yieldRates()).toMatch(/Kamino \(Solana\): 4\.68% · you have \$300 here/);
  });

  it("picks Aave when the USDC is on Arbitrum, approving the exact amount and supplying for the wallet itself", async () => {
    const balances: Record<string, bigint> = { [key("arbitrum", ARB.usdc)]: 500_000_000n };
    const { signer, sent } = chainSigner(balances);
    const t = buildTestFren({ signer, live: true, evmBalances: balances });
    const res = await t.fren.submit(earn("deposit", { type: "usd", usd: 400 }));
    expect(res.text).toMatch(/Lend \$400 of USDC on Aave on Arbitrum/);
    expect(await t.fren.approve(codeFrom(t.notifier.sent))).toMatch(/✅ Lent \$400 USDC on Aave on Arbitrum at 4\.60% a year · https:\/\/arbiscan\.io\/tx\//);
    const owner = (await signer.addresses()).evm;
    expect(decodeFunctionData({ abi: erc20Abi, data: sent[0]!.data }).args).toEqual([ARB.pool, 400_000_000n]);
    expect(decodeFunctionData({ abi: AAVE_POOL_ABI, data: sent[1]!.data }).args).toEqual([ARB.usdc, 400_000_000n, owner, 0]);
    expect(balances[key("arbitrum", ARB.aToken)]).toBe(400_000_000n);
  });

  it("takes USDC back from Aave on its own when a Base token buy needs it", async () => {
    const balances: Record<string, bigint> = { [key("arbitrum", ARB.usdc)]: 20_000_000n, [key("arbitrum", ARB.aToken)]: 1_000_000_000n };
    const { signer, sent } = chainSigner(balances);
    const t = buildTestFren({ signer, live: true, evmBalances: balances });
    await t.fren.submit({ request: "buy", steps: [{ leg: { kind: "swap", venue: "relay", chain: "base", side: "buy", token: BASE_DOG, amount: { type: "usd", usd: 50 } } }] });
    const out = await t.fren.approve(codeFrom(t.notifier.sent));
    expect(out).toMatch(/↩️ Not enough idle USDC on Arbitrum, so first:\n✅ Took \$30\.07 USDC back from Aave on Arbitrum[\s\S]*✅ Bought 5,000 DOG on Base for \$50/);
    const w = decodeFunctionData({ abi: AAVE_POOL_ABI, data: sent[0]!.data });
    expect(w.functionName).toBe("withdraw");
    expect(w.args).toEqual([ARB.usdc, 30_070_000n, (await signer.addresses()).evm]);
  });
});
