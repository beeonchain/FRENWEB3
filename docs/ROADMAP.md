# Roadmap

What works today, and what's next to cover everything in the brief, plus a few things beyond it.

## Done in this first cut

- Plan schema, policy engine, conditions (price, funding, time), plain-English echo
- Encrypted keystore and wallet creation (Solana, EVM master, Hyperliquid agent key)
- Signer process with hard rules
- Hyperliquid perps on the main dex and builder dexes (gold, stocks, indices): leverage, IOC market orders, on-venue stop and take-profit, close, kill-switch flatten, Arbitrum → Hyperliquid deposit
- Jupiter spot buys and sells (ticker → verified token only; any contract address with an unverified warning plus confirmation)
- Watcher with restart-safe SQLite state; paper stops, targets and liquidations
- Paper mode at real prices
- OpenClaw plugin: 11 tools, 7 owner commands, and the agent skill
- Meme coins: pump.fun coins on their bonding curve (official pump.fun SDK) and after they graduate (Jupiter); launch snipes that fire within ~2s of a token trading, with a Jito tip on Solana; tokens on Base, Robinhood Chain and Arbitrum through Relay, paid from USDC on Arbitrum or Base
- Bets on a price by a date: "ETH hits $4,000 by December, $1,000" quotes the nearest call (or put) on Derive with its payoff, and the best matching Polymarket market, side by side; the owner picks one. Buying and selling options on Derive (option-only session key), buying and selling Polymarket shares (Polymarket's SDK, signed by Fren's signer), paper settlement of both, and funding either from Arbitrum USDC with an owner code
- Codes and alerts on any OpenClaw channel: WhatsApp, Signal, Discord and the rest through the gateway's sender, Telegram directly through the bot, with fallbacks in order (`fren init --notify whatsapp:+1...`)
- USDC yield: compare Jupiter Lend, Kamino and Aave (Arbitrum, Base), lend at the best rate where the money is, take it back on request, and take back just enough on its own when a trade needs the cash; paper lending accrues at the live rate

## Next, in order

1. **Live testnet run.** Fund a Hyperliquid testnet account and run the whole flow through Telegram and WhatsApp. Fix whatever reality disagrees with.
2. **Live options and bets.** A small real order on Derive and on Polymarket, then option spreads (cheaper bets on a range), Polymarket markets on anything, not just prices ("bet $50 the Fed cuts in December"), and cash-outs back to Arbitrum.
3. **More meme coin reach.** Pay for Base and Robinhood Chain buys from Solana USDC through Relay (needs Relay's Solana transaction format checked against the signer), price triggers on EVM tokens, and launch detection from the deployer's first transaction rather than polling.
4. **More yield.** Keep idle USDC lent automatically above a cash buffer, move it across chains when the rate gap pays for the bridge, and lend SOL and ETH too.
5. **More conditions.** Wallet activity (Helius webhooks), X mentions (firehose vendor), Polymarket odds, Fear & Greed.
6. **Reach.** One-command installer, Docker compose, VPS self-provisioning on a crypto-paid host (EQVPS), backup and restore.
7. **Hardening.** Separate OS users by default, a Squads spending-limit wallet on Solana, RPC failover, partial fills, signed releases.
