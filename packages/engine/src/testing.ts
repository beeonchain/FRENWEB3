import type { Fetch } from "./http.js";

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
    if (url.hostname === "api.telegram.org") return json({ ok: true });
    return json({ error: `fake: no route ${url.pathname}` }, 404);
  };
}
