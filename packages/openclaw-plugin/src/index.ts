import { Type, type TSchema } from "typebox";
import { definePluginEntry, type OpenClawPluginApi, type OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { EngineClient, type OwnerResult } from "./client.js";
import planSchema from "./plan-schema.json" with { type: "json" };

/**
 * Fren for OpenClaw. The agent gets tools that propose plans and read state;
 * the owner gets slash commands (which bypass the model) for anything that
 * approves, loosens or resumes. Keys stay in the Fren engine's signer process.
 */

export const TOOL_NAMES = [
  "fren_wallet",
  "fren_markets",
  "fren_trade",
  "fren_status",
  "fren_cancel",
  "fren_stop",
  "fren_limits",
  "fren_deposit_hyperliquid",
  "fren_bet_quote",
  "fren_fund",
  "fren_yield",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

interface ToolSpec {
  name: ToolName;
  label: string;
  description: string;
  parameters: TSchema;
  run(params: Record<string, unknown>, ctx: OpenClawPluginToolContext): Promise<string>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: { text: t } });

/**
 * When the engine has no private line to the owner it hands back the code. Send
 * it straight to the conversation and keep it out of the model's tool result.
 */
async function deliverOwnerCode(res: OwnerResult, ctx: OpenClawPluginToolContext): Promise<string> {
  if (!res.ownerCode) return res.text;
  const send = ctx.delivery?.send;
  if (send) {
    await send({ text: `🔐 Your Fren code: ${res.ownerCode}\nReply /ok ${res.ownerCode} to approve. Never share it.` });
    return `${res.text}\n(The code was sent to the user directly; you do not have it and cannot approve on their behalf.)`;
  }
  return `${res.text}\nNo private channel is set up, so ask the user to run /fren_code to see the code.`;
}

export function toolSpecs(client: EngineClient): ToolSpec[] {
  return [
    {
      name: "fren_wallet",
      label: "Fren wallet",
      description: "Show the user's Fren wallet addresses, balances, and how to fund them.",
      parameters: Type.Object({}),
      run: async () => (await client.call<{ text: string }>("GET", "/wallet")).text,
    },
    {
      name: "fren_markets",
      label: "Find a market",
      description:
        "Search Hyperliquid perps (crypto, gold, stocks, indices), Solana tokens (pump.fun included) and tokens on Base, Robinhood Chain and Arbitrum. Call this before fren_trade whenever you are not sure of the exact symbol, mint or contract address.",
      parameters: Type.Object({ query: Type.String({ description: 'What the user called it: "gold", "nasdaq", "BTC", "bonk", or a contract address.' }) }),
      run: async (p) => (await client.call<{ text: string }>("GET", `/markets?q=${encodeURIComponent(String(p.query))}`)).text,
    },
    {
      name: "fren_trade",
      label: "Trade",
      description: [
        "Propose a trading plan built from the user's request. Fren checks it against the user's limits, then either executes it,",
        "asks the user for a confirmation code, or refuses with reasons. Relay the returned text to the user as-is.",
        "One plan can hold several legs; legs with `when` conditions wait for the watcher.",
        'To snipe a launch, add when: [{type:"tradable", venue, chain, token}] with the same contract address.',
        "Never invent token addresses: use one the user gave or one fren_markets returned.",
      ].join(" "),
      parameters: Type.Object({ plan: Type.Unsafe<Record<string, unknown>>(planSchema) }),
      run: async (p, ctx) => deliverOwnerCode(await client.call<OwnerResult>("POST", "/plans", { plan: p.plan }), ctx),
    },
    {
      name: "fren_status",
      label: "Positions",
      description: "Show open positions, watched conditions with live values, pending approvals and today's spend.",
      parameters: Type.Object({}),
      run: async () => (await client.call<{ text: string }>("GET", "/status")).text,
    },
    {
      name: "fren_cancel",
      label: "Cancel plan",
      description: "Cancel a waiting or unconfirmed plan by its id (shown in fren_status).",
      parameters: Type.Object({ planId: Type.String() }),
      run: async (p) => (await client.call<{ text: string }>("POST", "/cancel", { planId: p.planId })).text,
    },
    {
      name: "fren_stop",
      label: "Kill switch",
      description: 'Kill switch for "stop everything": pauses Fren, cancels waiting plans, and (flatten=true) closes all leveraged positions.',
      parameters: Type.Object({ flatten: Type.Boolean({ default: true }) }),
      run: async (p) => (await client.call<{ text: string }>("POST", "/stop", { flatten: p.flatten !== false })).text,
    },
    {
      name: "fren_limits",
      label: "Limits",
      description:
        "Change the user's trading limits with key=value pairs: maxTradeUsd, maxDailyUsd, maxLeverage, maxOpenPositions, autoApproveUsd, mode (paper|live). Tightening applies at once; loosening sends the user a code. Pass an empty string to read the current limits.",
      parameters: Type.Object({ args: Type.String({ description: 'e.g. "maxTradeUsd=2000 maxLeverage=40"' }) }),
      run: async (p, ctx) => {
        const args = String(p.args ?? "").trim();
        if (!args) return (await client.call<{ text: string }>("GET", "/limits")).text;
        return deliverOwnerCode(await client.call<OwnerResult>("POST", "/limits", { args }), ctx);
      },
    },
    {
      name: "fren_deposit_hyperliquid",
      label: "Fund Hyperliquid",
      description: "Move USDC from the user's own Arbitrum address into their own Hyperliquid account (minimum 5 USDC).",
      parameters: Type.Object({ amountUsd: Type.Number({ minimum: 5 }) }),
      run: async (p) => (await client.call<{ text: string }>("POST", "/deposit/hyperliquid", { amountUsd: p.amountUsd })).text,
    },
    {
      name: "fren_bet_quote",
      label: "Quote a price bet",
      description: [
        'Quote a bet on a price target, e.g. "ETH hits $4,000 by December, use $1,000": the best matching call (or put) option on Derive',
        "and the best matching Polymarket market, side by side. Places nothing. Show the owner the comparison as-is; when they pick one,",
        "call fren_trade with the matching plan below the comparison, unchanged.",
      ].join(" "),
      parameters: Type.Object({
        asset: Type.String({ description: 'Underlying ticker, e.g. "ETH", "BTC", "SOL".' }),
        target: Type.Number({ description: "Target price in USD, e.g. 4000." }),
        direction: Type.Union([Type.Literal("above"), Type.Literal("below")], { description: '"above" for hits/reaches/over, "below" for drops/falls/under.' }),
        by: Type.String({ description: 'ISO date the bet is decided by. "By December" means the end of December: 2026-12-31.' }),
        budgetUsd: Type.Number({ minimum: 1, description: "How much the owner wants to put in, in USD." }),
        request: Type.Optional(Type.String({ description: "The owner's message, word for word." })),
      }),
      run: async (p) => {
        const q = await client.call<{ text: string; plans: Record<string, unknown> }>("POST", "/bets/quote", p);
        const plans = Object.entries(q.plans ?? {});
        if (!plans.length) return q.text;
        return `${q.text}\n\n(For you, not the owner: the plan for each choice, to pass to fren_trade as-is.)\n${plans.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}`;
      },
    },
    {
      name: "fren_yield",
      label: "USDC yield",
      description:
        "Show current USDC lending rates on Jupiter Lend, Kamino (Solana) and Aave (Arbitrum, Base), and what the owner has lent where. Read-only; deposits and withdrawals go through fren_trade with an earn leg.",
      parameters: Type.Object({}),
      run: async () => (await client.call<{ text: string }>("GET", "/yield")).text,
    },
    {
      name: "fren_fund",
      label: "Fund options or bets",
      description:
        "Move USDC from the owner's Arbitrum (or Base) address to their own Derive account (options) or Polymarket wallet (bets). Live mode only. Always sends the owner a code to approve.",
      parameters: Type.Object({
        venue: Type.Union([Type.Literal("derive"), Type.Literal("polymarket")]),
        amountUsd: Type.Number({ minimum: 10 }),
      }),
      run: async (p, ctx) => deliverOwnerCode(await client.call<OwnerResult>("POST", "/fund", { venue: p.venue, amountUsd: p.amountUsd }), ctx),
    },
  ];
}

function registerTools(api: OpenClawPluginApi, client: EngineClient) {
  for (const spec of toolSpecs(client)) {
    api.registerTool(
      (ctx) => {
        // Only the owner trades. Other people in a group chat never see these tools.
        if (ctx.senderIsOwner === false) return null;
        return {
          name: spec.name,
          label: spec.label,
          description: spec.description,
          parameters: spec.parameters,
          async execute(_id: string, params: Record<string, unknown>) {
            try {
              return text(await spec.run(params ?? {}, ctx));
            } catch (err) {
              return text(`Fren error: ${(err as Error).message}`);
            }
          },
        };
      },
      { name: spec.name },
    );
  }
}

/** The last code handed back when there was no private line, for /fren_code. Command replies never pass through the model. */
let lastOwnerCode: { code: string; at: number } | null = null;

function ownerReply(res: OwnerResult): string {
  if (!res.ownerCode) return res.text;
  lastOwnerCode = { code: res.ownerCode, at: Date.now() };
  return `${res.text}\n\n🔐 Code: ${res.ownerCode} (send /ok ${res.ownerCode})`;
}

function registerCommands(api: OpenClawPluginApi, client: EngineClient) {
  const ownerOnly = "Only the owner of this Fren can do that.";
  const guard = async (isOwner: boolean | undefined, run: () => Promise<string>) => {
    if (isOwner !== true) return { text: ownerOnly };
    try {
      return { text: await run() };
    } catch (err) {
      return { text: `Fren error: ${(err as Error).message}` };
    }
  };

  api.registerCommand({
    name: "ok",
    description: "Approve a Fren plan or settings change with the code Fren sent you.",
    acceptsArgs: true,
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: (ctx) =>
      guard(ctx.senderIsOwner, async () => {
        const code = (ctx.args ?? "").trim();
        if (!code) return "Send /ok followed by the code.";
        return (await client.call<{ text: string }>("POST", "/approve", { code })).text;
      }),
  });

  api.registerCommand({
    name: "stop",
    description: "Kill switch: pause Fren and close leveraged positions. /stop keep pauses without closing.",
    acceptsArgs: true,
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: (ctx) =>
      guard(ctx.senderIsOwner, async () => {
        const flatten = (ctx.args ?? "").trim().toLowerCase() !== "keep";
        return (await client.call<{ text: string }>("POST", "/stop", { flatten })).text;
      }),
  });

  api.registerCommand({
    name: "resume",
    description: "Turn Fren back on after /stop.",
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: (ctx) => guard(ctx.senderIsOwner, async () => ownerReply(await client.call<OwnerResult>("POST", "/resume"))),
  });

  api.registerCommand({
    name: "limits",
    description: "Show or change Fren limits, e.g. /limits maxTradeUsd=2000 maxLeverage=40 mode=live",
    acceptsArgs: true,
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: (ctx) =>
      guard(ctx.senderIsOwner, async () => {
        const args = (ctx.args ?? "").trim();
        if (!args) return (await client.call<{ text: string }>("GET", "/limits")).text;
        return ownerReply(await client.call<OwnerResult>("POST", "/limits", { args }));
      }),
  });

  api.registerCommand({
    name: "positions",
    description: "Fren positions and watched conditions.",
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: (ctx) => guard(ctx.senderIsOwner, async () => (await client.call<{ text: string }>("GET", "/status")).text),
  });

  api.registerCommand({
    name: "wallet",
    description: "Fren wallet addresses and how to fund them.",
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: (ctx) => guard(ctx.senderIsOwner, async () => (await client.call<{ text: string }>("GET", "/wallet")).text),
  });

  api.registerCommand({
    name: "fren_code",
    description: "Show the latest Fren approval code when no private channel is configured.",
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: (ctx) =>
      guard(ctx.senderIsOwner, async () => {
        if (!lastOwnerCode || Date.now() - lastOwnerCode.at > 10 * 60_000) return "No recent code.";
        return `🔐 Code: ${lastOwnerCode.code} (send /ok ${lastOwnerCode.code})`;
      }),
  });
}

export default definePluginEntry({
  id: "fren",
  name: "Fren",
  description: "Trade perps, spot, options and prediction markets from chat. Keys stay in the local Fren engine.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as { apiUrl?: string; tokenFile?: string };
    const client = new EngineClient({
      ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}),
      ...(cfg.tokenFile ? { tokenFile: cfg.tokenFile } : {}),
    });
    registerTools(api, client);
    const mode = api.registrationMode;
    if (mode !== "cli-metadata" && mode !== "setup-only" && mode !== "tool-discovery") registerCommands(api, client);
  },
});
