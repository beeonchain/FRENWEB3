import { usd as fmtUsd, yieldProtocolName, type EarnLeg, type PlanStep, type ResolvedStep, type YieldProtocol } from "@fren/core";
import type { Mode, Store } from "../store.js";
import { VenueError, type ExecContext, type ExecResult, type PositionView, type VenueAdapter } from "./types.js";

/**
 * "Put my idle USDC to work": lend it on Jupiter Lend or Kamino (Solana), or
 * Aave (Arbitrum, Base), wherever the rate is best, and take it back on its
 * own when a trade needs the cash. Every protocol pays back to the same wallet.
 */

/** Where a protocol's USDC lives, which is also where withdrawals land. */
export type CashChain = "solana" | "arbitrum" | "base";

export interface YieldProtocolAdapter {
  readonly id: YieldProtocol;
  readonly chain: CashChain;
  /** Current supply APY in percent (4.5 means 4.5% a year). */
  apy(): Promise<number>;
  /** Live: USDC the owner has lent here, interest included. */
  deposited(): Promise<number>;
  /** Live: lend this much USDC from the wallet. Returns a link to the transaction. */
  deposit(usd: number): Promise<string>;
  /** Live: take back this much USDC (or everything) to the wallet. Returns what came back and a link. */
  withdraw(usd: number | "all"): Promise<{ usd: number; link: string }>;
}

export interface YieldVenueOptions {
  store: Store;
  protocols: YieldProtocolAdapter[];
  /** Live USDC in the wallet on a chain, for deposits by fraction and for "best" picking. */
  walletUsdc: (chain: CashChain) => Promise<number>;
}

export interface YieldRate {
  id: YieldProtocol;
  name: string;
  chain: CashChain;
  apy: number | null;
  depositedUsd: number;
}

const PAPER_PREFIX = "yield:";
const YEAR_MS = 365 * 86_400_000;
const pct = (x: number) => `${x.toFixed(2)}%`;

export class YieldVenue implements VenueAdapter {
  readonly venue = "yield" as const;

  constructor(private readonly o: YieldVenueOptions) {}

  private protocol(id: YieldProtocol): YieldProtocolAdapter {
    const p = this.o.protocols.find((x) => x.id === id);
    if (!p) throw new VenueError(`${yieldProtocolName[id] ?? id} isn't set up.`);
    return p;
  }

  private async apy(p: YieldProtocolAdapter): Promise<number | null> {
    return p.apy().then(
      (x) => (Number.isFinite(x) ? x : null),
      () => null,
    );
  }

  /** Every protocol's rate and what the owner has there, best rate first. */
  async rates(mode: Mode): Promise<YieldRate[]> {
    const rows = await Promise.all(
      this.o.protocols.map(async (p) => ({
        id: p.id,
        name: yieldProtocolName[p.id] ?? p.id,
        chain: p.chain,
        apy: await this.apy(p),
        depositedUsd: await this.deposited(p, mode).catch(() => 0),
      })),
    );
    return rows.sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1));
  }

  async ratesText(mode: Mode): Promise<string> {
    const rows = await this.rates(mode);
    const lines = ["USDC lending rates now:"];
    for (const r of rows) {
      const held = r.depositedUsd > 0.005 ? ` · you have ${fmtUsd(r.depositedUsd)} here` : "";
      lines.push(`• ${r.name}: ${r.apy === null ? "rate unavailable" : pct(r.apy)}${held}`);
    }
    const total = rows.reduce((s, r) => s + r.depositedUsd, 0);
    lines.push("", total > 0.005 ? `Lent out in total: ${fmtUsd(total)}.` : "Nothing lent out yet.");
    lines.push("Rates move with demand; these are variable, not fixed.");
    return lines.join("\n");
  }

  private async deposited(p: YieldProtocolAdapter, mode: Mode): Promise<number> {
    if (mode === "paper") return this.paperBalance(p.id);
    return p.deposited();
  }

  // -- plan steps ----------------------------------------------------------------

  /** Which protocol a deposit goes to: the one named, or the best rate where the money is. */
  private async pick(leg: EarnLeg, mode: Mode): Promise<{ p: YieldProtocolAdapter; apy: number | null; usd: number }> {
    if (leg.action !== "deposit") throw new Error("pick is for deposits");
    const rates = await this.rates(mode);
    const candidates = leg.protocol ? rates.filter((r) => r.id === leg.protocol) : rates.filter((r) => r.apy !== null);
    if (!candidates.length) throw new VenueError("Couldn't get a lending rate from any protocol right now.");
    for (const r of candidates) {
      const cash = mode === "paper" ? this.o.store.paperUsdc() : await this.o.walletUsdc(r.chain).catch(() => 0);
      const usd = leg.amount.type === "usd" ? leg.amount.usd : cash * leg.amount.fraction;
      // A named protocol is tried as asked; "best" skips chains without the cash.
      if (leg.protocol || cash >= usd) return { p: this.protocol(r.id), apy: r.apy, usd };
    }
    const want = leg.amount.type === "usd" ? fmtUsd(leg.amount.usd) : "that";
    throw new VenueError(`No chain has ${want} of USDC to lend. Fund Solana, Arbitrum or Base first.`);
  }

  async resolve(step: PlanStep, index: number): Promise<ResolvedStep> {
    const mode = this.o.store.getLimits().mode;
    const leg = step.leg;
    if (leg.kind !== "earn") throw new VenueError(`Yield cannot run a ${leg.kind} leg.`);
    if (leg.action === "deposit") {
      const { p, apy, usd } = await this.pick(leg, mode);
      if (!(usd > 0)) throw new VenueError("There's no USDC to lend.");
      const notes = [
        `Earns about ${apy === null ? "an unknown rate" : pct(apy)} a year on ${fmtUsd(usd)}, variable. You can take it back any time; Fren also takes it back on its own when a trade needs the cash.`,
      ];
      const canonical = { ...step, leg: { ...leg, protocol: p.id } } as PlanStep;
      return { index, step: canonical, symbol: yieldProtocolName[p.id] ?? p.id, spendUsd: 0, notionalUsd: usd, movesUsd: usd, notes };
    }
    const where = leg.protocol ? yieldProtocolName[leg.protocol] : "your yield";
    return { index, step, symbol: where ?? "your yield", spendUsd: 0, notionalUsd: 0 };
  }

  async execute(r: ResolvedStep, ctx: ExecContext): Promise<ExecResult> {
    const leg = r.step.leg;
    if (leg.kind !== "earn") throw new VenueError(`Yield cannot run a ${leg.kind} leg.`);
    if (leg.action === "deposit") {
      const p = this.protocol(leg.protocol ?? (await this.pick(leg, ctx.mode)).p.id);
      return ctx.mode === "paper" ? this.paperDeposit(p, leg, ctx) : this.liveDeposit(p, leg, ctx);
    }
    const lines = await this.withdrawFrom(leg.protocol ? [this.protocol(leg.protocol)] : this.o.protocols, leg, ctx);
    if (!lines.length) throw new VenueError(`You have nothing lent out${leg.protocol ? ` on ${yieldProtocolName[leg.protocol]}` : ""}.`);
    return { text: lines.join("\n") };
  }

  private async withdrawFrom(ps: YieldProtocolAdapter[], leg: EarnLeg, ctx: ExecContext): Promise<string[]> {
    const held = await Promise.all(ps.map(async (p) => ({ p, usd: await this.deposited(p, ctx.mode).catch(() => 0) })));
    const total = held.reduce((s, h) => s + h.usd, 0);
    let want = leg.amount.type === "usd" ? leg.amount.usd : total * leg.amount.fraction;
    const all = leg.amount.type === "fraction" && leg.amount.fraction >= 1;
    if (leg.amount.type === "usd" && want > total + 0.01) {
      throw new VenueError(`You have ${fmtUsd(total)} lent out, less than ${fmtUsd(want)}.`);
    }
    const lines: string[] = [];
    // Take from the biggest position first so a withdrawal touches as few protocols as possible.
    for (const h of held.sort((a, b) => b.usd - a.usd)) {
      if (h.usd <= 0.005 || (want <= 0.005 && !all)) continue;
      const take = all || want >= h.usd - 0.01 ? "all" : want;
      const got = ctx.mode === "paper" ? this.paperWithdraw(h.p, take, ctx) : await this.liveWithdraw(h.p, take, ctx);
      want -= got.usd;
      lines.push(got.text);
    }
    return lines;
  }

  // -- paper ---------------------------------------------------------------------

  /** Paper deposits grow at the protocol's live rate, compounded continuously, since they were last touched. */
  private paperBalance(id: YieldProtocol, now = Date.now()): number {
    const h = this.o.store.paperHolding(PAPER_PREFIX + id);
    if (!h || h.amount <= 0) return 0;
    const since = Number(this.o.store.getKv(`yield_at:${id}`) ?? now);
    const apy = Number(this.o.store.getKv(`yield_apy:${id}`) ?? 0);
    return h.amount * Math.exp((Math.log1p(apy / 100) * (now - since)) / YEAR_MS);
  }

  /** Fold accrued interest into the holding and restart the clock at the current rate. */
  private async paperTouch(p: YieldProtocolAdapter): Promise<{ amount: number; costUsd: number }> {
    const amount = this.paperBalance(p.id);
    const h = this.o.store.paperHolding(PAPER_PREFIX + p.id);
    const apy = await this.apy(p);
    this.o.store.setKv(`yield_at:${p.id}`, String(Date.now()));
    this.o.store.setKv(`yield_apy:${p.id}`, String(apy ?? 0));
    return { amount, costUsd: h?.costUsd ?? 0 };
  }

  private async paperDeposit(p: YieldProtocolAdapter, leg: EarnLeg, ctx: ExecContext): Promise<ExecResult> {
    const store = this.o.store;
    const usd = leg.amount.type === "usd" ? leg.amount.usd : store.paperUsdc() * leg.amount.fraction;
    if (usd > store.paperUsdc() + 1e-9) throw new VenueError(`Paper balance is ${fmtUsd(store.paperUsdc())}.`);
    const cur = await this.paperTouch(p);
    store.setPaperUsdc(store.paperUsdc() - usd);
    const name = yieldProtocolName[p.id] ?? p.id;
    store.setPaperHolding({ mint: PAPER_PREFIX + p.id, symbol: name, amount: cur.amount + usd, costUsd: cur.costUsd + usd });
    store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "yield", symbol: name, action: "deposit", size: usd, price: 1, usd, spendUsd: 0, mode: "paper" });
    const apy = Number(store.getKv(`yield_apy:${p.id}`) ?? 0);
    return { text: `📝 Paper: Lent ${fmtUsd(usd)} USDC on ${name} at ${pct(apy)} a year` };
  }

  private paperWithdraw(p: YieldProtocolAdapter, take: number | "all", ctx: ExecContext): { usd: number; text: string } {
    const store = this.o.store;
    const bal = this.paperBalance(p.id);
    const usd = take === "all" ? bal : Math.min(take, bal);
    const h = store.paperHolding(PAPER_PREFIX + p.id)!;
    const name = yieldProtocolName[p.id] ?? p.id;
    // Interest earned so far is what's above the remaining cost basis.
    const left = bal - usd;
    const costLeft = bal > 0 ? h.costUsd * (left / bal) : 0;
    const earned = usd - (h.costUsd - costLeft);
    store.setPaperHolding({ ...h, amount: left < 0.000001 ? 0 : left, costUsd: left < 0.000001 ? 0 : costLeft });
    store.setKv(`yield_at:${p.id}`, String(Date.now()));
    store.setPaperUsdc(store.paperUsdc() + usd);
    store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "yield", symbol: name, action: "withdraw", size: usd, price: 1, usd, spendUsd: 0, mode: "paper" });
    const interest = earned > 0.005 ? `, including ${fmtUsd(earned)} of interest` : "";
    return { usd, text: `📝 Paper: Took ${fmtUsd(usd)} USDC back from ${name}${interest}` };
  }

  // -- live ----------------------------------------------------------------------

  private async liveDeposit(p: YieldProtocolAdapter, leg: EarnLeg, ctx: ExecContext): Promise<ExecResult> {
    const cash = await this.o.walletUsdc(p.chain);
    const usd = leg.amount.type === "usd" ? leg.amount.usd : Math.floor(cash * leg.amount.fraction * 1e6) / 1e6;
    if (usd > cash + 1e-6) throw new VenueError(`Your wallet has ${fmtUsd(cash)} USDC on ${chainLabel[p.chain]}; this needs ${fmtUsd(usd)}.`);
    const link = await p.deposit(usd);
    const name = yieldProtocolName[p.id] ?? p.id;
    this.o.store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "yield", symbol: name, action: "deposit", size: usd, price: 1, usd, spendUsd: 0, mode: "live", ref: link });
    const apy = await this.apy(p);
    return { text: `✅ Lent ${fmtUsd(usd)} USDC on ${name}${apy === null ? "" : ` at ${pct(apy)} a year`} · ${link}` };
  }

  private async liveWithdraw(p: YieldProtocolAdapter, take: number | "all", ctx: ExecContext): Promise<{ usd: number; text: string }> {
    const got = await p.withdraw(take);
    const name = yieldProtocolName[p.id] ?? p.id;
    this.o.store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "yield", symbol: name, action: "withdraw", size: got.usd, price: 1, usd: got.usd, spendUsd: 0, mode: "live", ref: got.link });
    return { usd: got.usd, text: `✅ Took ${fmtUsd(got.usd)} USDC back from ${name} · ${got.link}` };
  }

  /**
   * Before a trade spends `usd` from `where`, take back from lending whatever
   * the wallet is short. Returns a line saying so, or null when nothing moved.
   */
  async ensureCash(where: CashChain | "evm" | "paper", usd: number, mode: Mode): Promise<string | null> {
    const ctx: ExecContext = { mode, planId: null, idx: null };
    if (mode === "paper" || where === "paper") {
      const short = usd - this.o.store.paperUsdc();
      if (short <= 0) return null;
      const lines = await this.withdrawFrom(this.o.protocols, { kind: "earn", venue: "yield", action: "withdraw", amount: { type: "usd", usd: Math.min(short * 1.001, this.paperTotal()) } }, ctx);
      return lines.length ? `↩️ Not enough idle USDC, so first:\n${lines.join("\n")}` : null;
    }
    const chains: CashChain[] = where === "evm" ? ["arbitrum", "base"] : [where];
    const cash = await Promise.all(chains.map((c) => this.o.walletUsdc(c).catch(() => 0)));
    if (cash.some((c) => c >= usd)) return null;
    // Top up the chain that is closest to covering it from what's lent out there.
    for (const [i, chain] of chains.entries()) {
      const ps = this.o.protocols.filter((p) => p.chain === chain);
      const lent = (await Promise.all(ps.map((p) => p.deposited().catch(() => 0)))).reduce((s, x) => s + x, 0);
      const short = usd - cash[i]!;
      if (lent + 0.005 < short) continue;
      // A little extra so interest rounding or fees don't leave the trade a cent short.
      const amount = Math.min(lent, short * 1.002 + 0.01);
      const lines = await this.withdrawFrom(ps, { kind: "earn", venue: "yield", action: "withdraw", amount: { type: "usd", usd: amount } }, ctx);
      return `↩️ Not enough idle USDC on ${chainLabel[chain]}, so first:\n${lines.join("\n")}`;
    }
    return null;
  }

  private paperTotal(): number {
    return this.o.protocols.reduce((s, p) => s + this.paperBalance(p.id), 0);
  }

  async positions(mode: Mode): Promise<PositionView[]> {
    const views: PositionView[] = [];
    for (const p of this.o.protocols) {
      const usd = await this.deposited(p, mode).catch(() => 0);
      if (usd <= 0.005) continue;
      const cost = mode === "paper" ? (this.o.store.paperHolding(PAPER_PREFIX + p.id)?.costUsd ?? usd) : null;
      views.push({
        venue: "yield",
        symbol: yieldProtocolName[p.id] ?? p.id,
        kind: "spot",
        side: "hold",
        size: usd,
        entryPx: null,
        markPx: null,
        valueUsd: usd,
        pnlUsd: cost === null ? null : usd - cost,
      });
    }
    return views;
  }

  /** Lending isn't leveraged; the kill switch leaves it. */
  async flatten(): Promise<string[]> {
    return [];
  }
}

const chainLabel: Record<CashChain, string> = { solana: "Solana", arbitrum: "Arbitrum", base: "Base" };
