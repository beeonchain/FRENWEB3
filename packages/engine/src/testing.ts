import type { SignerApi } from "@fren/signer";
import { encodeAbiParameters } from "viem";
import { Fren } from "./engine.js";
import type { Fetch } from "./http.js";
import { MemoryNotifier } from "./notify.js";
import { Store } from "./store.js";
import { HyperliquidVenue } from "./venues/hyperliquid.js";
import { JupiterVenue } from "./venues/jupiter.js";
import type { PumpCurve, PumpFunApi, PumpTrade } from "./venues/pumpfun.js";
import { RelayVenue } from "./venues/relay.js";
import { AaveUsdc } from "./venues/aave.js";
import { JupiterLendUsdc, KAMINO_USDC_RESERVE, KaminoUsdc, type SolanaAccess } from "./venues/solana-lend.js";
import { USDC_MINT } from "./venues/jupiter.js";
import { YieldVenue } from "./venues/yield.js";
import { DeriveVenue, type DeriveInstrument, type DeriveTicker } from "./venues/derive.js";
import {
  PolymarketVenue,
  type PolyBook,
  type PolyFill,
  type PolyLivePosition,
  type PolyMarket,
  type PolymarketData,
  type PolymarketTrader,
} from "./venues/polymarket.js";

/**
 * A fake of the Hyperliquid and Jupiter HTTP APIs, good enough to drive the
 * engine end to end in tests without network access.
 */
export interface FakeMarket {
  name: string;
  mid: number;
  maxLeverage: number;
  szDecimals?: number;
  fundingHourly?: number;
}

export interface FakeToken {
  id: string;
  symbol: string;
  name?: string;
  decimals?: number;
  isVerified?: boolean;
  usdPrice: number;
  liquidity?: number;
}

export interface FakeEvmToken {
  chainId: number;
  address: string;
  symbol: string;
  name?: string;
  decimals?: number;
  verified?: boolean;
  price: number;
}

export const RELAY_APPROVAL_PROXY = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
export const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";
export const BASE_DOG = "0x1111111111111111111111111111111111111111";
export const RH_FROG = "0x2222222222222222222222222222222222222222";

/** A Derive option name expiring a number of days from now, e.g. "ETH-20261225-4000-C". */
export function optionName(asset: string, daysOut: number, strike: number, type: "C" | "P" = "C", now = Date.now()): string {
  const d = new Date(now + daysOut * 86_400_000);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${asset}-${ymd}-${strike}-${type}`;
}

function fakeInstrument(name: string): DeriveInstrument {
  const [, ymd, strike, type] = name.split("-") as [string, string, string, string];
  const expiry = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)), 8) / 1000;
  return {
    instrument_name: name,
    is_active: true,
    base_asset_address: "0x4BB4C3CDc7562f08e9910A0C7D8bB7e108861eB4",
    base_asset_sub_id: "39614081257132168796771975168",
    amount_step: "0.01",
    minimum_amount: "0.01",
    tick_size: "0.1",
    taker_fee_rate: "0.0003",
    base_fee: "0.5",
    mark_price_fee_rate_cap: "0.125",
    risk_universe_id: 1,
    option_details: { expiry, strike, option_type: type, index: "ETH-USD", settlement_price: null },
  };
}

export class FakeVenues {
  main: FakeMarket[] = [
    { name: "BTC", mid: 100_000, maxLeverage: 40, szDecimals: 5 },
    { name: "ETH", mid: 4_000, maxLeverage: 25, szDecimals: 4 },
    { name: "SOL", mid: 200, maxLeverage: 20, szDecimals: 2, fundingHourly: 0.0001 },
  ];
  builder: Record<string, FakeMarket[]> = {
    xyz: [{ name: "xyz:GOLD", mid: 4_000, maxLeverage: 20, szDecimals: 3 }],
  };
  tokens: FakeToken[] = [
    { id: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter", decimals: 6, isVerified: true, usdPrice: 1, liquidity: 1e7 },
    { id: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Wrapped SOL", decimals: 9, isVerified: true, usdPrice: 200, liquidity: 1e9 },
    { id: "PumpCoin1111111111111111111111111111111pump", symbol: "SHIT", name: "Shitter", decimals: 6, isVerified: false, usdPrice: 0.0001, liquidity: 5e4 },
    { id: "PumpCoin2222222222222222222222222222222pump", symbol: "SHIT", name: "Other Shitter", decimals: 6, isVerified: false, usdPrice: 0.0002, liquidity: 1e3 },
  ];
  /** Tokens Jupiter can't route (yet): quotes for these fail like a real "no route". */
  jupUnroutable = new Set<string>();
  evmTokens: FakeEvmToken[] = [
    { chainId: 8453, address: BASE_DOG, symbol: "DOG", name: "Base Dog", decimals: 18, verified: false, price: 0.01 },
    { chainId: 8453, address: "0x3333333333333333333333333333333333333333", symbol: "BRETT", name: "Brett", decimals: 18, verified: true, price: 0.05 },
    { chainId: 4663, address: RH_FROG, symbol: "FROG", name: "Robin Frog", decimals: 18, verified: false, price: 0.002 },
  ];
  /** Every Relay quote request body. */
  relayQuotes: Record<string, unknown>[] = [];
  /** Replace to make Relay hand back other transactions (e.g. a malicious target). */
  relaySteps: (body: Record<string, unknown>) => unknown[] = (body) => [
    {
      id: "approve",
      kind: "transaction",
      items: [
        {
          status: "incomplete",
          data: {
            from: body.user,
            to: body.originCurrency,
            // An "unlimited" approval, like many routers ask for. Fren must shrink it.
            data: `0x095ea7b3${RELAY_APPROVAL_PROXY.slice(2).padStart(64, "0")}${"f".repeat(64)}`,
            value: "0",
            chainId: body.originChainId,
          },
        },
      ],
    },
    {
      id: "deposit",
      kind: "transaction",
      requestId: "0xreq1",
      items: [{ status: "incomplete", data: { from: body.user, to: RELAY_ROUTER, data: "0xdeadbeef", value: "0", chainId: body.originChainId } }],
    },
  ];
  /** Every POST body sent to /exchange. */
  exchange: Record<string, unknown>[] = [];
  /** What /exchange returns for orders. */
  orderStatus: (action: Record<string, unknown>) => unknown = (action) => {
    const orders = action.orders as { s: string; p: string }[];
    return { filled: { totalSz: orders[0]!.s, avgPx: orders[0]!.p, oid: 42 } };
  };

  /** Derive: listed options and their tickers, by name. */
  deriveTickers = new Map<string, DeriveTicker>();
  deriveInstruments = new Map<string, DeriveInstrument>();
  /** Subaccounts the fake Derive account has (empty until funded). */
  deriveSubaccounts: number[] = [];
  derivePositions: { instrument_name: string; amount: string }[] = [];
  /** Every Derive call: method and body, with the auth headers it carried. */
  deriveCalls: { method: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  /** How much of an order the fake Derive fills (1 = all). */
  deriveFillRatio = 1;

  /** Lending: rates, the wallet's idle Solana USDC, and what's lent where. */
  jupLendRateBps = 569;
  kaminoSupplyApy = 0.0468;
  /** Aave's currentLiquidityRate in ray (1e27 = 100% APR). */
  aaveRateRay = 45n * 10n ** 24n;
  solanaUsdc = 0;
  jupLent = 0;
  kaminoLent = 0;
  /** Every lending API call that built a transaction. */
  lendCalls: { path: string; body: Record<string, unknown> }[] = [];

  private lend(url: URL, body: Record<string, unknown>): unknown {
    const p = url.pathname;
    if (url.hostname === "lend.test") {
      if (p === "/earn/tokens") return [{ address: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", assetAddress: USDC_MINT, decimals: 6, totalRate: String(this.jupLendRateBps) }];
      if (p === "/earn/positions") {
        const owner = url.searchParams.get("users")!;
        return [{ token: { address: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", assetAddress: USDC_MINT, decimals: 6, totalRate: "0" }, ownerAddress: owner, shares: String(Math.round(this.jupLent * 0.94 * 1e6)), underlyingAssets: String(Math.round(this.jupLent * 1e6)) }];
      }
      this.lendCalls.push({ path: p, body });
      const amt = p === "/earn/redeem" ? this.jupLent : Number(body.amount) / 1e6;
      if (p === "/earn/deposit") {
        this.jupLent += amt;
        this.solanaUsdc -= amt;
      } else {
        this.jupLent -= amt;
        this.solanaUsdc += amt;
      }
      return { transaction: `jup-tx-${this.lendCalls.length}` };
    }
    if (p.endsWith("/reserves/metrics")) return [{ reserve: "SmallUsdcReserve111111111111111111111111111", liquidityTokenMint: USDC_MINT, supplyApy: "0.5" }, { reserve: KAMINO_USDC_RESERVE, liquidityTokenMint: USDC_MINT, supplyApy: String(this.kaminoSupplyApy) }];
    if (p.endsWith("/obligations")) return this.kaminoLent > 0 ? [{ obligationAddress: "Obligation1", state: { deposits: [{ depositReserve: KAMINO_USDC_RESERVE }] } }] : [];
    if (p === "/klend/loans/Obligation1") return { loanInfo: { collateral: { deposits: [{ tokenMint: USDC_MINT, tokenAmount: String(this.kaminoLent) }] } } };
    this.lendCalls.push({ path: p, body });
    const amt = Number(body.amount);
    if (p === "/ktx/klend/deposit") {
      this.kaminoLent += amt;
      this.solanaUsdc -= amt;
    } else {
      this.kaminoLent -= amt;
      this.solanaUsdc += amt;
    }
    return { transaction: `kamino-tx-${this.lendCalls.length}` };
  }

  addOption(name: string, quote: { ask: number; bid: number; spot: number }) {
    this.deriveInstruments.set(name, fakeInstrument(name));
    this.deriveTickers.set(name, { a: String(quote.ask), b: String(quote.bid), A: "100", B: "100", M: String((quote.ask + quote.bid) / 2), I: String(quote.spot) });
  }

  settleOption(name: string, price: number) {
    const i = this.deriveInstruments.get(name);
    if (!i?.option_details) throw new Error(`no fake option ${name}`);
    i.option_details.settlement_price = String(price);
  }

  private derive(method: string, body: Record<string, unknown>, headers: Record<string, string>): unknown {
    this.deriveCalls.push({ method, body, headers });
    const ok = (result: unknown) => ({ result });
    const err = (message: string) => ({ error: { code: -32000, message } });
    const authed = () => Boolean(headers["X-DeriveWallet"] && headers["X-DeriveSignature"]);
    switch (method) {
      case "public/get_all_instruments":
        return ok({ instruments: [...this.deriveInstruments.values()].filter((i) => i.instrument_name.startsWith(`${String(body.currency)}-`)) });
      case "public/get_instrument": {
        const i = this.deriveInstruments.get(String(body.instrument_name));
        return i ? ok(i) : err("Instrument not found");
      }
      case "public/get_ticker": {
        const t = this.deriveTickers.get(String(body.instrument_name));
        return t ? ok(t) : err("Instrument not found");
      }
      case "public/get_risk_universes":
        return ok([{ risk_universe_id: 1, managers: [{ manager_id: 7, margin_type: "SM", collaterals: [{ name: "USDC" }] }] }]);
      case "public/register_deposit_address":
        return ok({ deposit_address: "0xde9051700000000000000000000000000000beef" });
      case "private/set_session_key":
        return this.deriveSubaccounts.length ? ok({ ok: true }) : err("Account not found");
      case "private/get_subaccounts":
        return authed() ? ok({ subaccount_ids: this.deriveSubaccounts }) : err("Unauthorized");
      case "private/get_positions":
        return authed() ? ok({ positions: this.derivePositions.map((p) => ({ ...p, instrument_type: "option", average_price: "100", mark_price: "100", mark_value: "100", unrealized_pnl: "0" })) }) : err("Unauthorized");
      case "private/order": {
        if (!authed()) return err("Unauthorized");
        const filled = Number((Number(body.amount) * this.deriveFillRatio).toFixed(2));
        const t = this.deriveTickers.get(String(body.instrument_name))!;
        const px = Number(body.direction === "buy" ? t.a : t.b);
        return ok({
          order: { order_id: "ord-1", filled_amount: String(filled), average_price: String(px), order_fee: "1.5", order_status: filled > 0 ? "filled" : "cancelled" },
          trades: filled > 0 ? [{ trade_id: "t-1" }] : [],
        });
      }
    }
    return err(`fake: no Derive method ${method}`);
  }

  setMid(name: string, mid: number) {
    const m = [...this.main, ...Object.values(this.builder).flat()].find((x) => x.name === name);
    if (!m) throw new Error(`no fake market ${name}`);
    m.mid = mid;
  }

  setFunding(name: string, hourlyPct: number) {
    const m = this.main.find((x) => x.name === name);
    if (!m) throw new Error(`no fake market ${name}`);
    m.fundingHourly = hourlyPct / 100;
  }

  private universe(list: FakeMarket[]) {
    return [
      { universe: list.map((m) => ({ name: m.name, szDecimals: m.szDecimals ?? 2, maxLeverage: m.maxLeverage, marginTableId: 0 })) },
      list.map((m) => ({
        markPx: String(m.mid),
        midPx: String(m.mid),
        funding: String(m.fundingHourly ?? 0.0000125),
        openInterest: "1000",
        dayNtlVlm: "1000000",
        prevDayPx: String(m.mid),
        premium: "0",
        oraclePx: String(m.mid),
      })),
    ];
  }

  readonly fetch: Fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

    if (url.hostname === "lend.test" || url.hostname === "kamino.test") return json(this.lend(url, body));
    if (url.hostname === "derive.test") {
      const h = new Headers(init?.headers);
      const headers = Object.fromEntries(["X-DeriveWallet", "X-DeriveTimestamp", "X-DeriveSignature"].flatMap((k) => (h.get(k) ? [[k, h.get(k)!]] : [])));
      return json(this.derive(url.pathname.slice(1), body, headers));
    }
    if (url.pathname === "/info") {
      if (body.type === "perpDexs") return json([null, ...Object.keys(this.builder).map((name) => ({ name, fullName: name }))]);
      if (body.type === "metaAndAssetCtxs") {
        const dex = (body.dex as string | undefined) ?? "";
        return json(this.universe(dex ? (this.builder[dex] ?? []) : this.main));
      }
      if (body.type === "clearinghouseState") {
        return json({ marginSummary: { accountValue: "0" }, withdrawable: "0", assetPositions: [] });
      }
    }
    if (url.pathname === "/exchange") {
      this.exchange.push(body);
      const action = body.action as Record<string, unknown>;
      if (action.type === "order") return json({ status: "ok", response: { type: "order", data: { statuses: [this.orderStatus(action)] } } });
      return json({ status: "ok", response: { type: "default" } });
    }
    if (url.pathname === "/tokens/v2/search") {
      const q = (url.searchParams.get("query") ?? "").toUpperCase();
      return json(this.tokens.filter((t) => t.id.toUpperCase() === q || t.symbol.toUpperCase() === q.replace(/^\$/, "")));
    }
    if (url.pathname === "/price/v3") {
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      return json(Object.fromEntries(ids.map((id) => [id, this.tokens.find((t) => t.id === id) ? { usdPrice: this.tokens.find((t) => t.id === id)!.usdPrice } : null])));
    }
    if (url.pathname === "/swap/v1/quote") {
      const inMint = url.searchParams.get("inputMint")!;
      const outMint = url.searchParams.get("outputMint")!;
      const amount = Number(url.searchParams.get("amount"));
      const tok = (m: string) => (m === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? { usdPrice: 1, decimals: 6 } : this.tokens.find((t) => t.id === m));
      const a = tok(inMint);
      const b = tok(outMint);
      if (!a || !b || this.jupUnroutable.has(inMint) || this.jupUnroutable.has(outMint)) {
        return json({ error: "Could not find any route", errorCode: "COULD_NOT_FIND_ANY_ROUTE" }, 400);
      }
      const usd = (amount / 10 ** (a.decimals ?? 6)) * a.usdPrice;
      const out = Math.floor((usd / b.usdPrice) * 10 ** (b.decimals ?? 6));
      return json({ inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String(Math.floor(out * 0.99)), priceImpactPct: "0" });
    }
    if (url.pathname === "/currencies/v2") {
      const chainIds = (body.chainIds as number[] | undefined) ?? [];
      const addr = (body.address as string | undefined)?.toLowerCase();
      const term = (body.term as string | undefined)?.toUpperCase();
      return json(
        this.evmTokens
          .filter((t) => chainIds.includes(t.chainId) && (addr ? t.address.toLowerCase() === addr : t.symbol.toUpperCase() === term))
          .map((t) => ({ chainId: t.chainId, address: t.address, symbol: t.symbol, name: t.name ?? t.symbol, decimals: t.decimals ?? 18, metadata: { verified: Boolean(t.verified) } })),
      );
    }
    if (url.pathname === "/currencies/token/price") {
      const t = this.evmTokens.find((x) => x.address.toLowerCase() === url.searchParams.get("address")?.toLowerCase());
      return t ? json({ price: t.price }) : json({ message: "not found" }, 404);
    }
    if (url.pathname === "/quote/v2") {
      this.relayQuotes.push(body);
      const usdcLike = (a: string) => !this.evmTokens.some((t) => t.address.toLowerCase() === a.toLowerCase());
      const inAddr = String(body.originCurrency);
      const outAddr = String(body.destinationCurrency);
      const outTok = this.evmTokens.find((t) => t.address.toLowerCase() === outAddr.toLowerCase() && t.chainId === body.destinationChainId);
      const inTok = this.evmTokens.find((t) => t.address.toLowerCase() === inAddr.toLowerCase());
      if (!usdcLike(outAddr) && !outTok) return json({ message: "No routes found", errorCode: "NO_SWAP_ROUTES_FOUND" }, 400);
      const amount = Number(body.amount);
      const usd = inTok ? (amount / 10 ** (inTok.decimals ?? 18)) * inTok.price : amount / 1e6;
      const out = outTok ? (usd / outTok.price) * 10 ** (outTok.decimals ?? 18) : usd * 1e6;
      return json({
        requestId: "0xreq1",
        steps: this.relaySteps(body),
        details: { currencyIn: { amount: String(amount) }, currencyOut: { amount: BigInt(Math.floor(out)).toString() } },
      });
    }
    if (url.pathname === "/intents/status/v3") return json({ status: "success" });
    if (url.hostname === "api.telegram.org") return json({ ok: true });
    return json({ error: `fake: no route ${url.pathname}` }, 404);
  };
}

/** pump.fun curves keyed by mint. Curves are SOL-priced unless set otherwise. */
export class FakePumpFun implements PumpFunApi {
  curves = new Map<string, PumpCurve>();
  trades: { side: "buy" | "sell"; mint: string; raw: bigint }[] = [];

  addCurve(mint: string, priceInSol: number, progressPct = 40) {
    this.curves.set(mint, { mint, complete: false, quote: "SOL", quoteMint: "So11111111111111111111111111111111111111112", priceInQuote: priceInSol, progressPct, marketCapInQuote: priceInSol * 1e9, mayhem: false });
  }

  async curve(mint: string) {
    return this.curves.get(mint) ?? null;
  }
  async buy(req: { mint: string; quoteAmountRaw: bigint }): Promise<PumpTrade> {
    this.trades.push({ side: "buy", mint: req.mint, raw: req.quoteAmountRaw });
    return { instructions: [], expectedOutRaw: 0n };
  }
  async sell(req: { mint: string; tokenAmountRaw: bigint }): Promise<PumpTrade> {
    this.trades.push({ side: "sell", mint: req.mint, raw: req.tokenAmountRaw });
    return { instructions: [], expectedOutRaw: 0n };
  }
}

/** Polymarket markets and order books, in memory. */
export class FakePolymarketData implements PolymarketData {
  markets: PolyMarket[] = [];
  books = new Map<string, PolyBook>();
  searches: string[] = [];

  addMarket(m: Omit<PolyMarket, "closed" | "acceptingOrders" | "resolved" | "outcomes"> & { yesAsk: number; yesId?: string; noId?: string; depthUsd?: number }) {
    const yesId = m.yesId ?? `${m.slug}-yes`;
    const noId = m.noId ?? `${m.slug}-no`;
    const depth = m.depthUsd ?? 100_000;
    this.markets.push({
      slug: m.slug,
      question: m.question,
      endDate: m.endDate,
      closed: false,
      acceptingOrders: true,
      resolved: false,
      outcomes: [
        { label: "Yes", assetId: yesId, price: m.yesAsk },
        { label: "No", assetId: noId, price: 1 - m.yesAsk },
      ],
    });
    const book = (ask: number): PolyBook => ({
      asks: [{ price: ask, size: depth / 2 / ask }, { price: Number((ask + 0.02).toFixed(2)), size: depth / 2 / ask }],
      bids: [{ price: Number((ask - 0.01).toFixed(2)), size: depth / ask }],
      minOrderSize: 5,
    });
    this.books.set(yesId, book(m.yesAsk));
    this.books.set(noId, book(Number((1 - m.yesAsk + 0.01).toFixed(2))));
  }

  resolve(slug: string, winner: "Yes" | "No") {
    const m = this.markets.find((x) => x.slug === slug)!;
    m.closed = true;
    m.acceptingOrders = false;
    m.resolved = true;
    for (const o of m.outcomes) o.price = o.label === winner ? 1 : 0;
  }

  async search(query: string) {
    this.searches.push(query);
    const words = query.toLowerCase().split(/\s+/);
    return this.markets.filter((m) => words.some((w) => m.question.toLowerCase().includes(w)));
  }
  async market(slug: string) {
    return this.markets.find((m) => m.slug === slug) ?? null;
  }
  async book(assetId: string) {
    const b = this.books.get(assetId);
    if (!b) throw new Error(`no book for ${assetId}`);
    return b;
  }
}

/** A live Polymarket account that fills at the book's best price. */
export class FakePolymarketTrader implements PolymarketTrader {
  orders: { side: "buy" | "sell"; assetId: string; usd?: number; shares?: number; limit: number }[] = [];
  held = new Map<string, number>();
  closedOnlyMode = false;

  constructor(private readonly data: FakePolymarketData) {}

  async wallet() {
    return "0x9011000000000000000000000000000000000001";
  }
  async closedOnly() {
    return this.closedOnlyMode;
  }
  async buy(req: { assetId: string; usd: number; maxPrice: number }): Promise<PolyFill> {
    this.orders.push({ side: "buy", assetId: req.assetId, usd: req.usd, limit: req.maxPrice });
    const px = (await this.data.book(req.assetId)).asks[0]!.price;
    if (px > req.maxPrice) return { shares: 0, usd: 0, txs: [] };
    const shares = req.usd / px;
    this.held.set(req.assetId, (this.held.get(req.assetId) ?? 0) + shares);
    return { shares, usd: req.usd, txs: ["0xpolytx"] };
  }
  async sell(req: { assetId: string; shares: number; minPrice: number }): Promise<PolyFill> {
    this.orders.push({ side: "sell", assetId: req.assetId, shares: req.shares, limit: req.minPrice });
    const px = (await this.data.book(req.assetId)).bids[0]!.price;
    this.held.set(req.assetId, (this.held.get(req.assetId) ?? 0) - req.shares);
    return { shares: req.shares, usd: req.shares * px, txs: ["0xpolytx2"] };
  }
  async positions(): Promise<PolyLivePosition[]> {
    return [...this.held].filter(([, n]) => n > 0).map(([assetId, size]) => ({ assetId, title: assetId, outcome: "Yes", size, avgPrice: 0.5, currentPrice: 0.5, currentValue: size * 0.5 }));
  }
}

export interface TestFrenOptions {
  privateLine?: boolean;
  signer?: SignerApi | null;
  live?: boolean;
  evmBalances?: Record<string, bigint>;
  /** Polymarket's region check; defaults to "allowed". */
  geoblocked?: () => Promise<boolean>;
}

/** The whole engine wired to fakes: Hyperliquid, Jupiter, pump.fun, Relay, Derive and Polymarket. */
export function buildTestFren(opts: TestFrenOptions = {}) {
  const fake = new FakeVenues();
  const pump = new FakePumpFun();
  const store = new Store(":memory:", 10_000);
  const notifier = new MemoryNotifier(store, opts.privateLine ?? true);
  const signer = opts.signer ?? null;
  const evmBalances = opts.evmBalances ?? {};
  const evmTxs: string[] = [];
  const relay = new RelayVenue({
    fetchFn: fake.fetch,
    apiUrl: "https://relay.test",
    isTestnet: false,
    store,
    signer,
    erc20Balance: async (chain, token) => evmBalances[`${chain}:${token.toLowerCase()}`] ?? 0n,
    waitForTx: async (_chain, hash) => void evmTxs.push(hash),
    fillTimeoutMs: 1_000,
    evmRead: async () => encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [0n, 10n ** 27n, fake.aaveRateRay]),
  });
  const solanaSent: { txBase64: string; maxSolSpendLamports: number }[] = [];
  const solana: SolanaAccess = {
    ownerAddress: async () => (signer ? (await signer.addresses()).solana : "PaperWa11et1111111111111111111111111111111"),
    sendApiTransaction: async (txBase64, maxSolSpendLamports) => {
      solanaSent.push({ txBase64, maxSolSpendLamports });
      return `sig${solanaSent.length}`;
    },
  };
  const yieldVenue = new YieldVenue({
    store,
    protocols: [
      new JupiterLendUsdc({ fetchFn: fake.fetch, apiUrl: "https://lend.test", solana }),
      new KaminoUsdc({ fetchFn: fake.fetch, apiUrl: "https://kamino.test", solana }),
      new AaveUsdc("arbitrum", relay),
      new AaveUsdc("base", relay),
    ],
    walletUsdc: async (chain) => (chain === "solana" ? fake.solanaUsdc : ((await relay.usdcBalances())[chain] ?? 0)),
  });
  const poly = new FakePolymarketData();
  const polyTrader = new FakePolymarketTrader(poly);
  const hyperliquid = new HyperliquidVenue({ fetchFn: fake.fetch, apiUrl: "https://hl.test", isTestnet: true, store, signer });
  const derive = new DeriveVenue({
    fetchFn: fake.fetch,
    apiUrl: "https://derive.test",
    isTestnet: false,
    store,
    signer,
    spotPrice: async (asset) => (await hyperliquid.markets.get(asset))?.midPx ?? null,
  });
  const polymarket = new PolymarketVenue({ store, data: poly, trader: signer ? polyTrader : null, geoblocked: opts.geoblocked ?? (async () => false) });
  const fren = new Fren({
    store,
    notifier,
    signer,
    isTestnet: true,
    hyperliquid,
    jupiter: new JupiterVenue({ fetchFn: fake.fetch, apiUrl: "https://jup.test", solanaRpcUrl: "https://rpc.test", store, signer, pumpFun: pump }),
    relay,
    derive,
    polymarket,
    yield: yieldVenue,
  });
  if (opts.live) store.setLimits({ ...store.getLimits(), mode: "live" });
  return { fake, pump, poly, polyTrader, derive, polymarket, yield: yieldVenue, solanaSent, evmBalances, store, notifier, fren, evmTxs };
}
