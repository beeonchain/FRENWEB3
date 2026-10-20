import { shortDate, usd as fmtUsd, type PlanStep, type PredictionLeg, type ResolvedStep } from "@fren/core";
import type { Store } from "../store.js";
import { VenueError, type ExecContext, type ExecResult, type PositionView, type VenueAdapter } from "./types.js";

/**
 * Polymarket prediction markets. Each share of an outcome pays $1 if that
 * outcome wins and nothing if it loses, so a buy can lose at most what it cost.
 *
 * Market data and live trading go through two small interfaces so the venue
 * logic doesn't depend on Polymarket's SDK (see polymarket-sdk.ts for the real
 * ones, testing.ts for fakes).
 */

export interface PolyOutcome {
  label: string;
  /** Order-book asset id (CTF token id, or V2 position id). */
  assetId: string;
  /** Last price, 0 to 1. After resolution the winner is 1. */
  price: number | null;
}

export interface PolyMarket {
  slug: string;
  question: string;
  endDate: string | null;
  closed: boolean;
  acceptingOrders: boolean;
  /** True once the outcome is final and shares pay out. */
  resolved: boolean;
  outcomes: PolyOutcome[];
  /** How the market resolves, in Polymarket's words, when it says. */
  rules?: string;
}

export interface PolyLevel {
  price: number;
  size: number;
}

export interface PolyBook {
  /** Cheapest first. */
  asks: PolyLevel[];
  /** Highest first. */
  bids: PolyLevel[];
  minOrderSize: number;
}

export interface PolymarketData {
  search(query: string): Promise<PolyMarket[]>;
  market(slug: string): Promise<PolyMarket | null>;
  book(assetId: string): Promise<PolyBook>;
}

export interface PolyFill {
  shares: number;
  usd: number;
  txs: string[];
}

export interface PolyLivePosition {
  assetId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
}

/** Live trading on the owner's Polymarket deposit wallet. */
export interface PolymarketTrader {
  /** The deposit wallet that holds pUSD and shares. */
  wallet(): Promise<string>;
  /** True when Polymarket only lets this account close positions (region rules). */
  closedOnly(): Promise<boolean>;
  buy(req: { assetId: string; usd: number; maxPrice: number }): Promise<PolyFill>;
  sell(req: { assetId: string; shares: number; minPrice: number }): Promise<PolyFill>;
  positions(): Promise<PolyLivePosition[]>;
}

export interface PolymarketVenueOptions {
  store: Store;
  data: PolymarketData;
  /** Null until live Polymarket is set up (needs wallets). */
  trader: PolymarketTrader | null;
  /** Polymarket's own region check; true means this machine's IP may not trade. */
  geoblocked?: () => Promise<boolean>;
}

/** What fren_bet_quote shows for a Polymarket bet. */
export interface PredictionQuote {
  market: PolyMarket;
  outcome: PolyOutcome;
  /** Average price per share for the budget, walking the book. */
  avgPrice: number;
  shares: number;
  costUsd: number;
  /** "touch" markets pay if the price trades there at any moment; "close" markets check one moment. */
  kind: "touch" | "close" | "other";
}

const PAPER_PREFIX = "poly:";

/** Walk asks (buys) or bids (sells) to fill a USD budget or a share count. */
export function walkBook(levels: PolyLevel[], want: { usd?: number; shares?: number }, limit: number, side: "buy" | "sell") {
  let shares = 0;
  let usd = 0;
  for (const l of levels) {
    if (side === "buy" ? l.price > limit : l.price < limit) break;
    const roomShares = want.usd !== undefined ? (want.usd - usd) / l.price : (want.shares ?? 0) - shares;
    const take = Math.min(l.size, roomShares);
    if (take <= 0) break;
    shares += take;
    usd += take * l.price;
  }
  return { shares, usd, avgPrice: shares > 0 ? usd / shares : 0 };
}

const cents = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}¢`;
const fmtShares = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 });

export class PolymarketVenue implements VenueAdapter {
  readonly venue = "polymarket" as const;

  constructor(private readonly o: PolymarketVenueOptions) {}

  get data(): PolymarketData {
    return this.o.data;
  }

  private async market(slug: string): Promise<PolyMarket> {
    const m = await this.o.data.market(slug.trim());
    if (!m) throw new VenueError(`Polymarket has no market "${slug}". Use the slug from fren_bet_quote or fren_markets.`);
    return m;
  }

  private outcome(m: PolyMarket, label: string): PolyOutcome {
    const o = m.outcomes.find((x) => x.label.toLowerCase() === label.trim().toLowerCase());
    if (!o) throw new VenueError(`"${m.question}" has outcomes ${m.outcomes.map((x) => `"${x.label}"`).join(" and ")}, not "${label}".`);
    return o;
  }

  async resolve(step: PlanStep, index: number): Promise<ResolvedStep> {
    const leg = step.leg;
    if (leg.kind !== "prediction") throw new VenueError(`Polymarket cannot run a ${leg.kind} leg.`);
    const m = await this.market(leg.market);
    const out = this.outcome(m, leg.outcome);
    const notes: string[] = [];
    let spend = 0;
    if (leg.side === "buy") {
      if (m.closed || !m.acceptingOrders) throw new VenueError(`"${m.question}" isn't taking orders.`);
      if (leg.amount.type !== "usd") throw new VenueError('Say how much to bet: amount {type:"usd"}.');
      spend = leg.amount.usd;
      const book = await this.o.data.book(out.assetId);
      const fill = walkBook(book.asks, { usd: spend }, leg.limitPrice ?? 0.99, "buy");
      if (fill.shares <= 0) throw new VenueError(`Nobody is selling "${out.label}" at ${leg.limitPrice !== undefined ? `${cents(leg.limitPrice)} or less` : "any price"} right now.`);
      const ends = m.endDate ? ` It ends ${shortDate(new Date(m.endDate))}.` : "";
      notes.push(
        `About ${fmtShares(fill.shares)} shares at ${cents(fill.avgPrice)} on average: pays ${fmtUsd(fill.shares)} if "${out.label}" wins, nothing if it loses.${ends}`,
      );
      if (fill.usd < spend * 0.98) notes.push(`Only about ${fmtUsd(fill.usd)} is for sale at that price, so the bet may be smaller.`);
    }
    // Keep the outcome's label exactly as Polymarket spells it.
    const canonical = { ...step, leg: { ...leg, market: m.slug, outcome: out.label } } as PlanStep;
    return { index, step: canonical, symbol: m.question, spendUsd: spend, notionalUsd: spend, notes };
  }

  async execute(r: ResolvedStep, ctx: ExecContext): Promise<ExecResult> {
    const leg = r.step.leg;
    if (leg.kind !== "prediction") throw new VenueError(`Polymarket cannot run a ${leg.kind} leg.`);
    const m = await this.market(leg.market);
    const out = this.outcome(m, leg.outcome);
    return ctx.mode === "paper" ? this.paperTrade(leg, m, out, ctx) : this.liveTrade(leg, m, out, ctx);
  }

  // -- paper -----------------------------------------------------------------------

  private async paperTrade(leg: PredictionLeg, m: PolyMarket, out: PolyOutcome, ctx: ExecContext): Promise<ExecResult> {
    const store = this.o.store;
    const key = PAPER_PREFIX + out.assetId;
    const held = store.paperHolding(key) ?? { mint: key, symbol: `${out.label} · ${m.question}`, amount: 0, costUsd: 0 };
    const book = await this.o.data.book(out.assetId);
    if (leg.side === "buy") {
      const budget = leg.amount.type === "usd" ? leg.amount.usd : store.paperUsdc() * leg.amount.fraction;
      if (budget > store.paperUsdc()) throw new VenueError(`Paper balance is ${fmtUsd(store.paperUsdc())}.`);
      const fill = walkBook(book.asks, { usd: budget }, leg.limitPrice ?? 0.99, "buy");
      if (fill.shares <= 0) throw new VenueError(`Nobody is selling "${out.label}" at that price right now.`);
      store.setPaperUsdc(store.paperUsdc() - fill.usd);
      store.setPaperHolding({ ...held, amount: held.amount + fill.shares, costUsd: held.costUsd + fill.usd });
      store.setKv(`poly_market:${out.assetId}`, m.slug);
      store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "polymarket", symbol: held.symbol, action: "buy", size: fill.shares, price: fill.avgPrice, usd: fill.usd, spendUsd: fill.usd, mode: "paper" });
      return { text: `📝 Paper: Bought ${fmtShares(fill.shares)} "${out.label}" shares in "${m.question}" for ${fmtUsd(fill.usd)} at ${cents(fill.avgPrice)} each` };
    }
    const shares = leg.amount.type === "fraction" ? held.amount * leg.amount.fraction : Math.min(held.amount, leg.amount.usd / Math.max(book.bids[0]?.price ?? 1, 0.01));
    if (shares <= 0 || held.amount <= 0) throw new VenueError(`You hold no paper "${out.label}" shares in "${m.question}".`);
    const fill = walkBook(book.bids, { shares }, leg.limitPrice ?? 0.01, "sell");
    if (fill.shares <= 0) throw new VenueError(`Nobody is buying "${out.label}" at that price right now.`);
    store.setPaperUsdc(store.paperUsdc() + fill.usd);
    store.setPaperHolding({ ...held, amount: held.amount - fill.shares, costUsd: held.costUsd * (1 - fill.shares / held.amount) });
    store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "polymarket", symbol: held.symbol, action: "sell", size: fill.shares, price: fill.avgPrice, usd: fill.usd, spendUsd: 0, mode: "paper" });
    return { text: `📝 Paper: Sold ${fmtShares(fill.shares)} "${out.label}" shares in "${m.question}" for ${fmtUsd(fill.usd)} at ${cents(fill.avgPrice)} each` };
  }

  /** Resolved paper bets pay $1 a winning share. Returns one line per settled bet. */
  async settlePaper(): Promise<string[]> {
    const lines: string[] = [];
    for (const h of this.o.store.paperHoldings()) {
      if (!h.mint.startsWith(PAPER_PREFIX) || h.amount <= 0) continue;
      const assetId = h.mint.slice(PAPER_PREFIX.length);
      const slug = this.o.store.getKv(`poly_market:${assetId}`);
      if (!slug) continue;
      const m = await this.o.data.market(slug).catch(() => null);
      if (!m?.resolved) continue;
      const out = m.outcomes.find((o) => o.assetId === assetId);
      if (!out || out.price === null) continue;
      const payout = h.amount * out.price;
      this.o.store.setPaperUsdc(this.o.store.paperUsdc() + payout);
      this.o.store.setPaperHolding({ ...h, amount: 0, costUsd: 0 });
      this.o.store.insertFill({ planId: null, idx: null, venue: "polymarket", symbol: h.symbol, action: "settle", size: h.amount, price: out.price, usd: payout, spendUsd: 0, mode: "paper" });
      lines.push(
        out.price > 0
          ? `🏁 Paper: "${m.question}" resolved "${out.label}". Your ${fmtShares(h.amount)} shares paid ${fmtUsd(payout)} (cost ${fmtUsd(h.costUsd)}).`
          : `🏁 Paper: "${m.question}" resolved against "${out.label}". Lost ${fmtUsd(h.costUsd)}.`,
      );
    }
    return lines;
  }

  // -- live ------------------------------------------------------------------------

  /** The Polymarket deposit wallet funds go to. */
  async depositWallet(): Promise<string> {
    return this.trader().wallet();
  }

  private trader(): PolymarketTrader {
    if (!this.o.trader) throw new VenueError("Live Polymarket needs wallets. Run `fren init` first.");
    return this.o.trader;
  }

  private async liveTrade(leg: PredictionLeg, m: PolyMarket, out: PolyOutcome, ctx: ExecContext): Promise<ExecResult> {
    const trader = this.trader();
    if (leg.side === "buy") {
      const blocked = this.o.geoblocked
        ? await this.o.geoblocked().catch(() => {
            throw new VenueError("Couldn't reach Polymarket's region check, so Fren isn't placing the bet.");
          })
        : false;
      if (blocked) throw new VenueError("Polymarket doesn't allow new bets from this machine's location. Fren won't try to get around that.");
      if (await trader.closedOnly()) throw new VenueError("Polymarket only lets this account close positions, so Fren can't place new bets.");
    }
    let fill: PolyFill;
    if (leg.side === "buy") {
      const usd = leg.amount.type === "usd" ? leg.amount.usd : 0;
      fill = await trader.buy({ assetId: out.assetId, usd, maxPrice: leg.limitPrice ?? 0.99 });
    } else {
      const held = (await trader.positions()).find((p) => p.assetId === out.assetId)?.size ?? 0;
      if (held <= 0) throw new VenueError(`You hold no "${out.label}" shares in "${m.question}".`);
      const shares = leg.amount.type === "fraction" ? held * leg.amount.fraction : Math.min(held, leg.amount.usd / Math.max(out.price ?? 1, 0.01));
      fill = await trader.sell({ assetId: out.assetId, shares, minPrice: leg.limitPrice ?? 0.01 });
    }
    if (fill.shares <= 0) throw new VenueError("Nothing filled at that price, so nothing changed.");
    const avg = fill.usd / fill.shares;
    this.o.store.insertFill({
      planId: ctx.planId,
      idx: ctx.idx,
      venue: "polymarket",
      symbol: `${out.label} · ${m.question}`,
      action: leg.side,
      size: fill.shares,
      price: avg,
      usd: fill.usd,
      spendUsd: leg.side === "buy" ? fill.usd : 0,
      mode: "live",
      ...(fill.txs[0] ? { ref: fill.txs[0] } : {}),
    });
    const verb = leg.side === "buy" ? "Bought" : "Sold";
    const link = fill.txs[0] ? ` · https://polygonscan.com/tx/${fill.txs[0]}` : "";
    return { text: `✅ ${verb} ${fmtShares(fill.shares)} "${out.label}" shares in "${m.question}" for ${fmtUsd(fill.usd)} at ${cents(avg)} each${link}` };
  }

  async positions(mode: "paper" | "live"): Promise<PositionView[]> {
    if (mode === "paper") {
      const views: PositionView[] = [];
      for (const h of this.o.store.paperHoldings()) {
        if (!h.mint.startsWith(PAPER_PREFIX) || h.amount <= 0) continue;
        const book = await this.o.data.book(h.mint.slice(PAPER_PREFIX.length)).catch(() => null);
        const mark = book?.bids[0]?.price ?? null;
        const value = mark === null ? h.costUsd : h.amount * mark;
        views.push({ venue: "polymarket", symbol: h.symbol, kind: "spot", side: "hold", size: h.amount, entryPx: h.costUsd / h.amount, markPx: mark, valueUsd: value, pnlUsd: mark === null ? null : value - h.costUsd });
      }
      return views;
    }
    if (!this.o.trader) return [];
    return (await this.o.trader.positions()).map((p) => ({
      venue: "polymarket",
      symbol: `${p.outcome} · ${p.title}`,
      kind: "spot",
      side: "hold",
      size: p.size,
      entryPx: p.avgPrice,
      markPx: p.currentPrice,
      valueUsd: p.currentValue,
      pnlUsd: p.currentValue - p.size * p.avgPrice,
    }));
  }

  /**
   * The market that best matches "ASSET reaches TARGET by DATE". Prefers
   * "reach"/"hit" (touch) markets ending on or soon after the date.
   */
  async bestMarket(q: { assetNames: string[]; target: number; direction: "above" | "below"; by: Date; budgetUsd: number }): Promise<PredictionQuote | null> {
    const seen = new Map<string, PolyMarket>();
    for (const name of q.assetNames) {
      for (const query of [`${name} ${q.target}`, `${name} price`]) {
        for (const m of await this.o.data.search(query).catch(() => [])) seen.set(m.slug, m);
      }
    }
    const targetForms = numberForms(q.target);
    const words = q.direction === "above" ? /\b(reach|hit|above|over|exceed|high|at least|≥|>)/i : /\b(dip|drop|fall|below|under|low|≤|<)/i;
    const candidates = [...seen.values()].filter(
      (m) =>
        !m.closed &&
        m.acceptingOrders &&
        q.assetNames.some((n) => m.question.toLowerCase().includes(n.toLowerCase())) &&
        targetForms.some((f) => f.test(m.question)) &&
        words.test(m.question),
    );
    if (!candidates.length) return null;
    const by = q.by.getTime();
    const score = (m: PolyMarket) => {
      const end = m.endDate ? new Date(m.endDate).getTime() : Infinity;
      // Ending after the date costs a little; ending well before it misses part of the window.
      const gapDays = (end - by) / 86_400_000;
      return (gapDays >= -1 ? Math.abs(gapDays) : 100 + Math.abs(gapDays)) + (marketKind(m.question) === "touch" ? 0 : 5);
    };
    candidates.sort((a, b) => score(a) - score(b));
    for (const m of candidates.slice(0, 3)) {
      const yes = m.outcomes.find((o) => o.label.toLowerCase() === "yes") ?? m.outcomes[0];
      if (!yes) continue;
      const book = await this.o.data.book(yes.assetId).catch(() => null);
      if (!book) continue;
      const fill = walkBook(book.asks, { usd: q.budgetUsd }, 0.99, "buy");
      if (fill.shares <= 0) continue;
      return { market: m, outcome: yes, avgPrice: fill.avgPrice, shares: fill.shares, costUsd: fill.usd, kind: marketKind(m.question) };
    }
    return null;
  }

  /** Bets aren't leveraged; the kill switch leaves them. */
  async flatten(): Promise<string[]> {
    return [];
  }
}

export function marketKind(question: string): PredictionQuote["kind"] {
  if (/\b(reach|hit|touch|dip to|drop to|fall to)\b/i.test(question)) return "touch";
  if (/\b(above|below|over|under|close|settle|price of)\b/i.test(question)) return "close";
  return "other";
}

/** The ways a question might write 4000 ("4,000", "4000", "4k"), not matching inside 14,000 or 4,0001. */
function numberForms(n: number): RegExp[] {
  const forms = new Set([n.toLocaleString("en-US"), String(n)]);
  if (n >= 1000 && n % 1000 === 0) forms.add(`${n / 1000}k`);
  return [...forms].map((f) => new RegExp(`(?<![\\d.,])${f.replace(/[.,]/g, "\\$&")}(?!\\d|,\\d)`, "i"));
}
