import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { JITO_TIP_ACCOUNTS } from "@fren/signer";
import { price as fmtPrice, shortToken, usd as fmtUsd, type PlanStep, type ResolvedStep, type SwapLeg } from "@fren/core";
import type { SignerApi } from "@fren/signer";
import { getJson, postJson, type Fetch } from "../http.js";
import type { Store } from "../store.js";
import { curveUsdPrice, pumpFunNotes, type PumpCurve, type PumpFunApi } from "./pumpfun.js";
import { VenueError, type ExecContext, type ExecResult, type PositionView, type SpotVenueAdapter } from "./types.js";

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
  /** pump.fun coin info, for the "this coin is 4 minutes old" notes. Optional. */
  pumpFun?: PumpFunApi;
  /** Jito block engine for snipes. Defaults to Jito mainnet. */
  jitoUrl?: string;
  /** Jito tip for snipes, in lamports. */
  snipeTipLamports?: number;
}

/** Default Jito tip on a snipe: 0.001 SOL. The signer refuses anything over its own cap. */
export const DEFAULT_SNIPE_TIP_LAMPORTS = 1_000_000;

export class JupiterVenue implements SpotVenueAdapter {
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

  /**
   * For a launch snipe the token may trade before Jupiter's token list knows
   * it. A mint the owner gave us is enough; decimals come from the chain.
   */
  private async tokenOrBare(query: string, mode: "paper" | "live"): Promise<TokenInfo> {
    try {
      return await this.token(query);
    } catch (err) {
      const mint = query.trim();
      if (!isMint(mint)) throw err;
      let decimals = 6; // pump.fun coins all use 6
      if (mode === "live") {
        const info = await this.connection.getParsedAccountInfo(new PublicKey(mint)).catch(() => null);
        const parsed = (info?.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed;
        if (parsed?.info?.decimals !== undefined) decimals = parsed.info.decimals;
      }
      return { mint, symbol: shortToken(mint), name: "", decimals, verified: false, usdPrice: null, liquidityUsd: null };
    }
  }

  private async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupQuote> {
    return getJson<JupQuote>(
      this.o.fetchFn,
      `${this.o.apiUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`,
      this.headers(),
    );
  }

  /** True once Jupiter can route USDC into the token: it has launched and has a pool or bonding curve. */
  async isTradable(token: string): Promise<boolean> {
    try {
      const q = await this.quote(USDC_MINT, token.trim(), 1_000_000n, 5000);
      return BigInt(q.outAmount) > 0n;
    } catch {
      // A pump.fun coin trades the moment its curve exists, before any aggregator sees it.
      const curve = this.o.pumpFun ? await this.o.pumpFun.curve(token.trim()).catch(() => null) : null;
      return curve !== null && !curve.complete && curve.quote !== "other";
    }
  }

  private async solUsd(): Promise<number | null> {
    return (await this.prices([SOL_MINT]).catch(() => new Map<string, number>())).get(SOL_MINT) ?? null;
  }

  private async pumpNotes(mint: string): Promise<string[]> {
    if (!this.o.pumpFun) return [];
    return pumpFunNotes(this.o.pumpFun, mint, await this.solUsd()).catch(() => []);
  }

  /** USD price from a small quote, for tokens too new for the price API. */
  private async quotedPrice(t: TokenInfo): Promise<number | null> {
    try {
      const q = await this.quote(USDC_MINT, t.mint, 10_000_000n, 5000);
      const out = Number(q.outAmount) / 10 ** t.decimals;
      return out > 0 ? 10 / out : null;
    } catch {
      const curve = this.o.pumpFun ? await this.o.pumpFun.curve(t.mint).catch(() => null) : null;
      return curve && !curve.complete ? curveUsdPrice(curve, await this.solUsd()) : null;
    }
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
    const snipe = step.when.some((c) => c.type === "tradable");
    let t: TokenInfo;
    try {
      t = await this.token(leg.token);
    } catch (err) {
      // A snipe targets a coin that doesn't exist yet; the address is all there is.
      if (!snipe || !isMint(leg.token.trim())) throw err;
      t = { mint: leg.token.trim(), symbol: shortToken(leg.token.trim()), name: "", decimals: 6, verified: false, usdPrice: null, liquidityUsd: null };
    }
    if (t.mint === USDC_MINT) throw new VenueError("That's USDC already; pick the token to buy or sell.");
    const canonical = {
      ...step,
      leg: { ...leg, token: t.mint },
      when: step.when.map((c) => (c.type === "tradable" && c.token.trim() === leg.token.trim() ? { ...c, token: t.mint } : c)),
    } as PlanStep;
    const notes = leg.side === "buy" && this.o.pumpFun ? await this.pumpNotes(t.mint) : [];
    const spend = leg.side === "buy" && leg.amount.type === "usd" ? leg.amount.usd : 0;
    return {
      index,
      step: canonical,
      symbol: t.symbol,
      spendUsd: spend,
      notionalUsd: spend,
      verifiedToken: t.verified,
      ...(notes.length ? { notes } : {}),
    };
  }

  async execute(r: ResolvedStep, ctx: ExecContext): Promise<ExecResult> {
    const leg = r.step.leg;
    if (leg.kind !== "swap") throw new VenueError(`Jupiter cannot run a ${leg.kind} leg.`);
    const t = await this.tokenOrBare(leg.token, ctx.mode);
    return ctx.mode === "paper" ? this.paperSwap(leg, t, ctx) : this.liveSwap(leg, t, ctx);
  }

  // -- paper -----------------------------------------------------------------

  private async paperSwap(leg: SwapLeg, t: TokenInfo, ctx: ExecContext): Promise<ExecResult> {
    const store = this.o.store;
    const px = (await this.prices([t.mint]).catch(() => new Map<string, number>())).get(t.mint) ?? t.usdPrice ?? (await this.quotedPrice(t));
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
    const tip = ctx.snipe ? (this.o.snipeTipLamports ?? DEFAULT_SNIPE_TIP_LAMPORTS) : 0;
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
        const px = (await this.prices([t.mint])).get(t.mint) ?? (await this.quotedPrice(t));
        if (!px) throw new VenueError(`No price for ${t.symbol} right now.`);
        const want = BigInt(Math.floor((leg.amount.usd / px) * 10 ** t.decimals));
        amount = want < raw ? want : raw;
      }
    }

    let quote: JupQuote;
    try {
      quote = await this.quote(inputMint, outputMint, amount, leg.maxSlippageBps);
    } catch (err) {
      // Young pump.fun coins trade only on their bonding curve, which Jupiter may not route yet.
      const curve = this.o.pumpFun ? await this.o.pumpFun.curve(t.mint).catch(() => null) : null;
      if (!curve || curve.complete) throw err;
      return this.curveSwap(leg, t, curve, owner, amount, tip, ctx);
    }
    const signature = await this.jupiterSwap(owner, quote, inputMint, amount, tip);

    const inDec = inputMint === USDC_MINT ? 6 : t.decimals;
    const outDec = outputMint === USDC_MINT ? 6 : t.decimals;
    const inUi = Number(quote.inAmount) / 10 ** inDec;
    const outUi = Number(quote.outAmount) / 10 ** outDec;
    const usd = leg.side === "buy" ? inUi : outUi;
    const qty = leg.side === "buy" ? outUi : inUi;
    return this.recordLive(leg, t, ctx, qty, usd, signature, "");
  }

  private recordLive(leg: SwapLeg, t: TokenInfo, ctx: ExecContext, qty: number, usd: number, signature: string, suffix: string): ExecResult {
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
    return { text: `✅ ${verb} ${fmtQty(qty)} ${t.symbol} for ${fmtUsd(usd)} at ${fmtPrice(usd / qty)}${suffix} · https://solscan.io/tx/${signature}` };
  }

  /** Build, sign, send and confirm one Jupiter swap. Returns the signature. */
  private async jupiterSwap(owner: PublicKey, quote: JupQuote, inputMint: string, amount: bigint, tip: number): Promise<string> {
    const swap = await postJson<{ swapTransaction: string; lastValidBlockHeight: number }>(
      this.o.fetchFn,
      `${this.o.apiUrl}/swap/v1/swap`,
      {
        quoteResponse: quote,
        userPublicKey: owner.toBase58(),
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: tip
          ? { jitoTipLamports: tip }
          : { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
      },
      this.headers(),
    );
    // Selling SOL itself loses `amount` lamports; everything else should cost only fees, rent and the snipe tip.
    const maxSol = 10_000_000 + tip + (inputMint === SOL_MINT ? Number(amount) : 0);
    return this.signAndSend(swap.swapTransaction, maxSol, tip, swap.lastValidBlockHeight);
  }

  private async signAndSend(txBase64: string, maxSolSpendLamports: number, tip: number, lastValidBlockHeight: number): Promise<string> {
    const { signedTxBase64 } = await this.signer().solSignTransaction({
      txBase64,
      maxSolSpendLamports,
      ...(tip ? { jitoTipLamports: tip } : {}),
    });
    const raw = Buffer.from(signedTxBase64, "base64");
    if (tip) await this.sendToJito(signedTxBase64).catch(() => undefined);
    const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    const blockhash = VersionedTransaction.deserialize(raw).message.recentBlockhash;
    const conf = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new VenueError(`Transaction failed on-chain: ${JSON.stringify(conf.value.err)} (tx ${signature})`);
    return signature;
  }

  /**
   * Trade a coin on its pump.fun bonding curve. SOL-priced curves need SOL, so
   * a buy first swaps the USDC to SOL, and a sell swaps the SOL back to USDC.
   */
  private async curveSwap(leg: SwapLeg, t: TokenInfo, curve: PumpCurve, owner: PublicKey, amount: bigint, tip: number, ctx: ExecContext): Promise<ExecResult> {
    const pump = this.o.pumpFun!;
    if (curve.quote === "other") throw new VenueError(`${t.symbol}'s curve is priced in another coin, which Fren can't trade yet.`);
    const slippagePct = leg.maxSlippageBps / 100;
    const user = owner.toBase58();

    if (leg.side === "buy") {
      let quoteRaw = amount;
      if (curve.quote === "SOL") {
        const q = await this.quote(USDC_MINT, SOL_MINT, amount, 100);
        await this.jupiterSwap(owner, q, USDC_MINT, amount, 0);
        quoteRaw = BigInt((q as { otherAmountThreshold?: string }).otherAmountThreshold ?? q.outAmount);
      }
      const before = await this.rawBalance(owner, t.mint);
      const trade = await pump.buy({ mint: t.mint, user, quoteAmountRaw: quoteRaw, slippagePct });
      const maxSol = 10_000_000 + tip + (curve.quote === "SOL" ? Number(quoteRaw) : 0);
      const signature = await this.sendInstructions(owner, trade.instructions, maxSol, tip);
      const got = (await this.rawBalance(owner, t.mint).catch(() => before + trade.expectedOutRaw)) - before;
      const qty = Number(got > 0n ? got : trade.expectedOutRaw) / 10 ** t.decimals;
      return this.recordLive(leg, t, ctx, qty, Number(amount) / 1e6, signature, " on the pump.fun curve");
    }

    const solBefore = BigInt(await this.connection.getBalance(owner));
    const usdcBefore = await this.rawBalance(owner, USDC_MINT);
    const trade = await pump.sell({ mint: t.mint, user, tokenAmountRaw: amount, slippagePct });
    const signature = await this.sendInstructions(owner, trade.instructions, 10_000_000 + tip, tip);
    const qty = Number(amount) / 10 ** t.decimals;
    let usd: number;
    let suffix = " on the pump.fun curve";
    if (curve.quote === "SOL") {
      const gained = BigInt(await this.connection.getBalance(owner)) - solBefore;
      const lamports = gained > 0n ? gained : trade.expectedOutRaw;
      try {
        const q = await this.quote(SOL_MINT, USDC_MINT, lamports, 100);
        await this.jupiterSwap(owner, q, SOL_MINT, lamports, 0);
        usd = Number(q.outAmount) / 1e6;
      } catch {
        const solPx = (await this.prices([SOL_MINT]).catch(() => new Map<string, number>())).get(SOL_MINT) ?? 0;
        usd = (Number(lamports) / 1e9) * solPx;
        suffix += ", kept the proceeds as SOL (swapping to USDC failed)";
      }
    } else {
      usd = Number((await this.rawBalance(owner, USDC_MINT)) - usdcBefore) / 1e6;
    }
    return this.recordLive(leg, t, ctx, qty, usd, signature, suffix);
  }

  private async sendInstructions(owner: PublicKey, instructions: TransactionInstruction[], maxSol: number, tip: number): Promise<string> {
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: tip ? 2_000_000 : 500_000 }), ...instructions];
    if (tip) ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(randomTipAccount()), lamports: tip }));
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
    return this.signAndSend(tx, maxSol, tip, lastValidBlockHeight);
  }

  /** Jito's block engine lands tipped transactions faster than plain RPC. We send to both. */
  private async sendToJito(txBase64: string): Promise<void> {
    await postJson(this.o.fetchFn, `${this.o.jitoUrl ?? "https://mainnet.block-engine.jito.wtf"}/api/v1/transactions`, {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [txBase64, { encoding: "base64" }],
    });
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

function randomTipAccount(): string {
  const all = [...JITO_TIP_ACCOUNTS];
  return all[Math.floor(Math.random() * all.length)]!;
}

function fmtQty(q: number): string {
  if (q >= 1000) return q.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (q >= 1) return q.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return q.toPrecision(4);
}
