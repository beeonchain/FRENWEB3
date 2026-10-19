import type { SignerApi } from "@fren/signer";
import { Fren } from "./engine.js";
import type { Fetch } from "./http.js";
import { MemoryNotifier } from "./notify.js";
import { Store } from "./store.js";
import { HyperliquidVenue } from "./venues/hyperliquid.js";
import { JupiterVenue } from "./venues/jupiter.js";
import type { PumpCurve, PumpFunApi, PumpTrade } from "./venues/pumpfun.js";
import { RelayVenue } from "./venues/relay.js";

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
      const tok = (m: string) => (m === "EPjFWdd5AufqSNqeM2qUv8BZ3vVdXzaa9Sr8ZnxsHMwv" ? { usdPrice: 1, decimals: 6 } : this.tokens.find((t) => t.id === m));
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

export interface TestFrenOptions {
  privateLine?: boolean;
  signer?: SignerApi | null;
  live?: boolean;
  evmBalances?: Record<string, bigint>;
}

/** The whole engine wired to fakes: Hyperliquid, Jupiter, pump.fun and Relay. */
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
  });
  const fren = new Fren({
    store,
    notifier,
    signer,
    isTestnet: true,
    hyperliquid: new HyperliquidVenue({ fetchFn: fake.fetch, apiUrl: "https://hl.test", isTestnet: true, store, signer }),
    jupiter: new JupiterVenue({ fetchFn: fake.fetch, apiUrl: "https://jup.test", solanaRpcUrl: "https://rpc.test", store, signer, pumpFun: pump }),
    relay,
  });
  if (opts.live) store.setLimits({ ...store.getLimits(), mode: "live" });
  return { fake, pump, store, notifier, fren, evmTxs };
}
