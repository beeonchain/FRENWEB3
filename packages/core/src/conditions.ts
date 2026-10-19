import type { Comparator, Condition } from "./plan.js";

/** Live values the watcher fetched for one tick. Missing keys mean "unknown this tick". */
export interface MarketSnapshot {
  now: Date;
  /** key: `${venue}:${market}` */
  prices: Map<string, number>;
  /** key: `hyperliquid:${market}`, hourly funding in percent */
  funding: Map<string, number>;
}

export interface ConditionStatus {
  condition: Condition;
  /** null when the live value was unavailable; treated as not met. */
  current: number | string | null;
  met: boolean;
}

export function compare(a: number, op: Comparator, b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
  }
}

export function snapshotKey(venue: string, market: string): string {
  return `${venue}:${market}`;
}

export function evaluateCondition(c: Condition, snap: MarketSnapshot): ConditionStatus {
  switch (c.type) {
    case "price": {
      const v = snap.prices.get(snapshotKey(c.venue, c.market));
      return { condition: c, current: v ?? null, met: v !== undefined && compare(v, c.op, c.value) };
    }
    case "funding": {
      const v = snap.funding.get(snapshotKey(c.venue, c.market));
      return { condition: c, current: v ?? null, met: v !== undefined && compare(v, c.op, c.value) };
    }
    case "time": {
      const at = new Date(c.after);
      return { condition: c, current: snap.now.toISOString(), met: snap.now.getTime() >= at.getTime() };
    }
  }
}

export function evaluateAll(conditions: Condition[], snap: MarketSnapshot) {
  const statuses = conditions.map((c) => evaluateCondition(c, snap));
  return { statuses, allMet: statuses.every((s) => s.met) };
}
