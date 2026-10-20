# Fren

A self-hosted [OpenClaw](https://github.com/openclaw/openclaw) agent that trades on-chain from a chat window. Tell it on Telegram or WhatsApp, "long gold 20x with $500, stop at -30%," and it finds the market, checks your limits, signs with keys that never leave your machine, and replies once with what it did.

Status: **early backend**. It does Hyperliquid perps (crypto, gold, stocks, indices), Solana spot through Jupiter, pump.fun coins (on the curve and after), launch snipes, tokens on Base and Robinhood Chain through Relay, options on Derive, Polymarket bets, USDC yield on Jupiter Lend, Kamino and Aave, conditional orders, stops and targets, paper mode, and a kill switch (see [docs/ROADMAP.md](docs/ROADMAP.md) for what's next).

## How it works

```
Telegram / WhatsApp
      │
OpenClaw agent ── fren plugin (tools + /ok /stop /limits /resume)
      │  plans only, no keys
      ▼
fren engine (local HTTP API on 127.0.0.1)
  ├─ policy: your caps, leverage, venues, daily spend. No LLM.
  ├─ venues: Hyperliquid, Jupiter + pump.fun, Relay, Derive, Polymarket,
  │          Jupiter Lend, Kamino, Aave (paper or live)
  ├─ watcher: checks conditions every 15s (launch snipes every 2s). No LLM.
  └─ signer (separate process): holds the keys, refuses withdrawals,
     transfers to strangers and unknown programs
```

The model thinks, but it never signs and never polls. Anything that spends over your auto-approve level, loosens a limit, or turns Fren back on after a stop needs a code that goes straight to you on Telegram or WhatsApp, around the model. See [docs/SECURITY.md](docs/SECURITY.md).

| Package | What |
| --- | --- |
| `packages/core` | Plan schema, policy engine, condition evaluation, plain-English rendering. Pure and heavily tested. |
| `packages/signer` | Encrypted keystore, wallet creation, and the signer process with its hard rules. |
| `packages/engine` | The `fren` CLI and daemon: venues, watcher, SQLite state, local API. |
| `packages/openclaw-plugin` | The OpenClaw plugin: agent tools, owner commands, and the skill that teaches the agent the grammar. |

## Quick start

Needs Node 24.16+ and OpenClaw 2026.10.5+.

```bash
npm ci
npm run build

# Create wallets, API token and config in ~/.fren. Starts in paper mode on Hyperliquid testnet.
# --notify is where codes and alerts reach you: any channel your OpenClaw gateway is connected to.
node packages/engine/dist/cli.js init --network testnet --notify whatsapp:+15551234567

# On Telegram, the bot token sends codes the agent never sees (repeat --notify for a fallback):
#   init --telegram-token <your OpenClaw Telegram bot token> --telegram-chat <your Telegram user id>

node packages/engine/dist/cli.js start

# In another terminal: install the plugin into OpenClaw
openclaw plugins install --link --accept-capabilities ./packages/openclaw-plugin
```

For snipes, get a free Jupiter API key at portal.jup.ag and put it in `~/.fren/config.json` as `jupiterApiKey`; without one Jupiter allows about one request every two seconds.

For WhatsApp, link it in OpenClaw first (`openclaw channels login --channel whatsapp`). A separate number for OpenClaw works best: chat with it from your own phone, and `--notify` your own number. Fren sends through the running gateway, so keep it up.

Then talk to your OpenClaw bot:

- "what's my wallet" shows where to send USDC (Solana for Solana coins, Arbitrum or Base for perps and EVM tokens).
- "long BTC 10x with $50, stop at -20%"
- "buy $25 of JUP"
- "buy $50 of <pump.fun CA>"
- "snipe <CA> on Base with $100 the second it launches"
- "short SOL $100 at 5x when funding goes above 0.02%/h"
- "best way to bet ETH hits $4,000 by December, use $1,000" quotes the nearest Derive call and the matching Polymarket market side by side, then places the one you pick
- "stake my USDC for the best yield" lends it wherever the rate is best (Jupiter Lend or Kamino on Solana, Aave on Arbitrum or Base). When a trade needs the cash, Fren takes it back on its own first.
- "fund Polymarket with $500" moves USDC from Arbitrum to your Polymarket wallet (or "fund Derive" for options)
- "stop everything"

Owner commands, which skip the model:

| Command | Does |
| --- | --- |
| `/ok CODE` | Approve a plan or a settings change |
| `/stop` (or `/stop keep`) | Kill switch: pause, cancel waiting plans, close leveraged positions (or keep them) |
| `/resume` | Turn Fren back on (sends a code) |
| `/limits key=value …` | e.g. `/limits mode=live maxTradeUsd=2000 maxLeverage=40` (loosening sends a code) |
| `/positions`, `/wallet` | Read-only views |

## Limits

Defaults: paper mode, $500 per trade, $2,000 per day, 20x max leverage, 10 open positions, auto-approve up to $100, all venues allowed. The agent can tighten these. Only you can loosen them.

## Development

```bash
npm run build && npm test
```

Tests run against fakes of the Hyperliquid, Jupiter, Relay, Derive, Polymarket, Jupiter Lend, Kamino and Aave APIs and an in-process signer. Derive signatures are checked byte for byte against Derive's own SDK, plus one test that spawns the real signer process. Nothing in CI touches a real network or real money.
