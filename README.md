# Fren

A self-hosted [OpenClaw](https://github.com/openclaw/openclaw) agent that trades on-chain from a chat window. Tell it in Telegram, "long gold 20x with $500, stop at -30%," and it finds the market, checks your limits, signs with keys that never leave your machine, and replies once with what it did.

Status: **early backend**. It does Hyperliquid perps (crypto, gold, stocks, indices), Solana spot through Jupiter, conditional orders, stops and targets, paper mode, and a kill switch. Options, Polymarket, launch sniping, cross-chain and yield come next (see [docs/ROADMAP.md](docs/ROADMAP.md)).

## How it works

```
Telegram / WhatsApp
      │
OpenClaw agent ── fren plugin (tools + /ok /stop /limits /resume)
      │  plans only, no keys
      ▼
fren engine (local HTTP API on 127.0.0.1)
  ├─ policy: your caps, leverage, venues, daily spend. No LLM.
  ├─ venues: Hyperliquid, Jupiter (paper or live)
  ├─ watcher: checks conditions every 15s and fires plans. No LLM.
  └─ signer (separate process): holds the keys, refuses withdrawals,
     transfers to strangers and unknown programs
```

The model thinks, but it never signs and never polls. Anything that spends over your auto-approve level, loosens a limit, or turns Fren back on after a stop needs a code that goes straight to you on Telegram. The agent never sees the code. See [docs/SECURITY.md](docs/SECURITY.md).

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
node packages/engine/dist/cli.js init --network testnet \
  --telegram-token <your OpenClaw Telegram bot token> --telegram-chat <your Telegram user id>

node packages/engine/dist/cli.js start

# In another terminal: install the plugin into OpenClaw
openclaw plugins install --link --accept-capabilities ./packages/openclaw-plugin
```

Then talk to your OpenClaw bot:

- "what's my wallet" shows where to send USDC (Solana for spot, Arbitrum or Hyperliquid for perps).
- "long BTC 10x with $50, stop at -20%"
- "buy $25 of JUP"
- "short SOL $100 at 5x when funding goes above 0.02%/h"
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

Defaults: paper mode, $500 per trade, $2,000 per day, 20x max leverage, 10 open positions, auto-approve up to $100, venues Hyperliquid and Jupiter. The agent can tighten these. Only you can loosen them.

## Development

```bash
npm run build && npm test
```

Tests run against fakes of the Hyperliquid and Jupiter APIs and an in-process signer, plus one test that spawns the real signer process. Nothing in CI touches a real network or real money.
