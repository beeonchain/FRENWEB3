import { describe, expect, it } from "vitest";
import { evaluateAll } from "./conditions.js";
import { safeParsePlan } from "./plan.js";

describe("Plan schema", () => {
  it("accepts the brief's two-leg example", () => {
    const r = safeParsePlan({
      request: "$300 gold 20x long, stop -4%, and short SOL $200 when funding goes above 0.02%/h",
      steps: [
        {
          leg: {
            kind: "perp_open",
            venue: "hyperliquid",
            market: "xyz:GOLD",
            side: "long",
            sizing: { type: "margin", usd: 300 },
            leverage: 20,
            stopLossPct: 4,
          },
        },
        {
          leg: {
            kind: "perp_open",
            venue: "hyperliquid",
            market: "SOL",
            side: "short",
            sizing: { type: "margin", usd: 200 },
            leverage: 5,
          },
          when: [{ type: "funding", venue: "hyperliquid", market: "SOL", op: ">", value: 0.02 }],
        },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.data?.steps[0]?.when).toEqual([]);
    expect(r.data?.steps[0]?.leg.kind === "perp_open" && r.data.steps[0].leg.maxSlippagePct).toBe(1);
  });

  it("rejects unknown venues and negative sizes", () => {
    expect(
      safeParsePlan({
        request: "x",
        steps: [{ leg: { kind: "swap", venue: "uniswap", side: "buy", token: "X", amount: { type: "usd", usd: 5 } } }],
      }).success,
    ).toBe(false);
    expect(
      safeParsePlan({
        request: "x",
        steps: [{ leg: { kind: "swap", venue: "jupiter", side: "buy", token: "X", amount: { type: "usd", usd: -5 } } }],
      }).success,
    ).toBe(false);
  });
});

describe("conditions", () => {
  it("needs every condition to hold and treats missing data as not met", () => {
    const snap = {
      now: new Date("2026-10-19T12:00:00Z"),
      prices: new Map([["hyperliquid:BTC", 101_000]]),
      funding: new Map<string, number>(),
    };
    const res = evaluateAll(
      [
        { type: "price", venue: "hyperliquid", market: "BTC", op: ">", value: 100_000 },
        { type: "funding", venue: "hyperliquid", market: "BTC", op: "<", value: 0 },
      ],
      snap,
    );
    expect(res.statuses[0]!.met).toBe(true);
    expect(res.statuses[1]!.met).toBe(false);
    expect(res.statuses[1]!.current).toBeNull();
    expect(res.allMet).toBe(false);
  });
});
