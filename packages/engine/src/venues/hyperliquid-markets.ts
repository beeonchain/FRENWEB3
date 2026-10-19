import { postJson, type Fetch } from "../http.js";

/** One perp market on Hyperliquid's main dex or a builder-deployed (HIP-3) dex. */
export interface PerpMarket {
  /** Full symbol: "BTC" on the main dex, "<dex>:<asset>" on builder dexes. */
  name: string;
  dex: string;
  assetId: number;
  szDecimals: number;
  maxLeverage: number;
  isolatedOnly: boolean;
  markPx: number;
  midPx: number;
  /** Current hourly funding rate in percent. */
  fundingHourlyPct: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
}

interface MetaUniverse {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: string;
}
interface AssetCtx {
  markPx: string;
  midPx: string | null;
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
}

/** Everyday words people use for markets that trade under a ticker. */
const ALIASES: Record<string, string[]> = {
  gold: ["GOLD", "XAU", "PAXG"],
  silver: ["SILVER", "XAG"],
  oil: ["OIL", "WTI", "BRENT", "CL", "USOIL"],
  "s&p": ["SPX", "SP500", "US500", "SPY"],
  sp500: ["SPX", "SP500", "US500", "SPY"],
  nasdaq: ["NDX", "NAS100", "XYZ100", "QQQ", "US100"],
  bitcoin: ["BTC"],
  ether: ["ETH"],
  ethereum: ["ETH"],
  solana: ["SOL"],
  tesla: ["TSLA"],
  nvidia: ["NVDA"],
  apple: ["AAPL"],
};

export function assetIdFor(dexIndex: number, index: number): number {
  return dexIndex === 0 ? index : 100_000 + dexIndex * 10_000 + index;
}

export class HyperliquidMarkets {
  private cache: { at: number; markets: PerpMarket[] } | null = null;

  constructor(
    private readonly fetchFn: Fetch,
    private readonly apiUrl: string,
    private readonly ttlMs = 10_000,
  ) {}

  info<T>(body: Record<string, unknown>): Promise<T> {
    return postJson<T>(this.fetchFn, `${this.apiUrl}/info`, body);
  }

  async all(force = false): Promise<PerpMarket[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.markets;
    const dexes = await this.info<({ name: string } | null)[]>({ type: "perpDexs" });
    const lists = await Promise.all(
      dexes.map(async (dex, dexIndex) => {
        const dexName = dex?.name ?? "";
        const [meta, ctxs] = await this.info<[{ universe: MetaUniverse[] }, AssetCtx[]]>({
          type: "metaAndAssetCtxs",
          ...(dexName ? { dex: dexName } : {}),
        });
        return meta.universe.flatMap((u, i): PerpMarket[] => {
          const ctx = ctxs[i];
          if (!ctx || u.isDelisted) return [];
          const mark = Number(ctx.markPx);
          const name = dexName && !u.name.includes(":") ? `${dexName}:${u.name}` : u.name;
          return [
            {
              name,
              dex: dexName,
              assetId: assetIdFor(dexIndex, i),
              szDecimals: u.szDecimals,
              maxLeverage: u.maxLeverage,
              isolatedOnly: Boolean(u.onlyIsolated) || u.marginMode === "strictIsolated" || u.marginMode === "noCross",
              markPx: mark,
              midPx: ctx.midPx ? Number(ctx.midPx) : mark,
              fundingHourlyPct: Number(ctx.funding) * 100,
              openInterestUsd: Number(ctx.openInterest) * mark,
              dayVolumeUsd: Number(ctx.dayNtlVlm),
            },
          ];
        });
      }),
    );
    const markets = lists.flat();
    this.cache = { at: Date.now(), markets };
    return markets;
  }

  /** Exact lookup. Accepts "btc", "BTC", "xyz:GOLD"; a bare name falls back to the main dex. */
  async get(symbol: string): Promise<PerpMarket | null> {
    const want = symbol.trim().toUpperCase();
    const markets = await this.all();
    return (
      markets.find((m) => m.name.toUpperCase() === want) ??
      markets.find((m) => m.dex === "" && m.name.toUpperCase() === want.split(":").pop()) ??
      null
    );
  }

  /** Fuzzy search for the agent: "gold", "nasdaq", "pepe". Best matches first. */
  async search(query: string, limit = 8): Promise<PerpMarket[]> {
    const q = query.trim().toLowerCase();
    const terms = new Set([q.toUpperCase(), ...(ALIASES[q] ?? [])]);
    const markets = await this.all();
    const scored = markets.flatMap((m) => {
      const base = (m.name.split(":").pop() ?? m.name).toUpperCase();
      let score = 0;
      for (const t of terms) {
        if (base === t) score = Math.max(score, 3);
        else if (base.startsWith(t)) score = Math.max(score, 2);
        else if (base.includes(t)) score = Math.max(score, 1);
      }
      return score > 0 ? [{ m, score }] : [];
    });
    scored.sort((a, b) => b.score - a.score || b.m.dayVolumeUsd - a.m.dayVolumeUsd);
    return scored.slice(0, limit).map((s) => s.m);
  }
}
