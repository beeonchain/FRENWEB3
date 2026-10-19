import { createPublicClient, createSecureClient, OrderSide, type PublicClient, type SecureClient, type Signer } from "@polymarket/client";
import type { PolyTypedData, SignerApi } from "@fren/signer";
import type { Fetch } from "../http.js";
import type { PolyBook, PolyFill, PolyLivePosition, PolyMarket, PolymarketData, PolymarketTrader } from "./polymarket.js";
import { VenueError } from "./types.js";

/**
 * The real Polymarket, through Polymarket's official SDK (@polymarket/client).
 * The SDK talks to Polymarket's APIs; every signature it needs comes from
 * Fren's signer process, which only signs Polymarket logins, orders and
 * deposit-wallet approvals (see signer/src/polymarket.ts).
 */

type Market = Awaited<ReturnType<PublicClient["fetchMarket"]>>;

function toMarket(m: Market): PolyMarket {
  const slug = m.slug ?? String(m.id);
  const outcomes = [m.outcomes.yes, m.outcomes.no].map((o) => ({
    label: o.label,
    assetId: String((m.version === "v2" ? o.positionId : o.tokenId) ?? o.tokenId ?? o.positionId ?? ""),
    price: o.price === null ? null : Number(o.price),
  }));
  const settled = m.resolution.umaResolutionStatus === "resolved" || m.resolution.umaResolutionStatus === "settled";
  const final = outcomes.every((o) => o.price === 0 || o.price === 1);
  return {
    slug,
    question: m.question ?? m.groupItemTitle ?? slug,
    endDate: m.state.endDate ?? null,
    closed: Boolean(m.state.closed),
    acceptingOrders: m.state.acceptingOrders !== false && m.state.enableOrderBook !== false,
    resolved: Boolean(m.state.closed) && (settled || final),
    outcomes: outcomes.filter((o) => o.assetId),
    ...(m.description ? { rules: m.description.slice(0, 400) } : {}),
  };
}

export class SdkPolymarketData implements PolymarketData {
  private readonly client: PublicClient = createPublicClient();

  async search(query: string): Promise<PolyMarket[]> {
    const page = await this.client.search({ q: query, eventsStatus: "active", pageSize: 10 }).firstPage();
    return page.items.events.flatMap((e) => e.markets).map(toMarket);
  }

  async market(slug: string): Promise<PolyMarket | null> {
    try {
      return toMarket(await this.client.fetchMarket({ slug }));
    } catch {
      return null;
    }
  }

  async book(assetId: string): Promise<PolyBook> {
    const b = await this.client.fetchOrderBook({ assetId });
    const levels = (xs: { price: string; size: string }[]) => xs.map((l) => ({ price: Number(l.price), size: Number(l.size) }));
    // The SDK lists asks highest first and bids lowest first; walking a book wants the best price first.
    return { asks: levels(b.asks).sort((x, y) => x.price - y.price), bids: levels(b.bids).sort((x, y) => y.price - x.price), minOrderSize: Number(b.minOrderSize) };
  }
}

/** The SDK's wallet interface, backed by Fren's signer. Raw messages and transactions are refused. */
export function frenPolymarketSigner(signer: SignerApi): Signer {
  return {
    getAddress: async () => (await signer.addresses()).evm as Awaited<ReturnType<Signer["getAddress"]>>,
    signTypedData: async (payload) =>
      (await signer.polySignTypedData(payload as unknown as PolyTypedData)) as Awaited<ReturnType<Signer["signTypedData"]>>,
    signMessage: async () => {
      throw new Error("Fren's signer doesn't sign raw messages for Polymarket.");
    },
    sendTransaction: async () => {
      throw new Error("Fren's signer doesn't send Polymarket transactions directly; the deposit wallet's gasless relayer does.");
    },
  };
}

export class SdkPolymarketTrader implements PolymarketTrader {
  private client: Promise<SecureClient> | null = null;
  private approved = false;

  constructor(private readonly signer: SignerApi) {}

  private secure(): Promise<SecureClient> {
    // Logs in with a ClobAuth signature and uses the signer's own deposit wallet.
    this.client ??= createSecureClient({ signer: frenPolymarketSigner(this.signer) }).catch((err: unknown) => {
      this.client = null;
      throw new VenueError(`Couldn't log in to Polymarket: ${(err as Error).message}`);
    });
    return this.client;
  }

  async wallet(): Promise<string> {
    return (await this.secure()).account.wallet;
  }

  async closedOnly(): Promise<boolean> {
    return (await this.secure()).fetchClosedOnlyMode();
  }

  private async ready(): Promise<SecureClient> {
    const c = await this.secure();
    if (!this.approved) {
      await c.setupTradingApprovals();
      this.approved = true;
    }
    return c;
  }

  async buy(req: { assetId: string; usd: number; maxPrice: number }): Promise<PolyFill> {
    const c = await this.ready();
    const res = await c.placeMarketOrder({ assetId: req.assetId, side: OrderSide.BUY, amount: req.usd, maxSpend: req.usd, maxPrice: req.maxPrice });
    if (!res.ok) throw new VenueError(`Polymarket refused the order: ${res.message}`);
    return { usd: Number(res.makingAmount), shares: Number(res.takingAmount), txs: res.transactionsHashes };
  }

  async sell(req: { assetId: string; shares: number; minPrice: number }): Promise<PolyFill> {
    const c = await this.ready();
    const res = await c.placeMarketOrder({ assetId: req.assetId, side: OrderSide.SELL, shares: req.shares, minPrice: req.minPrice });
    if (!res.ok) throw new VenueError(`Polymarket refused the order: ${res.message}`);
    return { shares: Number(res.makingAmount), usd: Number(res.takingAmount), txs: res.transactionsHashes };
  }

  async positions(): Promise<PolyLivePosition[]> {
    const page = await (await this.secure()).listPositions().firstPage();
    return page.items.map((p) => ({
      assetId: String(p.assetId),
      title: p.title ?? String(p.conditionId),
      outcome: p.outcome ?? "",
      size: Number(p.currentSize),
      avgPrice: Number(p.avgPrice),
      currentPrice: Number(p.currentPrice),
      currentValue: Number(p.currentValue),
    }));
  }
}

/** Polymarket's own check of whether this IP may place orders. */
export function polymarketGeoblock(fetchFn: Fetch): () => Promise<boolean> {
  return async () => {
    const res = await fetchFn("https://polymarket.com/api/geoblock", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`geoblock check returned ${res.status}`);
    const body = (await res.json()) as { blocked?: boolean };
    return body.blocked === true;
  };
}
