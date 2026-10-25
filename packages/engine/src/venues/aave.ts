import { decodeAbiParameters, encodeFunctionData, erc20Abi, maxUint256, parseAbi } from "viem";
import type { RelayVenue } from "./relay.js";
import { VenueError } from "./types.js";
import type { YieldProtocolAdapter } from "./yield.js";

/**
 * Aave v3 USDC lending on Arbitrum and Base. Fren builds the calldata itself:
 * approve the pool for the exact amount, supply on the owner's behalf, and
 * withdraw to the owner. The signer checks the pool and the owner in each.
 */

export const AAVE_MARKETS = {
  arbitrum: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    aToken: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
  },
  base: {
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    aToken: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
  },
} as const satisfies Record<string, { pool: `0x${string}`; usdc: `0x${string}`; aToken: `0x${string}` }>;

export const AAVE_POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function getReserveData(address asset) view returns (uint256)",
]);

const SECONDS_PER_YEAR = 31_536_000;

/** Aave's currentLiquidityRate is a per-year rate in ray (1e27), compounded per second. */
export function aaveSupplyApy(liquidityRateRay: bigint): number {
  const apr = Number(liquidityRateRay) / 1e27;
  return (Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1) * 100;
}

export class AaveUsdc implements YieldProtocolAdapter {
  readonly id;
  readonly chain;
  private readonly m: (typeof AAVE_MARKETS)[keyof typeof AAVE_MARKETS];

  constructor(
    chain: keyof typeof AAVE_MARKETS,
    private readonly evm: RelayVenue,
  ) {
    this.chain = chain;
    this.id = chain === "arbitrum" ? ("aave_arbitrum" as const) : ("aave_base" as const);
    this.m = AAVE_MARKETS[chain];
  }

  async apy(): Promise<number> {
    const data = encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "getReserveData", args: [this.m.usdc] });
    const raw = await this.evm.call(this.chain, this.m.pool, data);
    // ReserveData is a static struct; currentLiquidityRate is its third word.
    const words = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], raw);
    return aaveSupplyApy(words[2]);
  }

  private async aBalance(): Promise<bigint> {
    return this.evm.tokenBalance(this.chain, this.m.aToken, await this.evm.ownerAddress());
  }

  async deposited(): Promise<number> {
    return Number(await this.aBalance()) / 1e6;
  }

  async deposit(usd: number): Promise<string> {
    const owner = await this.evm.ownerAddress();
    const raw = BigInt(Math.floor(usd * 1e6));
    if (raw <= 0n) throw new VenueError("Nothing to lend.");
    await this.evm.sendTx(this.chain, this.m.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.m.pool, raw] }));
    return this.evm.sendTx(
      this.chain,
      this.m.pool,
      encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "supply", args: [this.m.usdc, raw, owner, 0] }),
    );
  }

  async withdraw(usd: number | "all"): Promise<{ usd: number; link: string }> {
    const owner = await this.evm.ownerAddress();
    const before = await this.aBalance();
    if (before <= 0n) throw new VenueError(`Nothing lent on Aave on ${this.chain === "arbitrum" ? "Arbitrum" : "Base"}.`);
    const raw = usd === "all" ? maxUint256 : BigInt(Math.ceil(usd * 1e6));
    const link = await this.evm.sendTx(
      this.chain,
      this.m.pool,
      encodeFunctionData({ abi: AAVE_POOL_ABI, functionName: "withdraw", args: [this.m.usdc, raw, owner] }),
    );
    const got = usd === "all" ? before : raw < before ? raw : before;
    return { usd: Number(got) / 1e6, link };
  }
}
