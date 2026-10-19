import type { Limits } from "./limits.js";
import type { PlanStep } from "./plan.js";

/**
 * A plan step after the adapter has looked up the market: what it costs and
 * what the venue allows. Policy only ever sees resolved steps, so every check
 * runs against real numbers rather than the agent's guesses.
 */
export interface ResolvedStep {
  index: number;
  step: PlanStep;
  /** Canonical venue symbol, e.g. "BTC" or "xyz:GOLD", or a token mint. */
  symbol: string;
  /** USD this leg takes out of the wallet: perp margin or swap input. 0 for closes and sells. */
  spendUsd: number;
  /** Full position size for perps, equal to spendUsd for swaps. */
  notionalUsd: number;
  /** Venue's own leverage cap for this market, when it has one. */
  venueMaxLeverage?: number;
  /** False when a token could not be matched to a verified list. */
  verifiedToken?: boolean;
}

export interface PolicyState {
  spentTodayUsd: number;
  openPositions: number;
}

export type Verdict = "execute" | "confirm" | "reject";

export interface StepDecision {
  index: number;
  verdict: Verdict;
  reasons: string[];
  warnings: string[];
}

export interface PolicyDecision {
  verdict: Verdict;
  steps: StepDecision[];
  /** Plan-wide reasons (kill switch, daily cap). */
  reasons: string[];
}

export interface PolicyOptions {
  /**
   * True when the watcher is firing a conditional step that the user already
   * approved. Confirmation is not asked twice, but every cap is checked again.
   */
  preApproved?: boolean;
}

const fmt = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function evaluatePolicy(
  steps: ResolvedStep[],
  limits: Limits,
  state: PolicyState,
  options: PolicyOptions = {},
): PolicyDecision {
  const planReasons: string[] = [];
  if (limits.paused) {
    planReasons.push("Fren is stopped. Send /resume to trade again.");
  }

  let newPositions = 0;
  let spendNow = 0;
  let spendTotal = 0;

  const decisions: StepDecision[] = steps.map((r) => {
    const reasons: string[] = [];
    const warnings: string[] = [];
    const leg = r.step.leg;
    let needsConfirm = false;

    if (!limits.allowedVenues.includes(leg.venue)) {
      reasons.push(`${leg.venue} is not on your allowed venues.`);
    }
    if (r.spendUsd > limits.maxTradeUsd) {
      reasons.push(`Spends ${fmt(r.spendUsd)}, over your per-trade cap of ${fmt(limits.maxTradeUsd)}.`);
    }

    if (leg.kind === "perp_open") {
      if (leg.leverage > limits.maxLeverage) {
        reasons.push(`${leg.leverage}x is over your max leverage of ${limits.maxLeverage}x.`);
      }
      if (r.venueMaxLeverage !== undefined && leg.leverage > r.venueMaxLeverage) {
        reasons.push(`${r.symbol} allows at most ${r.venueMaxLeverage}x on ${leg.venue}.`);
      }
      // Liquidation hits before the margin is fully gone because of maintenance
      // margin, so a stop at or beyond ~80% of margin may never trigger.
      const liqMovePct = 100 / leg.leverage;
      if (leg.stopLossPct !== undefined && leg.stopLossPct >= 80) {
        warnings.push(`A stop at -${leg.stopLossPct}% of margin is at or past liquidation; liquidation will likely hit first.`);
      }
      if (leg.stopLossPct === undefined && leg.stopPrice === undefined && leg.leverage >= 25) {
        warnings.push(`No stop set at ${leg.leverage}x; a ${liqMovePct.toFixed(1)}% move against you wipes the margin.`);
      }
      newPositions += 1;
    }

    if (leg.kind === "swap" && leg.side === "buy" && r.verifiedToken === false) {
      warnings.push(`${r.symbol} is not on a verified token list. Check the address.`);
      needsConfirm = true;
    }

    const isNow = r.step.when.length === 0;
    if (isNow) spendNow += r.spendUsd;
    spendTotal += r.spendUsd;

    if (r.spendUsd > limits.autoApproveUsd) needsConfirm = true;

    const verdict: Verdict = reasons.length > 0 ? "reject" : needsConfirm ? "confirm" : "execute";
    return { index: r.index, verdict, reasons, warnings };
  });

  if (state.spentTodayUsd + spendNow > limits.maxDailyUsd) {
    planReasons.push(
      `Would bring today's spend to ${fmt(state.spentTodayUsd + spendNow)}, over your daily cap of ${fmt(limits.maxDailyUsd)}.`,
    );
  }
  if (state.openPositions + newPositions > limits.maxOpenPositions) {
    planReasons.push(`Would open ${newPositions} more position(s); your cap is ${limits.maxOpenPositions} open.`);
  }
  if (!options.preApproved && spendTotal > limits.autoApproveUsd) {
    for (const d of decisions) if (d.verdict === "execute") d.verdict = "confirm";
  }
  if (options.preApproved) {
    for (const d of decisions) if (d.verdict === "confirm") d.verdict = "execute";
  }

  let verdict: Verdict;
  if (planReasons.length > 0 || decisions.some((d) => d.verdict === "reject")) verdict = "reject";
  else if (decisions.some((d) => d.verdict === "confirm")) verdict = "confirm";
  else verdict = "execute";

  return { verdict, steps: decisions, reasons: planReasons };
}
