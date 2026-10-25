import { describeOption, price as fmtPrice, shortDate, usd as fmtUsd, type PlanInput } from "@fren/core";
import type { DeriveVenue, OptionQuote } from "./venues/derive.js";
import type { PolymarketVenue, PredictionQuote } from "./venues/polymarket.js";

/**
 * "ETH hits $4,000 by December, use $1,000": the two ways to bet on a price
 * target, quoted side by side so the owner picks. An option pays more the
 * further past the target the price ends; a prediction market pays a fixed
 * $1 a share if its question resolves Yes.
 */

export interface BetQuery {
  /** Underlying, e.g. "ETH". */
  asset: string;
  target: number;
  direction: "above" | "below";
  /** ISO date the bet should be decided by. */
  by: string;
  budgetUsd: number;
}

export interface BetQuote {
  text: string;
  /** Ready-to-submit plans, one per venue that had something. */
  plans: { derive?: PlanInput; polymarket?: PlanInput };
}

const NAMES: Record<string, string[]> = {
  BTC: ["Bitcoin", "BTC"],
  ETH: ["Ethereum", "ETH"],
  SOL: ["Solana", "SOL"],
  HYPE: ["Hyperliquid", "HYPE"],
  XRP: ["XRP"],
  DOGE: ["Dogecoin", "DOGE"],
};

const cents = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}¢`;
const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 });

export async function quoteBet(venues: { derive: DeriveVenue; polymarket: PolymarketVenue }, q: BetQuery, request: string): Promise<BetQuote> {
  const asset = q.asset.toUpperCase().replace(/^\$/, "");
  const by = new Date(q.by);
  if (Number.isNaN(by.getTime())) throw new Error(`"${q.by}" isn't a date.`);
  if (by.getTime() < Date.now()) throw new Error("That date has passed.");

  const [option, prediction] = await Promise.all([
    venues.derive.bestOption({ asset, target: q.target, direction: q.direction, by, budgetUsd: q.budgetUsd }).catch(() => null),
    venues.polymarket.bestMarket({ assetNames: NAMES[asset] ?? [asset], target: q.target, direction: q.direction, by, budgetUsd: q.budgetUsd }).catch(() => null),
  ]);

  const head = `${asset} ${q.direction} ${fmtPrice(q.target)} by ${shortDate(by)}, with ${fmtUsd(q.budgetUsd)}${option?.spot ? `. ${asset} is ${fmtPrice(option.spot)} now` : ""}.`;
  const lines = [head, ""];
  const plans: BetQuote["plans"] = {};

  if (option) {
    lines.push(...describeOptionQuote(asset, option, q.budgetUsd));
    plans.derive = {
      request,
      steps: [{ leg: { kind: "option", venue: "derive", side: "buy", instrument: option.instrument, amount: { type: "usd", usd: q.budgetUsd } } }],
    };
  } else lines.push(`1) Option on Derive: nothing listed for ${asset} near ${fmtPrice(q.target)} around that date.`);
  lines.push("");

  if (prediction) {
    lines.push(...describePredictionQuote(prediction, q.budgetUsd));
    plans.polymarket = {
      request,
      steps: [
        {
          leg: {
            kind: "prediction",
            venue: "polymarket",
            side: "buy",
            market: prediction.market.slug,
            outcome: prediction.outcome.label,
            amount: { type: "usd", usd: q.budgetUsd },
            // Room for the price to tick up between quote and order, never past 99¢.
            limitPrice: Math.min(0.99, Number((prediction.avgPrice + 0.03).toFixed(2))),
          },
        },
      ],
    };
  } else lines.push(`2) Polymarket: no open market on ${asset} ${q.direction === "above" ? "reaching" : "falling to"} ${fmtPrice(q.target)} around that date.`);

  if (option && prediction) {
    lines.push(
      "",
      prediction.kind === "touch"
        ? `The Polymarket bet wins if ${asset} trades at ${fmtPrice(q.target)} for a moment before it ends. The option needs ${asset} past ${fmtPrice(option.strike)} on its expiry day, and pays more the further past it is.`
        : `Both need ${asset} past the level on one day. The option pays more the further past it ends; the Polymarket bet pays a fixed amount.`,
    );
  }
  if (option || prediction) lines.push("", "Say which one and I'll set it up.");
  return { text: lines.join("\n"), plans };
}

function describeOptionQuote(asset: string, o: OptionQuote, budget: number): string[] {
  const side = o.type === "call" ? "above" : "below";
  const at = (px: number) => Math.max(0, o.type === "call" ? px - o.strike : o.strike - px) * o.contracts;
  const scen = o.type === "call" ? [o.strike * 1.1, o.strike * 1.25] : [o.strike * 0.9, o.strike * 0.75];
  const roundTo = (x: number) => Math.round(x / (x >= 1000 ? 100 : 1)) * (x >= 1000 ? 100 : 1);
  const [s1, s2] = scen.map(roundTo) as [number, number];
  return [
    `1) Option on Derive: ${qty(o.contracts)} contracts of the ${describeOption(o.instrument)} at ${fmtPrice(o.ask)} each (${fmtUsd(o.costUsd)} of your ${fmtUsd(budget)}).`,
    `   Pays ${fmtUsd(o.contracts)} for every $1 ${asset} is ${side} ${fmtPrice(o.strike)} at 08:00 UTC on ${shortDate(o.expiry)}. Break-even ${fmtPrice(o.breakEven)}.`,
    `   At ${fmtPrice(s1)} you'd get ${fmtUsd(at(s1))}; at ${fmtPrice(s2)}, ${fmtUsd(at(s2))}. ${o.type === "call" ? "At or below" : "At or above"} ${fmtPrice(o.strike)} you lose the premium.`,
  ];
}

function describePredictionQuote(p: PredictionQuote, budget: number): string[] {
  const ends = p.market.endDate ? ` It ends ${shortDate(new Date(p.market.endDate))}.` : "";
  const rule = p.kind === "touch" ? "if the price touches the level at any point" : "if the question resolves Yes";
  return [
    `2) Polymarket: "${p.market.question}" ${p.outcome.label} at ${cents(p.avgPrice)} a share.`,
    `   ${qty(p.shares)} shares for ${fmtUsd(p.costUsd)}${p.costUsd < budget * 0.98 ? ` (only that much is for sale near this price)` : ""} pay ${fmtUsd(p.shares)} ${rule}; otherwise you lose the stake.${ends}`,
  ];
}
