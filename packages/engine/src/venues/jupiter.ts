import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { price as fmtPrice, usd as fmtUsd, type PlanStep, type ResolvedStep, type SwapLeg } from "@fren/core";
import type { SignerApi } from "@fren/signer";
import { getJson, postJson, type Fetch } from "../http.js";
import type { Store } from "../store.js";
import { VenueError, type ExecContext, type ExecResult, type PositionView, type VenueAdapter } from "./types.js";

export const USDC_MINT = "EPjFWdd5AufqSNqeM2qUv8BZ3vVdXzaa9Sr8ZnxsHMwv";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  verified: boolean;
  usdPrice: number | null;
  liquidityUsd: number | null;
}

interface JupToken {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  isVerified?: boolean;
  tags?: string[];
  usdPrice?: number;
  liquidity?: number;
}

interface JupQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [k: string]: unknown;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isMint(s: string): boolean {
  return BASE58.test(s);
}

export interface JupiterVenueOptions {
  fetchFn: Fetch;
  apiUrl: string;
  apiKey?: string;
  solanaRpcUrl: string;
  store: Store;
  signer: SignerApi | null;
}

export class JupiterVenue implements VenueAdapter {
  readonly venue = "jupiter" as const;
  private connection: Connection;
  private tokenCache = new Map<string, TokenInfo>();

  constructor(private readonly o: JupiterVenueOptions) {
    this.connection = new Connection(o.solanaRpcUrl, { commitment: "confirmed", fetch: o.fetchFn });
  }

  private headers(): Record<string, string> {
    return this.o.apiKey ? { "x-api-key": this.o.apiKey } : {};
  }

  private toInfo(t: JupToken): TokenInfo {
    return {
      mint: t.id,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      verified: Boolean(t.isVerified) || Boolean(t.tags?.includes("verified")),
      usdPrice: t.usdPrice ?? null,
      liquidityUsd: t.liquidity ?? null,
    };
  }

  async searchTokens(query: string): Promise<TokenInfo[]> {
    const list = await getJson<JupToken[]>(
      this.o.fetchFn,
      `${this.o.apiUrl}/tokens/v2/search?query=${encodeURIComponent(query)}`,
      this.headers(),
    );
    return list.map((t) => this.toInfo(t));
  }

  /**
   * A contract address resolves to that token, verified or not. A bare symbol
   * only resolves to a verified token: dozens of tokens share every popular
   * ticker, and buying the wrong one is the classic way to lose money.
   */
  async token(query: string): Promise<TokenInfo> {
    const key = query.trim();
    const cached = this.tokenCache.get(key.toUpperCase());
    if (cached) return cached;
    const results = await this.searchTokens(key);
    let found: TokenInfo | undefined;
    if (isMint(key)) {
      found = results.find((t) => t.mint === key);
      if (!found) throw new VenueError(`Jupiter doesn't know the token ${key}. It may not be tradable yet.`);
    } else {
      const sym = key.replace(/^\$/, "").toUpperCase();
      const matches = results.filter((t) => t.symbol.toUpperCase() === sym);
      found = matches.filter((t) => t.verified).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0];
      if (!found) {
        throw new VenueError(
          matches.length
            ? `${matches.length} unverified tokens use the ticker ${sym}. Send me the contract address.`
            : `No Solana token found for ${sym}. Send me the contract address.`,
        );
      }
    }
    this.tokenCache.set(key.toUpperCase(), found);
    return found;
  }

  async prices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (mints.length === 0) return out;
    const res = await getJson<Record<string, { usdPrice: number } | null>>(
      this.o.fetchFn,
      `${this.o.apiUrl}/price/v3?ids=${mints.join(",")}`,
      this.headers(),
    );
    for (const [mint, v] of Object.entries(res)) if (v) out.set(mint, v.usdPrice);
    return out;
  }

  async resolve(step: PlanStep, index: number): Promise<ResolvedStep> {
    const leg = step.leg;
    if (leg.kind !== "swap") throw new VenueError(`Jupiter cannot run a ${leg.kind} leg.`);
    const t = await this.token(leg.token);
    if (t.mint === USDC_MINT) throw new VenueError("That's USDC already; pick the token to buy or sell.");
    const canonical = { ...step, leg: { ...leg, token: t.mint } } as PlanStep;
    const spend = leg.side === "buy" && leg.amount.type === "usd" ? leg.amount.usd : 0;
    return {
      index,
      step: canonical,
      symbol: t.symbol,
      spendUsd: spend,
      notionalUsd: spend,
      verifiedToken: t.verified,
    };
  }

  async execute(r: ResolvedStep, ctx: ExecContext): Promise<ExecResult> {
    const leg = r.step.leg;
    if (leg.kind !== "swap") throw new VenueError(`Jupiter cannot run a ${leg.kind} leg.`);
    const t = await this.token(leg.token);
    return ctx.mode === "paper" ? this.paperSwap(leg, t, ctx) : this.liveSwap(leg, t, ctx);
  }

  // -- paper -----------------------------------------------------------------

  private async paperSwap(leg: SwapLeg, t: TokenInfo, ctx: ExecContext): Promise<ExecResult> {
    const store = this.o.store;
    const px = (await this.prices([t.mint])).get(t.mint) ?? t.usdPrice;
    if (!px) throw new VenueError(`No price for ${t.symbol} right now.`);
    const held = store.paperHolding(t.mint) ?? { mint: t.mint, symbol: t.symbol, amount: 0, costUsd: 0 };
    if (leg.side === "buy") {
      const usd = leg.amount.type === "usd" ? leg.amount.usd : store.paperUsdc() * leg.amount.fraction;
      if (usd > store.paperUsdc()) throw new VenueError(`Paper balance is ${fmtUsd(store.paperUsdc())}.`);
      const qty = usd / px;
      store.setPaperUsdc(store.paperUsdc() - usd);
      store.setPaperHolding({ ...held, amount: held.amount + qty, costUsd: held.costUsd + usd });
      store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "jupiter", symbol: t.symbol, action: "buy", size: qty, price: px, usd, spendUsd: usd, mode: "paper" });
      return { text: `📝 Paper: Bought ${fmtQty(qty)} ${t.symbol} for ${fmtUsd(usd)} at ${fmtPrice(px)}` };
    }
    const qty = leg.amount.type === "fraction" ? held.amount * leg.amount.fraction : Math.min(held.amount, leg.amount.usd / px);
    if (qty <= 0) throw new VenueError(`You hold no paper ${t.symbol}.`);
    const usd = qty * px;
    store.setPaperUsdc(store.paperUsdc() + usd);
    store.setPaperHolding({ ...held, amount: held.amount - qty, costUsd: held.costUsd * (1 - qty / held.amount) });
    store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "jupiter", symbol: t.symbol, action: "sell", size: qty, price: px, usd, spendUsd: 0, mode: "paper" });
    return { text: `📝 Paper: Sold ${fmtQty(qty)} ${t.symbol} for ${fmtUsd(usd)} at ${fmtPrice(px)}` };
  }

  // -- live ------------------------------------------------------------------

  private signer(): SignerApi {
    if (!this.o.signer) throw new VenueError("Live trading needs wallets. Run `fren init` first.");
    return this.o.signer;
  }

  private async owner(): Promise<PublicKey> {
    return new PublicKey((await this.signer().addresses()).solana);
  }

  /** Raw (integer) balance of an SPL token in the wallet, summed across accounts. */
  async rawBalance(owner: PublicKey, mint: string): Promise<bigint> {
    const res = await this.connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
    return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n);
  }

  private async liveSwap(leg: SwapLeg, t: TokenInfo, ctx: ExecContext): Promise<ExecResult> {
    const owner = await this.owner();
    let inputMint: string;
    let outputMint: string;
    let amount: bigint;
    if (leg.side === "buy") {
      inputMint = USDC_MINT;
      outputMint = t.mint;
      const usdcRaw = await this.rawBalance(owner, USDC_MINT);
      amount = leg.amount.type === "usd" ? BigInt(Math.floor(leg.amount.usd * 1e6)) : (usdcRaw * BigInt(Math.floor(leg.amount.fraction * 1e6))) / 1_000_000n;
      if (amount > usdcRaw) throw new VenueError(`Your wallet has ${fmtUsd(Number(usdcRaw) / 1e6)} USDC; this needs ${fmtUsd(Number(amount) / 1e6)}.`);
    } else {
      inputMint = t.mint;
      outputMint = USDC_MINT;
      const raw = t.mint === SOL_MINT ? BigInt(await this.connection.getBalance(owner)) - 10_000_000n : await this.rawBalance(owner, t.mint);
      if (raw <= 0n) throw new VenueError(`You hold no ${t.symbol}.`);
      if (leg.amount.type === "fraction") {
        amount = (raw * BigInt(Math.floor(leg.amount.fraction * 1e6))) / 1_000_000n;
      } else {
        const px = (await this.prices([t.mint])).get(t.mint);
        if (!px) throw new VenueError(`No price for ${t.symbol} right now.`);
        const want = BigInt(Math.floor((leg.amount.usd / px) * 10 ** t.decimals));
        amount = want < raw ? want : raw;
      }
    }

    const quote = await getJson<JupQuote>(
      this.o.fetchFn,
      `${this.o.apiUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${leg.maxSlippageBps}&restrictIntermediateTokens=true`,
      this.headers(),
    );
    const swap = await postJson<{ swapTransaction: string; lastValidBlockHeight: number }>(
      this.o.fetchFn,
      `${this.o.apiUrl}/swap/v1/swap`,
      {
        quoteResponse: quote,
        userPublicKey: owner.toBase58(),
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
      },
      this.headers(),
    );

    // Selling SOL itself loses `amount` lamports; everything else should cost only fees and rent.
    const maxSolSpend = 10_000_000 + (inputMint === SOL_MINT ? Number(amount) : 0);
    const { signedTxBase64 } = await this.signer().solSignTransaction({ txBase64: swap.swapTransaction, maxSolSpendLamports: maxSolSpend });
    const raw = Buffer.from(signedTxBase64, "base64");
    const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    const blockhash = VersionedTransaction.deserialize(raw).message.recentBlockhash;
    const conf = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight: swap.lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new VenueError(`Swap failed on-chain: ${JSON.stringify(conf.value.err)} (tx ${signature})`);

    const inDec = inputMint === USDC_MINT ? 6 : t.decimals;
    const outDec = outputMint === USDC_MINT ? 6 : t.decimals;
    const inUi = Number(quote.inAmount) / 10 ** inDec;
    const outUi = Number(quote.outAmount) / 10 ** outDec;
    const usd = leg.side === "buy" ? inUi : outUi;
    const qty = leg.side === "buy" ? outUi : inUi;
    this.o.store.insertFill({
      planId: ctx.planId,
      idx: ctx.idx,
      venue: "jupiter",
      symbol: t.symbol,
      action: leg.side,
      size: qty,
      price: usd / qty,
      usd,
      spendUsd: leg.side === "buy" ? usd : 0,
      mode: "live",
      ref: signature,
    });
    const verb = leg.side === "buy" ? "Bought" : "Sold";
    return { text: `✅ ${verb} ${fmtQty(qty)} ${t.symbol} for ${fmtUsd(usd)} at ${fmtPrice(usd / qty)} · https://solscan.io/tx/${signature}` };
  }

  async positions(mode: "paper" | "live"): Promise<PositionView[]> {
    if (mode === "paper") {
      const holdings = this.o.store.paperHoldings();
      const px = await this.prices(holdings.map((h) => h.mint)).catch(() => new Map<string, number>());
      return holdings.map((h) => {
        const mark = px.get(h.mint) ?? null;
        const value = mark === null ? h.costUsd : h.amount * mark;
        return { venue: "jupiter", symbol: h.symbol, kind: "spot", side: "hold", size: h.amount, entryPx: h.costUsd / h.amount, markPx: mark, valueUsd: value, pnlUsd: mark === null ? null : value - h.costUsd };
      });
    }
    if (!this.o.signer) return [];
    const owner = await this.owner();
    const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
    const held = accounts.value
      .map((a) => a.account.data.parsed.info as { mint: string; tokenAmount: { uiAmount: number } })
      .filter((i) => i.tokenAmount.uiAmount > 0 && i.mint !== USDC_MINT);
    const sol = (await this.connection.getBalance(owner)) / 1e9;
    const mints = [SOL_MINT, ...held.map((h) => h.mint)];
    const px = await this.prices(mints).catch(() => new Map<string, number>());
    const views: PositionView[] = [];
    if (sol > 0) views.push({ venue: "jupiter", symbol: "SOL", kind: "spot", side: "hold", size: sol, entryPx: null, markPx: px.get(SOL_MINT) ?? null, valueUsd: sol * (px.get(SOL_MINT) ?? 0), pnlUsd: null });
    for (const h of held) {
      const mark = px.get(h.mint) ?? null;
      views.push({ venue: "jupiter", symbol: h.mint, kind: "spot", side: "hold", size: h.tokenAmount.uiAmount, entryPx: null, markPx: mark, valueUsd: h.tokenAmount.uiAmount * (mark ?? 0), pnlUsd: null });
    }
    return views;
  }

  async usdcBalance(): Promise<number | null> {
    if (!this.o.signer) return null;
    return Number(await this.rawBalance(await this.owner(), USDC_MINT)) / 1e6;
  }

  /** Spot holdings are left alone by the kill switch; it only closes leveraged positions. */
  async flatten(): Promise<string[]> {
    return [];
  }
}

function fmtQty(q: number): string {
  if (q >= 1000) return q.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (q >= 1) return q.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return q.toPrecision(4);
}
