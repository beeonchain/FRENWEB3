import { getJson, postJson, type Fetch } from "../http.js";
import { USDC_MINT } from "./jupiter.js";
import { VenueError } from "./types.js";
import type { YieldProtocolAdapter } from "./yield.js";

/**
 * USDC lending on Solana through each protocol's own transaction API. The API
 * builds the transaction; Fren's signer only signs it if every top-level
 * program is the protocol's own (or token, account and compute plumbing) and
 * simulation shows no more than a little SOL leaving for rent and fees.
 */

/** What the yield adapters need from the Solana wallet. JupiterVenue provides it. */
export interface SolanaAccess {
  ownerAddress(): Promise<string>;
  sendApiTransaction(txBase64: string, maxSolSpendLamports: number): Promise<string>;
}

const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
const raw6 = (usd: number) => BigInt(Math.floor(usd * 1e6));

// -- Jupiter Lend (Earn) ----------------------------------------------------------

interface JupLendToken {
  address: string;
  assetAddress: string;
  decimals: number;
  /** Basis points: "569" is 5.69%. Supply rate plus rewards. */
  totalRate: string;
}

interface JupLendPosition {
  token: JupLendToken;
  ownerAddress: string;
  shares: string;
  /** USDC deposited, interest included, in base units. */
  underlyingAssets: string;
}

export class JupiterLendUsdc implements YieldProtocolAdapter {
  readonly id = "jupiter_lend" as const;
  readonly chain = "solana" as const;

  constructor(
    private readonly o: {
      fetchFn: Fetch;
      /** e.g. https://api.jup.ag/lend/v1 (with an API key) or https://lite-api.jup.ag/lend/v1. */
      apiUrl: string;
      apiKey?: string;
      solana: SolanaAccess;
    },
  ) {}

  private headers(): Record<string, string> {
    return this.o.apiKey ? { "x-api-key": this.o.apiKey } : {};
  }

  async apy(): Promise<number> {
    const tokens = await getJson<JupLendToken[]>(this.o.fetchFn, `${this.o.apiUrl}/earn/tokens`, this.headers());
    const usdc = tokens.find((t) => t.assetAddress === USDC_MINT);
    if (!usdc) throw new VenueError("Jupiter Lend doesn't list USDC.");
    return Number(usdc.totalRate) / 100;
  }

  private async position(): Promise<JupLendPosition | null> {
    const owner = await this.o.solana.ownerAddress();
    const list = await getJson<JupLendPosition[]>(this.o.fetchFn, `${this.o.apiUrl}/earn/positions?users=${owner}`, this.headers());
    return list.find((p) => p.token.assetAddress === USDC_MINT && p.ownerAddress === owner) ?? null;
  }

  async deposited(): Promise<number> {
    return Number((await this.position())?.underlyingAssets ?? 0) / 1e6;
  }

  private async send(path: string, body: Record<string, string>): Promise<string> {
    const { transaction } = await postJson<{ transaction: string }>(this.o.fetchFn, `${this.o.apiUrl}${path}`, body, this.headers());
    // Rent for a new jlUSDC account at most; no SOL should otherwise leave.
    return solscan(await this.o.solana.sendApiTransaction(transaction, 10_000_000));
  }

  async deposit(usd: number): Promise<string> {
    const signer = await this.o.solana.ownerAddress();
    return this.send("/earn/deposit", { asset: USDC_MINT, signer, amount: raw6(usd).toString() });
  }

  async withdraw(usd: number | "all"): Promise<{ usd: number; link: string }> {
    const signer = await this.o.solana.ownerAddress();
    const pos = await this.position();
    const held = Number(pos?.underlyingAssets ?? 0) / 1e6;
    if (!pos || held <= 0) throw new VenueError("Nothing lent on Jupiter Lend.");
    if (usd === "all" || usd >= held) {
      // Redeeming every share leaves no dust behind, unlike withdrawing a USDC amount that keeps accruing.
      return { usd: held, link: await this.send("/earn/redeem", { asset: USDC_MINT, signer, shares: pos.shares }) };
    }
    return { usd, link: await this.send("/earn/withdraw", { asset: USDC_MINT, signer, amount: raw6(usd).toString() }) };
  }
}

// -- Kamino Lend --------------------------------------------------------------------

export const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
/** The main market's USDC reserve. Several small reserves are also called USDC, so match by address. */
export const KAMINO_USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";

interface KaminoReserveMetrics {
  reserve: string;
  liquidityTokenMint: string;
  /** A fraction: "0.0468" is 4.68%. */
  supplyApy: string;
}

interface KaminoObligation {
  obligationAddress: string;
  state: { deposits: { depositReserve: string }[] };
}

interface KaminoLoan {
  loanInfo: { collateral: { deposits: { tokenMint: string; tokenAmount: string | number }[] } };
}

export class KaminoUsdc implements YieldProtocolAdapter {
  readonly id = "kamino" as const;
  readonly chain = "solana" as const;

  constructor(
    private readonly o: {
      fetchFn: Fetch;
      /** https://api.kamino.finance */
      apiUrl: string;
      solana: SolanaAccess;
    },
  ) {}

  async apy(): Promise<number> {
    const rows = await getJson<KaminoReserveMetrics[]>(
      this.o.fetchFn,
      `${this.o.apiUrl}/kamino-market/${KAMINO_MAIN_MARKET}/reserves/metrics?env=mainnet-beta`,
    );
    const usdc = rows.find((r) => r.reserve === KAMINO_USDC_RESERVE);
    if (!usdc) throw new VenueError("Kamino didn't return its USDC reserve.");
    return Number(usdc.supplyApy) * 100;
  }

  async deposited(): Promise<number> {
    const owner = await this.o.solana.ownerAddress();
    const obligations = await getJson<KaminoObligation[]>(
      this.o.fetchFn,
      `${this.o.apiUrl}/kamino-market/${KAMINO_MAIN_MARKET}/users/${owner}/obligations`,
    ).catch(() => [] as KaminoObligation[]);
    let total = 0;
    for (const ob of obligations) {
      if (!ob.state.deposits.some((d) => d.depositReserve === KAMINO_USDC_RESERVE)) continue;
      // Obligations hold collateral-token units; the loan view converts them to USDC.
      const loan = await getJson<KaminoLoan>(this.o.fetchFn, `${this.o.apiUrl}/klend/loans/${ob.obligationAddress}`);
      for (const d of loan.loanInfo.collateral.deposits) if (d.tokenMint === USDC_MINT) total += Number(d.tokenAmount);
    }
    return total;
  }

  private async send(path: string, usd: number): Promise<string> {
    const wallet = await this.o.solana.ownerAddress();
    const { transaction } = await postJson<{ transaction: string }>(this.o.fetchFn, `${this.o.apiUrl}${path}`, {
      wallet,
      market: KAMINO_MAIN_MARKET,
      reserve: KAMINO_USDC_RESERVE,
      // Kamino takes a decimal amount in USDC, not base units.
      amount: (Math.floor(usd * 1e6) / 1e6).toFixed(6),
    });
    // A first deposit opens the account (obligation and lookup table): about 0.03 SOL of rent.
    return solscan(await this.o.solana.sendApiTransaction(transaction, 50_000_000));
  }

  async deposit(usd: number): Promise<string> {
    return this.send("/ktx/klend/deposit", usd);
  }

  async withdraw(usd: number | "all"): Promise<{ usd: number; link: string }> {
    const held = await this.deposited();
    if (held <= 0) throw new VenueError("Nothing lent on Kamino.");
    const amount = usd === "all" || usd >= held ? held : usd;
    return { usd: amount, link: await this.send("/ktx/klend/withdraw", amount) };
  }
}
