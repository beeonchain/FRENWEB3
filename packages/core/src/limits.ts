import { z } from "zod";
import { Venue } from "./plan.js";

/**
 * The user's own rules. Set in chat, enforced in code. The agent may tighten
 * these but only the owner (via a slash command that bypasses the LLM) may
 * loosen them.
 */
export const Limits = z.object({
  /** "paper" runs every plan with fake money at real prices. */
  mode: z.enum(["paper", "live"]).default("paper"),
  /** Kill switch. When true nothing executes and the watcher fires nothing. */
  paused: z.boolean().default(false),
  /** Most USD a single leg may spend (perp margin or swap input). */
  maxTradeUsd: z.number().positive().default(500),
  /** Most USD all legs together may spend per UTC day. */
  maxDailyUsd: z.number().positive().default(2000),
  maxLeverage: z.number().int().min(1).default(20),
  maxOpenPositions: z.number().int().min(1).default(10),
  /** Plans spending at or under this run without a confirmation code. */
  autoApproveUsd: z.number().min(0).default(100),
  allowedVenues: z.array(Venue).default(["hyperliquid", "jupiter", "relay", "derive", "polymarket"]),
});
export type Limits = z.infer<typeof Limits>;

export const DEFAULT_LIMITS: Limits = Limits.parse({});

export type LimitKey = keyof Omit<Limits, "allowedVenues">;

/**
 * True when moving from `current` to `next` only makes things stricter, so the
 * agent is allowed to do it without the owner's command.
 */
export function isTightening(current: Limits, next: Limits): boolean {
  if (current.mode === "paper" && next.mode === "live") return false;
  if (current.paused && !next.paused) return false;
  if (next.maxTradeUsd > current.maxTradeUsd) return false;
  if (next.maxDailyUsd > current.maxDailyUsd) return false;
  if (next.maxLeverage > current.maxLeverage) return false;
  if (next.maxOpenPositions > current.maxOpenPositions) return false;
  if (next.autoApproveUsd > current.autoApproveUsd) return false;
  if (next.allowedVenues.some((v) => !current.allowedVenues.includes(v))) return false;
  return true;
}

/**
 * Parse "key=value" pairs from an owner command such as
 * `/limits maxTradeUsd=2500 maxLeverage=40 mode=live`.
 */
export function applyLimitArgs(current: Limits, args: string): Limits {
  const next: Record<string, unknown> = { ...current };
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=");
    if (eq <= 0) throw new Error(`Expected key=value, got "${token}"`);
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (!(key in DEFAULT_LIMITS)) throw new Error(`Unknown limit "${key}"`);
    if (key === "allowedVenues") {
      next[key] = raw.split(",").filter(Boolean);
    } else if (key === "mode") {
      next[key] = raw;
    } else if (key === "paused") {
      next[key] = raw === "true" || raw === "on" || raw === "yes";
    } else {
      const n = Number(raw.replace(/[$,_]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`"${key}" needs a number, got "${raw}"`);
      next[key] = n;
    }
  }
  return Limits.parse(next);
}
