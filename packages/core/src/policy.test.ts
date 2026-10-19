import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, Limits, applyLimitArgs, isTightening } from "./limits.js";
import { parsePlan } from "./plan.js";
import { evaluatePolicy, type ResolvedStep } from "./policy.js";
import { describeDecision } from "./render.js";

function perpStep(over: { margin?: number; leverage?: number; stop?: number; when?: unknown[] } = {}) {
  const plan = parsePlan({
    request: "test",
    steps: [
      {
        leg: {
          kind: "perp_open",
          venue: "hyperliquid",
          market: "BTC",
          side: "long",
          sizing: { type: "margin", usd: over.margin ?? 50 },
          leverage: over.leverage ?? 10,
          stopLossPct: over.stop,
        },
        when: over.when ?? [],
      },
    ],
  });
  const step = plan.steps[0]!;
  const margin = over.margin ?? 50;
  const lev = over.leverage ?? 10;
  return { index: 0, step, symbol: "BTC", spendUsd: margin, notionalUsd: margin * lev, venueMaxLeverage: 40 } satisfies ResolvedStep;
}

const state = { spentTodayUsd: 0, openPositions: 0 };

describe("evaluatePolicy", () => {
  it("auto-executes a small trade within every cap", () => {
    const d = evaluatePolicy([perpStep()], DEFAULT_LIMITS, state);
    expect(d.verdict).toBe("execute");
  });

  it("asks for confirmation above the auto-approve threshold", () => {
    const d = evaluatePolicy([perpStep({ margin: 300 })], DEFAULT_LIMITS, state);
    expect(d.verdict).toBe("confirm");
  });

  it("asks for confirmation when small legs add up past the threshold", () => {
    const d = evaluatePolicy([perpStep({ margin: 60 }), { ...perpStep({ margin: 60 }), index: 1 }], DEFAULT_LIMITS, state);
    expect(d.verdict).toBe("confirm");
  });

  it("rejects over the per-trade cap", () => {
    const d = evaluatePolicy([perpStep({ margin: 2000 })], DEFAULT_LIMITS, state);
    expect(d.verdict).toBe("reject");
    expect(d.steps[0]!.reasons.join()).toMatch(/per-trade cap/);
  });

  it("rejects leverage above the user's max and above the venue's max", () => {
    const limits = Limits.parse({ maxLeverage: 100 });
    const d = evaluatePolicy([perpStep({ leverage: 100 })], limits, state);
    expect(d.verdict).toBe("reject");
    expect(d.steps[0]!.reasons.join()).toMatch(/at most 40x/);
    const d2 = evaluatePolicy([perpStep({ leverage: 30 })], DEFAULT_LIMITS, state);
    expect(d2.steps[0]!.reasons.join()).toMatch(/max leverage of 20x/);
  });

  it("rejects everything when paused", () => {
    const d = evaluatePolicy([perpStep()], Limits.parse({ paused: true }), state);
    expect(d.verdict).toBe("reject");
    expect(d.reasons[0]).toMatch(/stopped/);
  });

  it("enforces the daily cap using only legs that fire now", () => {
    const busy = { spentTodayUsd: 1990, openPositions: 0 };
    expect(evaluatePolicy([perpStep()], DEFAULT_LIMITS, busy).verdict).toBe("reject");
    const later = perpStep({ when: [{ type: "time", after: "2030-01-01T00:00:00Z" }] });
    expect(evaluatePolicy([later], DEFAULT_LIMITS, busy).verdict).toBe("execute");
  });

  it("warns when the stop is past liquidation or missing at high leverage", () => {
    const d = evaluatePolicy([perpStep({ leverage: 20, stop: 90 })], DEFAULT_LIMITS, state);
    expect(d.steps[0]!.warnings.join()).toMatch(/past liquidation/);
    const limits = Limits.parse({ maxLeverage: 40 });
    const d2 = evaluatePolicy([perpStep({ leverage: 40 })], limits, state);
    expect(d2.steps[0]!.warnings.join()).toMatch(/No stop set at 40x/);
  });

  it("does not re-ask for confirmation at fire time but still checks caps", () => {
    const big = perpStep({ margin: 300 });
    expect(evaluatePolicy([big], DEFAULT_LIMITS, state, { preApproved: true }).verdict).toBe("execute");
    const tight = Limits.parse({ maxTradeUsd: 100 });
    expect(evaluatePolicy([big], tight, state, { preApproved: true }).verdict).toBe("reject");
  });

  it("renders a readable summary", () => {
    const d = evaluatePolicy([perpStep({ margin: 300, stop: 5 })], DEFAULT_LIMITS, state);
    expect(describeDecision(d, [perpStep({ margin: 300, stop: 5 })])).toContain(
      "Long BTC on Hyperliquid: $300 margin at 10x ($3,000 position), stop at -5% of margin (0.50% price move)",
    );
  });
});

describe("limits", () => {
  it("parses owner /limits arguments", () => {
    const next = applyLimitArgs(DEFAULT_LIMITS, "maxTradeUsd=2,500 mode=live maxLeverage=40");
    expect(next.maxTradeUsd).toBe(2500);
    expect(next.mode).toBe("live");
    expect(next.maxLeverage).toBe(40);
  });

  it("rejects unknown keys", () => {
    expect(() => applyLimitArgs(DEFAULT_LIMITS, "yolo=1")).toThrow(/Unknown limit/);
  });

  it("only treats stricter changes as tightening", () => {
    expect(isTightening(DEFAULT_LIMITS, Limits.parse({ maxTradeUsd: 100 }))).toBe(true);
    expect(isTightening(DEFAULT_LIMITS, Limits.parse({ maxTradeUsd: 1000 }))).toBe(false);
    expect(isTightening(DEFAULT_LIMITS, Limits.parse({ mode: "live" }))).toBe(false);
    expect(isTightening(Limits.parse({ paused: true }), DEFAULT_LIMITS)).toBe(false);
  });
});
