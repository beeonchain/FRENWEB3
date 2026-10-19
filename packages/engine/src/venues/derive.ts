import {
  describeOption,
  parseOptionName,
  price as fmtPrice,
  shortDate,
  usd as fmtUsd,
  type OptionLeg,
  type PlanStep,
  type ResolvedStep,
} from "@fren/core";
import type { SignerApi } from "@fren/signer";
import { postJson, type Fetch } from "../http.js";
import type { Store } from "../store.js";
import { VenueError, type ExecContext, type ExecResult, type PositionView, type VenueAdapter } from "./types.js";

/**
 * Options on Derive (v3, settles on Ethereum). Fren only buys options and
 * sells ones it holds, so the most any option can lose is what was paid.
 *
 * Live trading uses a Derive session key that can only trade options: the
 * owner key registers it once (Derive needs an account first, which the
 * first deposit creates), and the signer builds every order action itself.
 */

export interface DeriveInstrument {
  instrument_name: string;
  is_active: boolean;
  base_asset_address: `0x${string}`;
  base_asset_sub_id: string;
  amount_step: string;
  minimum_amount: string;
  tick_size: string;
  taker_fee_rate: string;
  base_fee: string;
  mark_price_fee_rate_cap?: string | null;
  risk_universe_id?: number;
  option_details?: { expiry: number; strike: string; option_type: string; index: string; settlement_price?: string | null } | null;
}

export interface DeriveTicker {
  /** Best ask and bid prices, and their sizes. "0" when the side is empty. */
  a: string;
  b: string;
  A: string;
  B: string;
  /** Mark and index (spot) prices. */
  M: string;
  I: string;
}

interface DeriveOrderResult {
  order: { order_id: string; filled_amount: string; average_price: string; order_fee: string; order_status: string };
  trades: { trade_id: string; tx_hash?: string | null }[];
}

export interface DeriveVenueOptions {
  fetchFn: Fetch;
  apiUrl: string;
  isTestnet: boolean;
  store: Store;
  signer: SignerApi | null;
  /** Spot price of an underlying, for settling paper options when Derive has no settlement price yet. */
  spotPrice?: (asset: string) => Promise<number | null>;
}

/** What fren_bet_quote shows for an option. */
export interface OptionQuote {
  instrument: string;
  ask: number;
  contracts: number;
  costUsd: number;
  strike: number;
  type: "call" | "put";
  expiry: Date;
  spot: number;
  /** Underlying price where the option pays back exactly its cost. */
  breakEven: number;
}

const PAPER_PREFIX = "derive:";

const num = (s: string | null | undefined) => (s === null || s === undefined || s === "" ? 0 : Number(s));
/** Round down to a multiple of step, as a clean decimal string Derive accepts. */
function floorStep(x: number, step: number): number {
  const n = Math.floor(x / step + 1e-9);
  return Number((n * step).toFixed(12));
}
function ceilStep(x: number, step: number): number {
  const n = Math.ceil(x / step - 1e-9);
  return Number((n * step).toFixed(12));
}
const dec = (x: number) => x.toFixed(12).replace(/\.?0+$/, "");

export class DeriveVenue implements VenueAdapter {
  readonly venue = "derive" as const;
  private optionCache = new Map<string, { at: number; list: DeriveInstrument[] }>();

  constructor(private readonly o: DeriveVenueOptions) {}

  private async rpc<T>(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}): Promise<T> {
    const res = await postJson<{ result?: T; error?: { code: number; message: string; data?: unknown } }>(
      this.o.fetchFn,
      `${this.o.apiUrl}/${method}`,
      params,
      headers,
    );
    if (res.error) throw new VenueError(`Derive: ${res.error.message}${res.error.data ? ` (${JSON.stringify(res.error.data)})` : ""}`);
    if (res.result === undefined) throw new VenueError(`Derive returned nothing for ${method}.`);
    return res.result;
  }

  // -- market data -------------------------------------------------------------

  /** Live options on one underlying, cached for a minute. */
  async options(asset: string): Promise<DeriveInstrument[]> {
    const key = asset.toUpperCase();
    const hit = this.optionCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const res = await this.rpc<{ instruments: DeriveInstrument[] }>("public/get_all_instruments", {
      instrument_type: "option",
      expired: false,
      currency: key,
      page_size: 1000,
    });
    const list = res.instruments.filter((i) => i.is_active && i.option_details);
    this.optionCache.set(key, { at: Date.now(), list });
    return list;
  }

  async instrument(name: string): Promise<DeriveInstrument> {
    const opt = parseOptionName(name);
    const cached = opt ? (await this.options(opt.asset).catch(() => [])).find((i) => i.instrument_name === name) : undefined;
    return cached ?? this.rpc<DeriveInstrument>("public/get_instrument", { instrument_name: name });
  }

  ticker(name: string): Promise<DeriveTicker> {
    return this.rpc<DeriveTicker>("public/get_ticker", { instrument_name: name });
  }

  /**
   * The option that best matches "ASSET above TARGET by DATE": a call (put for
   * "below") at the listed strike nearest the target, expiring on or just
   * before the date (the first expiry after it when none is before).
   */
  async bestOption(q: { asset: string; target: number; direction: "above" | "below"; by: Date; budgetUsd: number }): Promise<OptionQuote | null> {
    const type = q.direction === "above" ? "C" : "P";
    const list = (await this.options(q.asset)).filter((i) => i.option_details!.option_type === type);
    if (!list.length) return null;
    const expiries = [...new Set(list.map((i) => i.option_details!.expiry))].sort((a, b) => a - b);
    const bySec = q.by.getTime() / 1000;
    const before = expiries.filter((e) => e <= bySec + 86_400);
    const expiry = before.at(-1) ?? expiries.find((e) => e > bySec);
    if (expiry === undefined) return null;
    const atExpiry = list.filter((i) => i.option_details!.expiry === expiry);
    atExpiry.sort((a, b) => Math.abs(num(a.option_details!.strike) - q.target) - Math.abs(num(b.option_details!.strike) - q.target));
    for (const inst of atExpiry.slice(0, 3)) {
      const t = await this.ticker(inst.instrument_name).catch(() => null);
      const ask = num(t?.a);
      if (!t || ask <= 0) continue;
      const contracts = floorStep(q.budgetUsd / ask, num(inst.amount_step));
      if (contracts < num(inst.minimum_amount)) continue;
      const strike = num(inst.option_details!.strike);
      return {
        instrument: inst.instrument_name,
        ask,
        contracts,
        costUsd: contracts * ask,
        strike,
        type: type === "C" ? "call" : "put",
        expiry: new Date(expiry * 1000),
        spot: num(t.I),
        breakEven: type === "C" ? strike + ask : strike - ask,
      };
    }
    return null;
  }

  // -- plan steps ----------------------------------------------------------------

  async resolve(step: PlanStep, index: number): Promise<ResolvedStep> {
    const leg = step.leg;
    if (leg.kind !== "option") throw new VenueError(`Derive cannot run a ${leg.kind} leg.`);
    const name = parseOptionName(leg.instrument);
    if (!name) throw new VenueError(`${leg.instrument} isn't a Derive option name.`);
    const inst = await this.instrument(leg.instrument).catch(() => null);
    if (!inst || !inst.is_active) throw new VenueError(`Derive has no live option ${leg.instrument}. Ask fren_bet_quote for one that trades.`);
    if (name.expiry.getTime() <= Date.now()) throw new VenueError(`${leg.instrument} has expired.`);

    const notes: string[] = [];
    let spend = 0;
    if (leg.side === "buy") {
      if (leg.amount.type !== "usd") throw new VenueError('Say how much to spend on an option: amount {type:"usd"}.');
      spend = leg.amount.usd;
      const t = await this.ticker(leg.instrument);
      const ask = num(t.a);
      if (ask <= 0) throw new VenueError(`Nobody is selling ${describeOption(leg.instrument)} right now. Try another strike or expiry.`);
      const contracts = floorStep(spend / ask, num(inst.amount_step));
      if (contracts < num(inst.minimum_amount)) {
        throw new VenueError(
          `${fmtUsd(spend)} buys ${contracts} contracts at ${fmtPrice(ask)}; Derive's minimum is ${inst.minimum_amount} (about ${fmtUsd(num(inst.minimum_amount) * ask)}).`,
        );
      }
      notes.push(payoffNote(name.asset, name.type, name.strike, name.expiry, ask, contracts));
    }
    return { index, step, symbol: leg.instrument, spendUsd: spend, notionalUsd: spend, notes };
  }

  async execute(r: ResolvedStep, ctx: ExecContext): Promise<ExecResult> {
    const leg = r.step.leg;
    if (leg.kind !== "option") throw new VenueError(`Derive cannot run a ${leg.kind} leg.`);
    const inst = await this.instrument(leg.instrument);
    const t = await this.ticker(leg.instrument);
    return ctx.mode === "paper" ? this.paperTrade(leg, inst, t, ctx) : this.liveTrade(leg, inst, t, ctx);
  }

  /** Derive's taker fee per contract, capped as a share of the option's price. */
  private feePerContract(inst: DeriveInstrument, px: number, spot: number): number {
    const cap = num(inst.mark_price_fee_rate_cap) || 0.125;
    return Math.min(num(inst.taker_fee_rate) * spot, cap * px);
  }

  // -- paper -----------------------------------------------------------------------

  private paperTrade(leg: OptionLeg, inst: DeriveInstrument, t: DeriveTicker, ctx: ExecContext): ExecResult {
    const store = this.o.store;
    const key = PAPER_PREFIX + leg.instrument;
    const held = store.paperHolding(key) ?? { mint: key, symbol: leg.instrument, amount: 0, costUsd: 0 };
    const what = describeOption(leg.instrument);
    const step = num(inst.amount_step);
    if (leg.side === "buy") {
      const ask = num(t.a);
      if (ask <= 0) throw new VenueError(`Nobody is selling ${what} right now.`);
      const budget = leg.amount.type === "usd" ? leg.amount.usd : store.paperUsdc() * leg.amount.fraction;
      const perContract = ask + this.feePerContract(inst, ask, num(t.I));
      const contracts = floorStep((budget - num(inst.base_fee)) / perContract, step);
      if (contracts < num(inst.minimum_amount)) throw new VenueError(`${fmtUsd(budget)} is under Derive's minimum for ${what}.`);
      const cost = contracts * perContract + num(inst.base_fee);
      if (cost > store.paperUsdc()) throw new VenueError(`Paper balance is ${fmtUsd(store.paperUsdc())}.`);
      store.setPaperUsdc(store.paperUsdc() - cost);
      store.setPaperHolding({ ...held, amount: held.amount + contracts, costUsd: held.costUsd + cost });
      store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "derive", symbol: leg.instrument, action: "buy", size: contracts, price: ask, usd: cost, spendUsd: cost, mode: "paper" });
      return { text: `📝 Paper: Bought ${dec(contracts)} contracts of the ${what} for ${fmtUsd(cost)} (${fmtPrice(ask)} each plus fees)` };
    }
    const bid = num(t.b);
    if (bid <= 0) throw new VenueError(`Nobody is buying ${what} right now.`);
    const want = leg.amount.type === "fraction" ? held.amount * leg.amount.fraction : leg.amount.usd / bid;
    const contracts = Math.min(held.amount, floorStep(want, step));
    if (contracts <= 0) throw new VenueError(`You hold no paper ${what}.`);
    const proceeds = Math.max(0, contracts * (bid - this.feePerContract(inst, bid, num(t.I))) - num(inst.base_fee));
    store.setPaperUsdc(store.paperUsdc() + proceeds);
    store.setPaperHolding({ ...held, amount: held.amount - contracts, costUsd: held.costUsd * (1 - contracts / held.amount) });
    store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "derive", symbol: leg.instrument, action: "sell", size: contracts, price: bid, usd: proceeds, spendUsd: 0, mode: "paper" });
    return { text: `📝 Paper: Sold ${dec(contracts)} contracts of the ${what} for ${fmtUsd(proceeds)} (${fmtPrice(bid)} each less fees)` };
  }

  /**
   * Expired paper options pay their intrinsic value in USDC, like Derive's
   * cash settlement. Returns one line per settled option.
   */
  async settlePaper(now = new Date()): Promise<string[]> {
    const lines: string[] = [];
    for (const h of this.o.store.paperHoldings()) {
      if (!h.mint.startsWith(PAPER_PREFIX)) continue;
      const name = h.mint.slice(PAPER_PREFIX.length);
      const o = parseOptionName(name);
      if (!o || o.expiry.getTime() > now.getTime()) continue;
      const inst = await this.rpc<DeriveInstrument>("public/get_instrument", { instrument_name: name }).catch(() => null);
      let settle = num(inst?.option_details?.settlement_price);
      if (!settle) {
        // Derive posts the settlement price shortly after 08:00 UTC; give it an hour before using spot.
        if (now.getTime() - o.expiry.getTime() < 3_600_000) continue;
        settle = (await this.o.spotPrice?.(o.asset).catch(() => null)) ?? 0;
        if (!settle) continue;
      }
      const intrinsic = Math.max(0, o.type === "call" ? settle - o.strike : o.strike - settle);
      const payout = intrinsic * h.amount;
      this.o.store.setPaperUsdc(this.o.store.paperUsdc() + payout);
      this.o.store.setPaperHolding({ ...h, amount: 0, costUsd: 0 });
      this.o.store.insertFill({ planId: null, idx: null, venue: "derive", symbol: name, action: "settle", size: h.amount, price: intrinsic, usd: payout, spendUsd: 0, mode: "paper" });
      const pnl = payout - h.costUsd;
      lines.push(
        payout > 0
          ? `🏁 Paper: ${describeOption(name)} settled at ${fmtPrice(settle)}. Paid ${fmtUsd(payout)} on ${dec(h.amount)} contracts (${pnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(pnl))}).`
          : `🏁 Paper: ${describeOption(name)} expired worthless (${o.asset} settled at ${fmtPrice(settle)}). Lost ${fmtUsd(h.costUsd)}.`,
      );
    }
    return lines;
  }

  // -- live --------------------------------------------------------------------------

  private signer(): SignerApi {
    if (!this.o.signer) throw new VenueError("Live trading needs wallets. Run `fren init` first.");
    return this.o.signer;
  }

  private async owner(): Promise<`0x${string}`> {
    return (await this.signer().addresses()).evm;
  }

  /** The Derive subaccount Fren trades from. The first deposit creates it. */
  async subaccount(): Promise<number | null> {
    const saved = this.o.store.getKv("derive_subaccount");
    if (saved) return Number(saved);
    const res = await this.rpc<{ subaccount_ids: number[] }>("private/get_subaccounts", { wallet: await this.owner() }, await this.sessionHeaders());
    const id = res.subaccount_ids[0];
    if (id === undefined) return null;
    this.o.store.setKv("derive_subaccount", String(id));
    return id;
  }

  private async sessionHeaders(): Promise<Record<string, string>> {
    await this.ensureSessionKey();
    return this.signer().deriveAuthHeaders({ isTestnet: this.o.isTestnet });
  }

  /** Register (or renew) Fren's option-only session key. Needs the Derive account to exist. */
  private async ensureSessionKey(): Promise<void> {
    const until = Number(this.o.store.getKv("derive_session_until") ?? 0);
    if (until > Date.now() / 1000 + 86_400) return;
    const reg = await this.signer().deriveRegisterSessionKey({ isTestnet: this.o.isTestnet });
    try {
      await this.rpc("private/set_session_key", reg.params, reg.headers);
    } catch (err) {
      throw new VenueError(`Couldn't set up Fren's Derive trading key: ${(err as Error).message}. If you haven't funded Derive yet, say "fund Derive with $X" first.`);
    }
    this.o.store.setKv("derive_session_until", String(reg.params.expiry_sec));
  }

  private async liveTrade(leg: OptionLeg, inst: DeriveInstrument, t: DeriveTicker, ctx: ExecContext): Promise<ExecResult> {
    const subaccountId = await this.subaccount();
    if (subaccountId === null) throw new VenueError('No Derive account yet. Say "fund Derive with $X" to create one.');
    const what = describeOption(leg.instrument);
    const step = num(inst.amount_step);
    const tick = num(inst.tick_size);
    const slip = leg.maxSlippagePct / 100;
    let limitPrice: number;
    let amount: number;
    if (leg.side === "buy") {
      const ask = num(t.a);
      if (ask <= 0) throw new VenueError(`Nobody is selling ${what} right now.`);
      limitPrice = floorStep(ask * (1 + slip), tick);
      const budget = leg.amount.type === "usd" ? leg.amount.usd : 0;
      amount = floorStep(budget / limitPrice, step);
      if (amount < num(inst.minimum_amount)) throw new VenueError(`${fmtUsd(budget)} is under Derive's minimum for ${what}.`);
    } else {
      const bid = num(t.b);
      if (bid <= 0) throw new VenueError(`Nobody is buying ${what} right now.`);
      limitPrice = Math.max(tick, ceilStep(bid * (1 - slip), tick));
      const held = await this.liveContracts(subaccountId, leg.instrument);
      if (held <= 0) throw new VenueError(`You hold no ${what} on Derive. Fren only sells options it holds.`);
      const want = leg.amount.type === "fraction" ? held * leg.amount.fraction : leg.amount.usd / bid;
      amount = Math.min(held, floorStep(want, step));
      if (amount <= 0) throw new VenueError(`That's less than one tradeable unit of ${what}.`);
    }
    // Same bound Derive's SDK signs by default: a taker fee at three times the
    // rate (room for the index to move) plus the base fee over a small fill.
    const feeBasis = Math.max(num(t.I), limitPrice);
    const maxFee = 3 * feeBasis * num(inst.taker_fee_rate) + num(inst.base_fee) / Math.max(step, amount / 1000);
    const sig = await this.signer().deriveSignOrder({
      isTestnet: this.o.isTestnet,
      subaccountId,
      assetAddress: inst.base_asset_address,
      subId: inst.base_asset_sub_id,
      direction: leg.side,
      amount: dec(amount),
      limitPrice: dec(limitPrice),
      maxFee: maxFee.toFixed(6),
    });
    const res = await this.rpc<DeriveOrderResult>(
      "private/order",
      {
        subaccount_id: subaccountId,
        instrument_name: leg.instrument,
        direction: leg.side,
        limit_price: dec(limitPrice),
        amount: dec(amount),
        max_fee: maxFee.toFixed(6),
        nonce: sig.nonce,
        signer: sig.signer,
        signature: sig.signature,
        signature_expiry_sec: sig.signatureExpirySec,
        order_type: "limit",
        time_in_force: "ioc",
        label: "fren",
      },
      await this.sessionHeaders(),
    );
    const filled = num(res.order.filled_amount);
    if (filled <= 0) {
      const side = leg.side === "buy" ? `up to ${fmtPrice(limitPrice)}` : `${fmtPrice(limitPrice)} or better`;
      throw new VenueError(`Nothing filled at ${side} per contract, so nothing changed. The price moved; ask again for a fresh quote.`);
    }
    const avg = num(res.order.average_price);
    const fee = num(res.order.order_fee);
    const usd = leg.side === "buy" ? filled * avg + fee : filled * avg - fee;
    this.o.store.insertFill({
      planId: ctx.planId,
      idx: ctx.idx,
      venue: "derive",
      symbol: leg.instrument,
      action: leg.side,
      size: filled,
      price: avg,
      usd,
      spendUsd: leg.side === "buy" ? usd : 0,
      mode: "live",
      ref: res.order.order_id,
    });
    const verb = leg.side === "buy" ? "Bought" : "Sold";
    const partial = filled < amount ? ` (${dec(amount)} asked; the rest wasn't available at that price)` : "";
    return { text: `✅ ${verb} ${dec(filled)} contracts of the ${what} for ${fmtUsd(usd)} at ${fmtPrice(avg)} each on Derive${partial}` };
  }

  private async livePositions(subaccountId: number) {
    const res = await this.rpc<{ positions: { instrument_name: string; instrument_type: string; amount: string; average_price: string; mark_price: string; mark_value: string; unrealized_pnl: string }[] }>(
      "private/get_positions",
      { subaccount_id: subaccountId },
      await this.sessionHeaders(),
    );
    return res.positions.filter((p) => p.instrument_type === "option" && num(p.amount) !== 0);
  }

  private async liveContracts(subaccountId: number, instrument: string): Promise<number> {
    return num((await this.livePositions(subaccountId)).find((p) => p.instrument_name === instrument)?.amount);
  }

  async positions(mode: "paper" | "live"): Promise<PositionView[]> {
    if (mode === "paper") {
      const views: PositionView[] = [];
      for (const h of this.o.store.paperHoldings()) {
        if (!h.mint.startsWith(PAPER_PREFIX) || h.amount <= 0) continue;
        const mark = await this.ticker(h.symbol).then((t) => num(t.M) || null, () => null);
        const value = mark === null ? h.costUsd : h.amount * mark;
        views.push({ venue: "derive", symbol: describeOption(h.symbol), kind: "spot", side: "hold", size: h.amount, entryPx: h.costUsd / h.amount, markPx: mark, valueUsd: value, pnlUsd: mark === null ? null : value - h.costUsd });
      }
      return views;
    }
    if (!this.o.signer || !this.o.store.getKv("derive_subaccount")) return [];
    const positions = await this.livePositions(Number(this.o.store.getKv("derive_subaccount")));
    return positions.map((p) => ({
      venue: "derive",
      symbol: describeOption(p.instrument_name),
      kind: "spot",
      side: "hold",
      size: num(p.amount),
      entryPx: num(p.average_price),
      markPx: num(p.mark_price),
      valueUsd: num(p.mark_value),
      pnlUsd: num(p.unrealized_pnl),
    }));
  }

  /** Derive takes deposits in USDC on Ethereum (Sepolia on testnet). */
  get depositToken(): { chainId: number; usdc: string } {
    return this.o.isTestnet
      ? { chainId: 11_155_111, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" }
      : { chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" };
  }

  /** Where to send USDC on Ethereum to fund Derive. The first deposit creates the account. */
  async depositAddress(): Promise<string> {
    const wallet = await this.owner();
    const sub = this.o.store.getKv("derive_subaccount");
    let params: Record<string, unknown>;
    if (sub) params = { wallet, subaccount_id: Number(sub) };
    else {
      // A new account goes under the standard-margin manager of the risk universe ETH options trade in.
      const eth = (await this.options("ETH"))[0];
      const universes = await this.rpc<{ risk_universe_id: number; managers: { manager_id: number; margin_type: string; collaterals: { name: string }[] }[] }[]>(
        "public/get_risk_universes",
        {},
      );
      const u = universes.find((x) => x.risk_universe_id === eth?.risk_universe_id) ?? universes[0];
      const m = u?.managers.find((x) => x.margin_type === "SM" && x.collaterals.some((c) => /USDC/i.test(c.name))) ?? u?.managers.find((x) => x.margin_type === "SM");
      if (!m) throw new VenueError("Derive didn't list a standard account type to open.");
      params = { wallet, manager_id: m.manager_id };
    }
    return (await this.rpc<{ deposit_address: string }>("public/register_deposit_address", params)).deposit_address;
  }

  /** Options aren't leveraged here (Fren only holds long options), so the kill switch leaves them. */
  async flatten(): Promise<string[]> {
    return [];
  }
}

function payoffNote(asset: string, type: "call" | "put", strike: number, expiry: Date, ask: number, contracts: number): string {
  const side = type === "call" ? "above" : "below";
  const be = type === "call" ? strike + ask : strike - ask;
  return (
    `Pays ${fmtUsd(contracts)} for every $1 ${asset} is ${side} ${fmtPrice(strike)} at 08:00 UTC on ${shortDate(expiry)} (break-even ${fmtPrice(be)}). ` +
    `If ${asset} is ${type === "call" ? "at or below" : "at or above"} ${fmtPrice(strike)} then, it expires worthless and the premium is gone.`
  );
}
