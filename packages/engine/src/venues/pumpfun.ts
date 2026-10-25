import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  isLegacyQuoteMint,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { usd as fmtUsd } from "@fren/core";

/**
 * pump.fun coins trade on a bonding curve until they "graduate" to a pool.
 * Jupiter routes graduated coins and some curves; young coins need the curve
 * itself. We build curve trades with pump.fun's own SDK so account layouts
 * and fees stay pump.fun's problem, and sign them like any other transaction.
 */

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_DECIMALS = 6;

export interface PumpCurve {
  mint: string;
  /** True once the coin graduated; trade it through Jupiter then. */
  complete: boolean;
  /** What the curve is priced in. Fren trades SOL and USDC curves. */
  quote: "SOL" | "USDC" | "other";
  quoteMint: string;
  /** Price of one whole token in the quote currency. */
  priceInQuote: number;
  /** Share of the curve's tokens sold so far: 100% means it graduates. */
  progressPct: number | null;
  /** Fully diluted market cap in the quote currency. */
  marketCapInQuote: number;
  mayhem: boolean;
}

export interface PumpTrade {
  instructions: TransactionInstruction[];
  /** Expected output: tokens for a buy, quote units for a sell (raw). */
  expectedOutRaw: bigint;
}

export interface PumpFunApi {
  /** null when the mint has no pump.fun curve (not a pump coin, or not created yet). */
  curve(mint: string): Promise<PumpCurve | null>;
  buy(req: { mint: string; user: string; quoteAmountRaw: bigint; slippagePct: number }): Promise<PumpTrade>;
  sell(req: { mint: string; user: string; tokenAmountRaw: bigint; slippagePct: number }): Promise<PumpTrade>;
}

function quoteKind(mint: PublicKey): { quote: PumpCurve["quote"]; quoteMint: string } {
  if (isLegacyQuoteMint(mint) || mint.toBase58() === SOL_MINT) return { quote: "SOL", quoteMint: SOL_MINT };
  if (mint.toBase58() === USDC_MINT) return { quote: "USDC", quoteMint: USDC_MINT };
  return { quote: "other", quoteMint: mint.toBase58() };
}

const toBig = (b: BN) => BigInt(b.toString());

export class OnlinePumpFun implements PumpFunApi {
  private readonly sdk: OnlinePumpSdk;
  private globalCache: { at: number; global: Global; feeConfig: FeeConfig | null } | null = null;

  constructor(private readonly connection: Connection) {
    this.sdk = new OnlinePumpSdk(connection);
  }

  private async globals() {
    if (this.globalCache && Date.now() - this.globalCache.at < 60_000) return this.globalCache;
    const [global, feeConfig] = await Promise.all([this.sdk.fetchGlobal(), this.sdk.fetchFeeConfig().catch(() => null)]);
    this.globalCache = { at: Date.now(), global, feeConfig };
    return this.globalCache;
  }

  private async tokenProgram(mint: PublicKey): Promise<PublicKey> {
    const info = await this.connection.getAccountInfo(mint);
    if (!info) throw new Error(`Mint ${mint.toBase58()} doesn't exist yet.`);
    return info.owner;
  }

  async curve(mint: string): Promise<PumpCurve | null> {
    const key = new PublicKey(mint);
    const info = await this.connection.getAccountInfo(bondingCurvePda(key));
    if (!info) return null;
    const bc = PUMP_SDK.decodeBondingCurveNullable(info);
    if (!bc) return null;
    const { global } = await this.globals();
    return describeCurve(mint, bc, global);
  }

  async buy({ mint, user, quoteAmountRaw, slippagePct }: { mint: string; user: string; quoteAmountRaw: bigint; slippagePct: number }): Promise<PumpTrade> {
    const m = new PublicKey(mint);
    const u = new PublicKey(user);
    const tokenProgram = await this.tokenProgram(m);
    const { global, feeConfig } = await this.globals();
    const state = await this.sdk.fetchBuyState(m, u, tokenProgram);
    const { quote } = quoteKind(state.bondingCurve.quoteMint);
    const quoteAmount = new BN(quoteAmountRaw.toString());
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: quoteAmount,
      quoteMint: state.quoteMint,
    });
    const common = {
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint: m,
      user: u,
      amount,
      slippage: slippagePct,
      tokenProgram,
    };
    const instructions =
      quote === "SOL"
        ? await PUMP_SDK.buyInstructions({ ...common, solAmount: quoteAmount })
        : await PUMP_SDK.buyV2Instructions({ ...common, quoteAmount, quoteTokenProgram: state.quoteTokenProgram });
    return { instructions, expectedOutRaw: toBig(amount) };
  }

  async sell({ mint, user, tokenAmountRaw, slippagePct }: { mint: string; user: string; tokenAmountRaw: bigint; slippagePct: number }): Promise<PumpTrade> {
    const m = new PublicKey(mint);
    const u = new PublicKey(user);
    const tokenProgram = await this.tokenProgram(m);
    const { global, feeConfig } = await this.globals();
    const state = await this.sdk.fetchSellState(m, u, tokenProgram);
    const { quote } = quoteKind(state.bondingCurve.quoteMint);
    const amount = new BN(tokenAmountRaw.toString());
    const quoteAmount = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount,
    });
    const common = {
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      mint: m,
      user: u,
      amount,
      slippage: slippagePct,
      tokenProgram,
    };
    const instructions =
      quote === "SOL"
        ? await PUMP_SDK.sellInstructions({
            ...common,
            solAmount: quoteAmount,
            mayhemMode: state.bondingCurve.isMayhemMode,
            cashback: state.bondingCurve.isCashbackCoin,
          })
        : await PUMP_SDK.sellV2Instructions({ ...common, quoteAmount, quoteTokenProgram: state.quoteTokenProgram });
    return { instructions, expectedOutRaw: toBig(quoteAmount) };
  }
}

export function describeCurve(mint: string, bc: BondingCurve, global: Pick<Global, "initialRealTokenReserves">): PumpCurve {
  const { quote, quoteMint } = quoteKind(bc.quoteMint);
  const quoteDecimals = quote === "SOL" ? 9 : 6;
  const vq = Number(bc.virtualQuoteReserves.toString()) / 10 ** quoteDecimals;
  const vt = Number(bc.virtualTokenReserves.toString()) / 10 ** TOKEN_DECIMALS;
  const priceInQuote = vt > 0 ? vq / vt : 0;
  const supply = Number(bc.tokenTotalSupply.toString()) / 10 ** TOKEN_DECIMALS;
  const initial = Number(global.initialRealTokenReserves.toString());
  const left = Number(bc.realTokenReserves.toString());
  return {
    mint,
    complete: bc.complete,
    quote,
    quoteMint,
    priceInQuote,
    progressPct: initial > 0 ? Math.min(100, Math.max(0, (1 - left / initial) * 100)) : null,
    marketCapInQuote: priceInQuote * supply,
    mayhem: bc.isMayhemMode,
  };
}

/** USD price of one token on the curve, given SOL's USD price. */
export function curveUsdPrice(c: PumpCurve, solUsd: number | null): number | null {
  if (c.quote === "USDC") return c.priceInQuote;
  if (c.quote === "SOL" && solUsd) return c.priceInQuote * solUsd;
  return null;
}

/** One-line facts for the owner before they approve a pump.fun buy. */
export async function pumpFunNotes(api: PumpFunApi, mint: string, solUsd: number | null): Promise<string[]> {
  const c = await api.curve(mint);
  if (!c) return [];
  if (c.complete) return ["pump.fun coin that has graduated to a pool."];
  const px = curveUsdPrice(c, solUsd);
  const mcap = px === null ? "" : `, market cap about ${fmtUsd(px * (c.marketCapInQuote / c.priceInQuote))}`;
  const progress = c.progressPct === null ? "" : `, ${c.progressPct.toFixed(0)}% of the way to graduating`;
  const notes = [`pump.fun coin still on its bonding curve${progress}${mcap}. Most of these go to zero.`];
  if (c.quote === "other") notes.push("This curve is priced in another coin, which Fren can't trade yet.");
  return notes;
}
