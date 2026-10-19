import type { ConditionStatus } from "./conditions.js";
import type { Condition, Leg, PlanStep } from "./plan.js";
import type { PolicyDecision, ResolvedStep } from "./policy.js";

/**
 * Plain-English rendering for chat. Users learn the grammar by reading their
 * own trades back, so this text is part of the product, not debug output.
 */

export function usd(n: number): string {
  const digits = Math.abs(n) >= 100 ? 0 : 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "+$12.50" / "-$12.50", for PnL. */
export function signedUsd(n: number): string {
  return `${n < 0 ? "-" : "+"}${usd(Math.abs(n))}`;
}

export function price(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(4)}`;
}

function pctMove(p: number): string {
  return `${p >= 1 ? p.toFixed(1) : p.toPrecision(2)}%`;
}

const venueName: Record<string, string> = { hyperliquid: "Hyperliquid", jupiter: "Jupiter" };

export function describeLeg(leg: Leg, resolved?: Pick<ResolvedStep, "symbol" | "notionalUsd">): string {
  const where = venueName[leg.venue] ?? leg.venue;
  switch (leg.kind) {
    case "perp_open": {
      const margin = leg.sizing.type === "margin" ? leg.sizing.usd : leg.sizing.usd / leg.leverage;
      const notional = resolved?.notionalUsd ?? margin * leg.leverage;
      const exits: string[] = [];
      if (leg.stopLossPct !== undefined) {
        exits.push(`stop at -${leg.stopLossPct}% of margin (${pctMove(leg.stopLossPct / leg.leverage)} price move)`);
      }
      if (leg.stopPrice !== undefined) exits.push(`stop at ${price(leg.stopPrice)}`);
      if (leg.takeProfitPct !== undefined) {
        exits.push(`take profit at +${leg.takeProfitPct}% (${pctMove(leg.takeProfitPct / leg.leverage)} price move)`);
      }
      if (leg.takeProfitPrice !== undefined) exits.push(`take profit at ${price(leg.takeProfitPrice)}`);
      const tail = exits.length ? `, ${exits.join(", ")}` : "";
      const market = resolved?.symbol ?? leg.market;
      return `${leg.side === "long" ? "Long" : "Short"} ${market} on ${where}: ${usd(margin)} margin at ${leg.leverage}x (${usd(notional)} position)${tail}`;
    }
    case "perp_close": {
      const share = leg.fraction >= 1 ? "Close" : `Close ${Math.round(leg.fraction * 100)}% of`;
      return `${share} your ${resolved?.symbol ?? leg.market} position on ${where}`;
    }
    case "swap": {
      const token = resolved?.symbol ?? leg.token;
      if (leg.side === "buy") {
        const amt = leg.amount.type === "usd" ? usd(leg.amount.usd) : `${Math.round(leg.amount.fraction * 100)}% of your USDC`;
        return `Buy ${amt} of ${token} on ${where}`;
      }
      const amt = leg.amount.type === "fraction" ? `${Math.round(leg.amount.fraction * 100)}% of your` : `${usd(leg.amount.usd)} of`;
      return `Sell ${amt} ${token} on ${where}`;
    }
  }
}

export function describeCondition(c: Condition): string {
  switch (c.type) {
    case "price":
      return `${c.market} price ${c.op} ${price(c.value)}`;
    case "funding":
      return `${c.market} funding ${c.op} ${c.value}%/h`;
    case "time":
      return `after ${new Date(c.after).toUTCString()}`;
  }
}

export function describeConditionStatus(s: ConditionStatus): string {
  const mark = s.met ? "✅" : "⏳";
  const c = s.condition;
  let now = "";
  if (s.current === null) now = " (no data yet)";
  else if (c.type === "price") now = ` (now ${price(Number(s.current))})`;
  else if (c.type === "funding") now = ` (now ${Number(s.current).toFixed(4)}%/h)`;
  return `${mark} ${describeCondition(c)}${now}`;
}

export function describeStep(step: PlanStep, resolved?: ResolvedStep): string {
  const leg = describeLeg(step.leg, resolved);
  if (step.when.length === 0) return leg;
  return `${leg}, when ${step.when.map(describeCondition).join(" and ")}`;
}

export function describeDecision(decision: PolicyDecision, resolved: ResolvedStep[]): string {
  const lines: string[] = [];
  for (const d of decision.steps) {
    const r = resolved.find((x) => x.index === d.index);
    if (!r) continue;
    const icon = d.verdict === "reject" ? "❌" : d.verdict === "confirm" ? "🟡" : "🟢";
    lines.push(`${icon} ${describeStep(r.step, r)}`);
    for (const reason of d.reasons) lines.push(`   • ${reason}`);
    for (const w of d.warnings) lines.push(`   ⚠️ ${w}`);
  }
  for (const reason of decision.reasons) lines.push(`❌ ${reason}`);
  return lines.join("\n");
}
