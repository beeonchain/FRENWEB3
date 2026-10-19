import { z } from "zod";

/**
 * The Plan is the contract between the agent (which writes it) and everything
 * downstream (policy, signer, adapters, watcher). The agent never touches keys;
 * all it can do is propose a Plan that deterministic code then checks.
 */

export const PLAN_VERSION = 1 as const;

export const Venue = z.enum(["hyperliquid", "jupiter"]);
export type Venue = z.infer<typeof Venue>;

export const Side = z.enum(["long", "short"]);
export type Side = z.infer<typeof Side>;

const usd = z.number().positive().finite();
const pct = z.number().positive().max(100);

/** How big a perp position is. "margin" is the collateral put up; "notional" is the full position size. */
export const PerpSizing = z.discriminatedUnion("type", [
  z.object({ type: z.literal("margin"), usd }),
  z.object({ type: z.literal("notional"), usd }),
]);
export type PerpSizing = z.infer<typeof PerpSizing>;

export const PerpOpenLeg = z.object({
  kind: z.literal("perp_open"),
  venue: z.literal("hyperliquid"),
  /** Venue symbol, e.g. "BTC", or "<dex>:<asset>" for builder-deployed markets like gold. */
  market: z.string().min(1).describe('Hyperliquid symbol from fren_markets, e.g. "BTC" or "xyz:GOLD" for builder-deployed markets.'),
  side: Side,
  sizing: PerpSizing.describe('"margin" = collateral the user puts up ("use $2000 as collateral"); "notional" = full position size.'),
  leverage: z.number().int().min(1).max(1000),
  /**
   * Stop loss as % of margin lost (ROE), the way traders say "stop at -15%".
   * The price move is stopLossPct / leverage, so -15% at 50x is a 0.3% move.
   */
  stopLossPct: pct.optional().describe("Stop loss as % of margin lost (ROE). 'Stop at -15%' means 15."),
  /** Take profit as % gained on margin (ROE). May exceed 100. */
  takeProfitPct: z.number().positive().max(10_000).optional().describe("Take profit as % gained on margin (ROE)."),
  /** Absolute stop price. Use instead of stopLossPct when the user names a level. */
  stopPrice: z.number().positive().optional().describe("Absolute stop price, when the user names a level."),
  /** Absolute take-profit price. */
  takeProfitPrice: z.number().positive().optional().describe("Absolute take-profit price."),
  maxSlippagePct: z.number().positive().max(10).default(1),
});
export type PerpOpenLeg = z.infer<typeof PerpOpenLeg>;

export const PerpCloseLeg = z.object({
  kind: z.literal("perp_close"),
  venue: z.literal("hyperliquid"),
  market: z.string().min(1),
  /** Share of the open position to close, 0 < fraction <= 1. */
  fraction: z.number().gt(0).max(1).default(1),
  maxSlippagePct: z.number().positive().max(10).default(1),
});
export type PerpCloseLeg = z.infer<typeof PerpCloseLeg>;

export const SwapAmount = z.discriminatedUnion("type", [
  /** Spend this many USD (of USDC) on a buy. */
  z.object({ type: z.literal("usd"), usd }),
  /** Sell this share of the current token balance. */
  z.object({ type: z.literal("fraction"), fraction: z.number().gt(0).max(1) }),
]);
export type SwapAmount = z.infer<typeof SwapAmount>;

export const SwapLeg = z.object({
  kind: z.literal("swap"),
  venue: z.literal("jupiter"),
  side: z.enum(["buy", "sell"]),
  /** Token mint address (preferred) or a well-known symbol such as "SOL" or "JUP". */
  token: z.string().min(1).describe("Token mint (contract address) or a ticker. Tickers only resolve to verified tokens."),
  amount: SwapAmount.describe('Buys: {type:"usd"} spends that much USDC. Sells: {type:"fraction"} of the balance, or {type:"usd"} worth.'),
  maxSlippageBps: z.number().int().min(1).max(5000).default(100),
});
export type SwapLeg = z.infer<typeof SwapLeg>;

export const Leg = z.discriminatedUnion("kind", [PerpOpenLeg, PerpCloseLeg, SwapLeg]);
export type Leg = z.infer<typeof Leg>;

export const Comparator = z.enum([">", ">=", "<", "<="]);
export type Comparator = z.infer<typeof Comparator>;

export const Condition = z.discriminatedUnion("type", [
  /** Mark/mid price of a market crosses a level. */
  z.object({
    type: z.literal("price"),
    venue: Venue,
    market: z.string().min(1),
    op: Comparator,
    value: z.number().positive(),
  }),
  /** Hyperliquid hourly funding rate, in percent (0.01 means 0.01%/h). */
  z.object({
    type: z.literal("funding"),
    venue: z.literal("hyperliquid"),
    market: z.string().min(1),
    op: Comparator,
    value: z.number().describe("Hourly funding in percent: 0.02 means 0.02%/h."),
  }),
  /** Fire at or after a point in time. */
  z.object({
    type: z.literal("time"),
    after: z.iso.datetime({ offset: true }),
  }),
]);
export type Condition = z.infer<typeof Condition>;

export const PlanStep = z.object({
  leg: Leg,
  /** Every condition must hold before the leg fires. Empty means fire now. */
  when: z.array(Condition).max(8).default([]).describe("All must hold before the leg fires. Omit or [] to fire now."),
  /** Conditional legs that have not fired by this time are dropped. */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  version: z.literal(PLAN_VERSION).default(PLAN_VERSION),
  /** The user's request, quoted, so the echo and logs show what was asked. */
  request: z.string().max(2000).describe("The user's message, quoted verbatim."),
  steps: z.array(PlanStep).min(1).max(10),
});
export type Plan = z.infer<typeof Plan>;
export type PlanInput = z.input<typeof Plan>;

export function parsePlan(input: unknown): Plan {
  return Plan.parse(input);
}

export function safeParsePlan(input: unknown) {
  return Plan.safeParse(input);
}
