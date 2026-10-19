import { canonicalize } from "@nktkas/hyperliquid/signing";
import { OrderRequest, UpdateLeverageRequest } from "@nktkas/hyperliquid/api/exchange";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { price as fmtPrice, signedUsd, usd as fmtUsd, type PerpCloseLeg, type PerpOpenLeg, type PlanStep, type ResolvedStep } from "@jarvis/core";
import type { SignerApi } from "@jarvis/signer";
import { postJson, type Fetch } from "../http.js";
import type { Store } from "../store.js";
import { HyperliquidMarkets, type PerpMarket } from "./hyperliquid-markets.js";
import { VenueError, type ExecContext, type ExecResult, type PositionView, type VenueAdapter } from "./types.js";

type OrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: "Ioc" | "Gtc" | "Alo" } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
};

export interface PerpOrderPlan {
  isBuy: boolean;
  size: string;
  notionalUsd: number;
  orders: OrderWire[];
  grouping: "na" | "normalTpsl";
  stopPx: number | null;
  takeProfitPx: number | null;
}

/**
 * Turn a perp_open leg into Hyperliquid order wires. Market orders are IOC
 * limits at mid ± slippage, which is how Hyperliquid's own UI does it.
 * Stops and targets are reduce-only trigger orders attached to the entry.
 */
export function buildPerpOpenOrders(m: PerpMarket, leg: PerpOpenLeg, mid: number): PerpOrderPlan {
  const isBuy = leg.side === "long";
  const margin = leg.sizing.type === "margin" ? leg.sizing.usd : leg.sizing.usd / leg.leverage;
  const notional = margin * leg.leverage;
  const size = formatSize(notional / mid, m.szDecimals);
  if (Number(size) <= 0) throw new VenueError(`${fmtUsd(notional)} is below the smallest ${m.name} order.`);
  const slip = leg.maxSlippagePct / 100;
  const limitPx = formatPrice(mid * (isBuy ? 1 + slip : 1 - slip), m.szDecimals, "perp");
  const orders: OrderWire[] = [{ a: m.assetId, b: isBuy, p: limitPx, s: size, r: false, t: { limit: { tif: "Ioc" } } }];

  const dir = isBuy ? 1 : -1;
  const stopPx =
    leg.stopPrice ?? (leg.stopLossPct !== undefined ? mid * (1 - (dir * leg.stopLossPct) / 100 / leg.leverage) : null);
  const takeProfitPx =
    leg.takeProfitPrice ?? (leg.takeProfitPct !== undefined ? mid * (1 + (dir * leg.takeProfitPct) / 100 / leg.leverage) : null);

  if (stopPx !== null) {
    if ((isBuy && stopPx >= mid) || (!isBuy && stopPx <= mid)) throw new VenueError(`Stop ${fmtPrice(stopPx)} is on the wrong side of the price.`);
    orders.push(trigger(m, !isBuy, size, stopPx, "sl"));
  }
  if (takeProfitPx !== null) {
    if ((isBuy && takeProfitPx <= mid) || (!isBuy && takeProfitPx >= mid)) {
      throw new VenueError(`Take profit ${fmtPrice(takeProfitPx)} is on the wrong side of the price.`);
    }
    orders.push(trigger(m, !isBuy, size, takeProfitPx, "tp"));
  }
  return { isBuy, size, notionalUsd: Number(size) * mid, orders, grouping: orders.length > 1 ? "normalTpsl" : "na", stopPx, takeProfitPx };
}

function trigger(m: PerpMarket, isBuy: boolean, size: string, px: number, tpsl: "tp" | "sl"): OrderWire {
  // Market trigger: the limit is only a slippage bound, so give it 10% room.
  const limit = formatPrice(px * (isBuy ? 1.1 : 0.9), m.szDecimals, "perp");
  return { a: m.assetId, b: isBuy, p: limit, s: size, r: true, t: { trigger: { isMarket: true, triggerPx: formatPrice(px, m.szDecimals, "perp"), tpsl } } };
}

interface OrderResponse {
  status: "ok" | "err";
  response:
    | string
    | { type: "order"; data: { statuses: ({ filled: { totalSz: string; avgPx: string; oid: number } } | { resting: { oid: number } } | { error: string } | string)[] } }
    | { type: string };
}

interface ClearinghouseState {
  marginSummary: { accountValue: string };
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      liquidationPx: string | null;
      marginUsed: string;
    };
  }[];
}

export interface HyperliquidVenueOptions {
  fetchFn: Fetch;
  apiUrl: string;
  isTestnet: boolean;
  store: Store;
  /** Null when running paper-only without keys. */
  signer: SignerApi | null;
}

export class HyperliquidVenue implements VenueAdapter {
  readonly venue = "hyperliquid" as const;
  readonly markets: HyperliquidMarkets;

  constructor(private readonly o: HyperliquidVenueOptions) {
    this.markets = new HyperliquidMarkets(o.fetchFn, o.apiUrl);
  }

  private async market(symbol: string): Promise<PerpMarket> {
    const m = await this.markets.get(symbol);
    if (!m) {
      const near = (await this.markets.search(symbol, 4)).map((x) => x.name);
      throw new VenueError(
        `No Hyperliquid market called ${symbol}.${near.length ? ` Closest: ${near.join(", ")}.` : " Search with jarvis_markets."}`,
      );
    }
    return m;
  }

  async resolve(step: PlanStep, index: number): Promise<ResolvedStep> {
    const leg = step.leg;
    if (leg.kind !== "perp_open" && leg.kind !== "perp_close") throw new VenueError(`Hyperliquid cannot run a ${leg.kind} leg.`);
    const m = await this.market(leg.market);
    // Store the canonical symbol on the leg so the watcher and signer see the same thing.
    const canonical = { ...step, leg: { ...leg, market: m.name } } as PlanStep;
    if (leg.kind === "perp_close") {
      return { index, step: canonical, symbol: m.name, spendUsd: 0, notionalUsd: 0 };
    }
    const margin = leg.sizing.type === "margin" ? leg.sizing.usd : leg.sizing.usd / leg.leverage;
    return {
      index,
      step: canonical,
      symbol: m.name,
      spendUsd: margin,
      notionalUsd: margin * leg.leverage,
      venueMaxLeverage: m.maxLeverage,
    };
  }

  async execute(r: ResolvedStep, ctx: ExecContext): Promise<ExecResult> {
    const leg = r.step.leg;
    if (leg.kind === "perp_open") return ctx.mode === "paper" ? this.paperOpen(leg, ctx) : this.liveOpen(leg, ctx);
    if (leg.kind === "perp_close") return ctx.mode === "paper" ? this.paperClose(leg, ctx) : this.liveClose(leg, ctx);
    throw new VenueError(`Hyperliquid cannot run a ${leg.kind} leg.`);
  }

  // -- paper -----------------------------------------------------------------

  private paperOpen(leg: PerpOpenLeg, ctx: ExecContext): Promise<ExecResult> {
    return this.market(leg.market).then((m) => {
      const store = this.o.store;
      const plan = buildPerpOpenOrders(m, leg, m.midPx);
      const margin = plan.notionalUsd / leg.leverage;
      if (store.paperUsdc() < margin) throw new VenueError(`Paper balance is ${fmtUsd(store.paperUsdc())}; this needs ${fmtUsd(margin)}.`);
      const existing = store.paperPosition(m.name);
      if (existing && existing.side !== leg.side) throw new VenueError(`You have a paper ${existing.side} on ${m.name}; close it first.`);
      const size = Number(plan.size);
      const merged = existing
        ? {
            ...existing,
            size: existing.size + size,
            entry: (existing.entry * existing.size + m.midPx * size) / (existing.size + size),
            margin: existing.margin + margin,
            leverage: leg.leverage,
          }
        : { symbol: m.name, side: leg.side, size, entry: m.midPx, margin, leverage: leg.leverage, stopPrice: null, takeProfitPrice: null };
      merged.stopPrice = plan.stopPx ?? merged.stopPrice;
      merged.takeProfitPrice = plan.takeProfitPx ?? merged.takeProfitPrice;
      store.upsertPaperPosition(merged);
      store.setPaperUsdc(store.paperUsdc() - margin);
      store.insertFill({
        planId: ctx.planId,
        idx: ctx.idx,
        venue: "hyperliquid",
        symbol: m.name,
        action: `open_${leg.side}`,
        size,
        price: m.midPx,
        usd: plan.notionalUsd,
        spendUsd: margin,
        mode: "paper",
      });
      return { text: `📝 Paper ${describeFill(leg.side, m.name, size, m.midPx, plan)}` };
    });
  }

  private async paperClose(leg: PerpCloseLeg, ctx: ExecContext): Promise<ExecResult> {
    const m = await this.market(leg.market);
    const text = this.paperCloseAt(m.name, m.midPx, leg.fraction, ctx, "Closed");
    return { text };
  }

  /** Close a paper position at a price. Also used by the watcher for paper stops, targets and liquidations. */
  paperCloseAt(symbol: string, px: number, fraction: number, ctx: ExecContext, verb: string): string {
    const store = this.o.store;
    const pos = store.paperPosition(symbol);
    if (!pos) throw new VenueError(`No paper position on ${symbol}.`);
    const size = pos.size * fraction;
    const pnl = (px - pos.entry) * size * (pos.side === "long" ? 1 : -1);
    const marginBack = pos.margin * fraction;
    store.setPaperUsdc(store.paperUsdc() + Math.max(0, marginBack + pnl));
    if (fraction >= 1) store.deletePaperPosition(symbol);
    else store.upsertPaperPosition({ ...pos, size: pos.size - size, margin: pos.margin - marginBack });
    store.insertFill({ planId: ctx.planId, idx: ctx.idx, venue: "hyperliquid", symbol, action: `close_${pos.side}`, size, price: px, usd: size * px, spendUsd: 0, mode: "paper" });
    return `📝 Paper: ${verb} ${fraction >= 1 ? "" : `${Math.round(fraction * 100)}% of `}${pos.side} ${symbol} at ${fmtPrice(px)}, PnL ${signedUsd(pnl)}`;
  }

  // -- live ------------------------------------------------------------------

  private signer(): SignerApi {
    if (!this.o.signer) throw new VenueError("Live trading needs wallets. Run `jarvis init` first.");
    return this.o.signer;
  }

  private async send(action: Record<string, unknown>): Promise<OrderResponse> {
    const nonce = Date.now();
    const signature = await this.signer().hlSignL1({ action, nonce, isTestnet: this.o.isTestnet });
    const res = await postJson<OrderResponse>(this.o.fetchFn, `${this.o.apiUrl}/exchange`, { action, nonce, signature });
    if (res.status !== "ok") throw new VenueError(`Hyperliquid refused: ${typeof res.response === "string" ? res.response : JSON.stringify(res.response)}`);
    return res;
  }

  /** Approve our trading-only key on the account once per network. */
  async ensureAgent(): Promise<void> {
    const key = `hl_agent_approved_${this.o.isTestnet ? "testnet" : "mainnet"}`;
    if (this.o.store.getKv(key) === "1") return;
    const { action, signature, nonce } = await this.signer().hlApproveAgent({ isTestnet: this.o.isTestnet });
    const res = await postJson<OrderResponse>(this.o.fetchFn, `${this.o.apiUrl}/exchange`, { action, nonce, signature });
    if (res.status !== "ok") {
      const msg = typeof res.response === "string" ? res.response : JSON.stringify(res.response);
      throw new VenueError(`Could not enable trading on Hyperliquid: ${msg}. Deposit USDC to your Hyperliquid account first.`);
    }
    this.o.store.setKv(key, "1");
  }

  private async liveOpen(leg: PerpOpenLeg, ctx: ExecContext): Promise<ExecResult> {
    await this.ensureAgent();
    const m = await this.market(leg.market);
    await this.send(
      canonicalize(UpdateLeverageRequest.entries.action, {
        type: "updateLeverage",
        asset: m.assetId,
        isCross: !m.isolatedOnly,
        leverage: leg.leverage,
      }),
    );
    const plan = buildPerpOpenOrders(m, leg, m.midPx);
    const res = await this.send(canonicalize(OrderRequest.entries.action, { type: "order", orders: plan.orders, grouping: plan.grouping }));
    const fill = firstFill(res);
    const size = Number(fill.totalSz);
    const px = Number(fill.avgPx);
    this.o.store.insertFill({
      planId: ctx.planId,
      idx: ctx.idx,
      venue: "hyperliquid",
      symbol: m.name,
      action: `open_${leg.side}`,
      size,
      price: px,
      usd: size * px,
      spendUsd: (size * px) / leg.leverage,
      mode: "live",
      ref: String(fill.oid),
    });
    return { text: `✅ ${describeFill(leg.side, m.name, size, px, plan)}` };
  }

  private async clearinghouse(dex: string): Promise<ClearinghouseState> {
    const { evm } = await this.signer().addresses();
    return this.markets.info<ClearinghouseState>({ type: "clearinghouseState", user: evm, ...(dex ? { dex } : {}) });
  }

  private async liveClose(leg: PerpCloseLeg, ctx: ExecContext): Promise<ExecResult> {
    const m = await this.market(leg.market);
    const state = await this.clearinghouse(m.dex);
    const pos = state.assetPositions.find((p) => p.position.coin.toUpperCase() === m.name.toUpperCase());
    const szi = pos ? Number(pos.position.szi) : 0;
    if (!pos || szi === 0) throw new VenueError(`No open ${m.name} position on Hyperliquid.`);
    const isBuy = szi < 0;
    const size = formatSize(Math.abs(szi) * leg.fraction, m.szDecimals);
    const slip = leg.maxSlippagePct / 100;
    const limitPx = formatPrice(m.midPx * (isBuy ? 1 + slip : 1 - slip), m.szDecimals, "perp");
    const res = await this.send(
      canonicalize(OrderRequest.entries.action, {
        type: "order",
        orders: [{ a: m.assetId, b: isBuy, p: limitPx, s: size, r: true, t: { limit: { tif: "Ioc" } } }],
        grouping: "na",
      }),
    );
    const fill = firstFill(res);
    const px = Number(fill.avgPx);
    const closed = Number(fill.totalSz);
    const pnl = (px - Number(pos.position.entryPx)) * closed * (szi > 0 ? 1 : -1);
    this.o.store.insertFill({
      planId: ctx.planId,
      idx: ctx.idx,
      venue: "hyperliquid",
      symbol: m.name,
      action: szi > 0 ? "close_long" : "close_short",
      size: closed,
      price: px,
      usd: closed * px,
      spendUsd: 0,
      mode: "live",
      ref: String(fill.oid),
    });
    return { text: `✅ Closed ${closed} ${m.name} at ${fmtPrice(px)}, PnL about ${signedUsd(pnl)}` };
  }

  async positions(mode: "paper" | "live"): Promise<PositionView[]> {
    if (mode === "paper") {
      const markets = await this.markets.all().catch(() => [] as PerpMarket[]);
      return this.o.store.paperPositions().map((p) => {
        const mark = markets.find((m) => m.name === p.symbol)?.markPx ?? null;
        const pnl = mark === null ? null : (mark - p.entry) * p.size * (p.side === "long" ? 1 : -1);
        return { venue: "hyperliquid", symbol: p.symbol, kind: "perp", side: p.side, size: p.size, entryPx: p.entry, markPx: mark, valueUsd: p.margin + (pnl ?? 0), pnlUsd: pnl };
      });
    }
    if (!this.o.signer) return [];
    const dexes = [...new Set((await this.markets.all()).map((m) => m.dex))];
    const states = await Promise.all(dexes.map((d) => this.clearinghouse(d)));
    const markets = await this.markets.all();
    return states.flatMap((s) =>
      s.assetPositions
        .filter((p) => Number(p.position.szi) !== 0)
        .map((p) => {
          const szi = Number(p.position.szi);
          return {
            venue: "hyperliquid" as const,
            symbol: p.position.coin,
            kind: "perp" as const,
            side: szi > 0 ? ("long" as const) : ("short" as const),
            size: Math.abs(szi),
            entryPx: Number(p.position.entryPx),
            markPx: markets.find((m) => m.name === p.position.coin)?.markPx ?? null,
            valueUsd: Number(p.position.marginUsed) + Number(p.position.unrealizedPnl),
            pnlUsd: Number(p.position.unrealizedPnl),
            liquidationPx: p.position.liquidationPx ? Number(p.position.liquidationPx) : null,
          };
        }),
    );
  }

  async accountValueUsd(): Promise<number | null> {
    if (!this.o.signer) return null;
    const dexes = [...new Set((await this.markets.all()).map((m) => m.dex))];
    const states = await Promise.all(dexes.map((d) => this.clearinghouse(d)));
    return states.reduce((sum, s) => sum + Number(s.marginSummary.accountValue), 0);
  }

  async flatten(mode: "paper" | "live"): Promise<string[]> {
    const ctx: ExecContext = { mode, planId: null, idx: null };
    const out: string[] = [];
    for (const p of await this.positions(mode)) {
      try {
        const leg: PerpCloseLeg = { kind: "perp_close", venue: "hyperliquid", market: p.symbol, fraction: 1, maxSlippagePct: 2 };
        out.push((mode === "paper" ? await this.paperClose(leg, ctx) : await this.liveClose(leg, ctx)).text);
      } catch (err) {
        out.push(`❌ Could not close ${p.symbol}: ${(err as Error).message}`);
      }
    }
    return out;
  }
}

function firstFill(res: OrderResponse) {
  const r = res.response;
  if (typeof r === "string" || r.type !== "order") throw new VenueError(`Unexpected Hyperliquid response: ${JSON.stringify(r)}`);
  const s = (r as Extract<OrderResponse["response"], { type: "order" }>).data.statuses[0];
  if (s && typeof s === "object" && "filled" in s) return s.filled;
  if (s && typeof s === "object" && "error" in s) throw new VenueError(`Hyperliquid: ${s.error}`);
  throw new VenueError(`Order did not fill immediately (${JSON.stringify(s)}). Nothing was opened.`);
}

function describeFill(side: string, symbol: string, size: number, px: number, plan: PerpOrderPlan): string {
  const exits: string[] = [];
  if (plan.stopPx !== null) exits.push(`stop ${fmtPrice(plan.stopPx)}`);
  if (plan.takeProfitPx !== null) exits.push(`target ${fmtPrice(plan.takeProfitPx)}`);
  return `${side === "long" ? "Longed" : "Shorted"} ${size} ${symbol} at ${fmtPrice(px)} (${fmtUsd(size * px)})${exits.length ? `, ${exits.join(", ")}` : ""}`;
}
