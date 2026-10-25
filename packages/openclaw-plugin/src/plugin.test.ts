import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "@fren/engine";
import { buildTestFren, optionName } from "../../engine/src/testing.js";
import plugin, { TOOL_NAMES } from "./index.js";

type Registered = { tools: Map<string, (ctx: Record<string, unknown>) => any>; commands: Map<string, any> };

function loadPlugin(pluginConfig: Record<string, unknown>): Registered {
  const reg: Registered = { tools: new Map(), commands: new Map() };
  const api = {
    registrationMode: "full",
    pluginConfig,
    registerTool: (factory: (ctx: Record<string, unknown>) => unknown, opts: { name: string }) => reg.tools.set(opts.name, factory as never),
    registerCommand: (def: { name: string }) => reg.commands.set(def.name, def),
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(api);
  return reg;
}

describe("OpenClaw plugin against a real engine", () => {
  const dir = mkdtempSync(join(tmpdir(), "fren-plugin-"));
  const tokenFile = join(dir, "api-token");
  writeFileSync(tokenFile, "plugin-test-token");
  // No private line: codes must go out via delivery.send.
  const t = buildTestFren({ privateLine: false });
  const { fren } = t;
  const server = createApi(fren, "plugin-test-token");
  let reg: Registered;

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    reg = loadPlugin({ apiUrl: `http://127.0.0.1:${port}`, tokenFile });
  });
  afterAll(() => server.close());

  const run = async (name: string, params: Record<string, unknown>, ctx: Record<string, unknown> = { senderIsOwner: true }) => {
    const tool = reg.tools.get(name)!(ctx);
    const res = await tool.execute("call-1", params);
    return res.content[0].text as string;
  };

  it("registers every declared tool and the owner commands", () => {
    expect([...reg.tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    expect([...reg.commands.keys()].sort()).toEqual(["fren_code", "limits", "ok", "positions", "resume", "stop", "wallet"]);
  });

  it("hides trading tools from people who aren't the owner", () => {
    expect(reg.tools.get("fren_trade")!({ senderIsOwner: false })).toBeNull();
  });

  it("sends the code around the model and lets only the owner approve it", async () => {
    const delivered: string[] = [];
    const ctx = { senderIsOwner: true, delivery: { send: async (m: { text: string }) => void delivered.push(m.text) } };
    const out = await run(
      "fren_trade",
      {
        plan: {
          request: "long gold 10x with $300",
          steps: [{ leg: { kind: "perp_open", venue: "hyperliquid", market: "gold", side: "long", sizing: { type: "margin", usd: 300 }, leverage: 10 } }],
        },
      },
      ctx,
    );
    expect(out).toMatch(/No Hyperliquid market called gold/);

    const markets = await run("fren_markets", { query: "gold" });
    expect(markets).toContain("xyz:GOLD");

    const out2 = await run(
      "fren_trade",
      {
        plan: {
          request: "long gold 10x with $300",
          steps: [{ leg: { kind: "perp_open", venue: "hyperliquid", market: "xyz:GOLD", side: "long", sizing: { type: "margin", usd: 300 }, leverage: 10 } }],
        },
      },
      ctx,
    );
    const code = /\/ok ([A-Z0-9]{6})/.exec(delivered[0] ?? "")?.[1];
    expect(code).toBeDefined();
    expect(out2).not.toContain(code!);
    expect(out2).toMatch(/you do not have it/);

    const ok = reg.commands.get("ok");
    expect((await ok.handler({ senderIsOwner: false, args: code })).text).toMatch(/Only the owner/);
    expect((await ok.handler({ senderIsOwner: true, args: code })).text).toMatch(/Longed .* xyz:GOLD/);
  });

  it("quotes a price bet both ways and hands the model plans it can submit unchanged", async () => {
    const by = new Date(Date.now() + 60 * 86_400_000);
    t.fake.addOption(optionName("ETH", 55, 4000), { ask: 120, bid: 110, spot: 3_500 });
    t.poly.addMarket({ slug: "eth-4k", question: "Will Ethereum reach $4,000 by December 31?", endDate: by.toISOString(), yesAsk: 0.3 });
    const out = await run("fren_bet_quote", { asset: "ETH", target: 4000, direction: "above", by: by.toISOString().slice(0, 10), budgetUsd: 50 });
    expect(out).toMatch(/1\) Option on Derive: 0\.41 contracts of the ETH \$4,000 call/);
    expect(out).toMatch(/2\) Polymarket: "Will Ethereum reach \$4,000 by December 31\?"/);
    const plan = JSON.parse(/^polymarket: (.*)$/m.exec(out)![1]!);
    expect(await run("fren_trade", { plan })).toMatch(/📝 Paper: Bought 167 "Yes" shares/);
  });

  it("stops everything from the /stop command", async () => {
    const res = await reg.commands.get("stop").handler({ senderIsOwner: true, args: "" });
    expect(res.text).toMatch(/Stopped/);
    expect(res.text).toMatch(/Closed long xyz:GOLD/);
    const resume = await reg.commands.get("resume").handler({ senderIsOwner: true });
    expect(resume.text).toMatch(/Code: [A-Z0-9]{6}/);
  });

  it("explains when the engine isn't running", async () => {
    const dead = loadPlugin({ apiUrl: "http://127.0.0.1:9", tokenFile });
    const res = await dead.tools.get("fren_status")!({ senderIsOwner: true }).execute("x", {});
    expect(res.content[0].text).toMatch(/Can't reach the Fren engine/);
  });
});
