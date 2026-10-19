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
- OpenClaw plugin: 8 tools, 7 owner commands, and the agent skill
- Meme coins: pump.fun coins on their bonding curve (official pump.fun SDK) and after they graduate (Jupiter); launch snipes that fire within ~2s of a token trading, with a Jito tip on Solana; tokens on Base, Robinhood Chain and Arbitrum through Relay, paid from USDC on Arbitrum or Base

## Next, in order

1. **Live testnet run.** Fund a Hyperliquid testnet account and run the whole flow through Telegram. Fix whatever reality disagrees with.
2. **Options (Derive).** Add a `derive` venue: map "ETH ≥ $4,000 by December, $1,000" to the nearest listed call and expiry, and quote it next to a Polymarket alternative. Needs an EVM session key on Derive and a signer rule for Derive actions.
3. **Prediction markets (Polymarket).** CLOB client and a Polygon proxy wallet. The agent offers it when a binary bet fits better than an option.
4. **More meme coin reach.** Pay for Base and Robinhood Chain buys from Solana USDC through Relay (needs Relay's Solana transaction format checked against the signer), price triggers on EVM tokens, and launch detection from the deployer's first transaction rather than polling.
5. **Yield.** "Put idle USDC to work": compare Kamino and Jupiter Lend on Solana and Aave on Arbitrum, deposit to the best, and withdraw automatically when a trade needs the cash.
6. **More conditions.** Wallet activity (Helius webhooks), X mentions (firehose vendor), Polymarket odds, Fear & Greed.
7. **Reach.** One-command installer, Docker compose, VPS self-provisioning on a crypto-paid host (EQVPS), WhatsApp, backup and restore.
8. **Hardening.** Separate OS users by default, a Squads spending-limit wallet on Solana, RPC failover, partial fills, signed releases.
