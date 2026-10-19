# Security model

Fren trades with real money from a chat window, inside an agent that reads tweets, token metadata and messages from strangers. The design assumes the model **will** be prompt-injected at some point and limits what that can do.

## Layers

1. **The model only proposes.** The agent's tools submit a typed Plan or read state. No tool returns key material, approves a plan, raises a limit, or resumes after a stop.
2. **Policy is code.** `packages/core/src/policy.ts` checks every plan against the owner's limits: per-trade and per-day spend, max leverage (the owner's and the venue's), open positions, allowed venues. It checks again when the watcher fires a conditional plan.
3. **Approval goes around the model.** Plans over the auto-approve level, loosened limits, and resuming after `/stop` each need a 6-character code. The engine sends it straight to the owner's Telegram chat with the Bot API's `sendMessage`. Bots don't receive their own messages, so OpenClaw never sees it. The owner replies `/ok CODE`, a plugin command that bypasses the model and is owner-only. Codes expire after 10 minutes and work once.
4. **The signer has its own rules.** The signer is a separate process that holds the decrypted keys. Whatever the engine asks, it:
   - signs only Hyperliquid trading actions (order, cancel, modify, leverage) with the **agent key**, which Hyperliquid itself prevents from withdrawing;
   - uses the master EVM key only to approve its own agent key, and to send USDC from Arbitrum to Hyperliquid's bridge, which credits the same account;
   - on Solana, requires the wallet to pay the fee and allows only Jupiter, pump.fun (curve and PumpSwap), token-account and compute-budget programs at the top level. It refuses SOL or token transfers to anyone else, token approvals and authority changes, caps priority fees, and simulates the transaction to cap SOL loss. The one exception is a launch snipe: the engine may allow a single tip to one of Jito's eight published tip accounts, and the signer caps it at 0.01 SOL whatever the engine asks;
   - on Base, Robinhood Chain and Arbitrum, sends only to Relay's routers, approval proxies and depository, never with ETH attached. ERC-20 approvals must name a Relay spender and a bounded amount (the engine shrinks Relay's approvals to the exact trade size; the signer refuses "unlimited").
5. **Keys at rest.** The keystore is AES-256-GCM encrypted with a scrypt-derived key. By default the passphrase is a random file next to it (`~/.fren/signer.pass`, mode 600).

## Known gaps

- **Same OS user.** By default the engine, signer and OpenClaw run as the same user. OpenClaw agents often have shell tools, so an injected agent could read `~/.fren` (the database, the token, and the passphrase file). For real money:
  - run the engine and signer as a separate user (`fren`), with `~/.fren` owned by that user and mode 700;
  - give OpenClaw's user only a copy of `api-token`;
  - or set `FREN_SIGNER_PREFIX="sudo -u fren-signer"` to run just the signer as another user.
- **No private line without Telegram.** Without `telegram` in the config, codes go out through OpenClaw's own delivery to the conversation. That is best-effort, and the code may end up in the transcript the model can read. Configure Telegram for live trading.
- **Solana has no trade-only key.** The signer's static checks and simulation catch transfers at the top level. Jupiter's routed inner instructions are trusted because they run inside the Jupiter program. On-chain spending limits (a Squads smart wallet) are the planned upgrade.
- **Relay calldata is trusted.** The signer checks where an EVM transaction goes, not what Relay's router does with it, the same way it trusts Jupiter's routed instructions. The engine asks Relay for quotes with the wallet as recipient and refund address, and the model never supplies either. Relay's contract list is pinned in `packages/signer/src/evm.ts` and needs updating if Relay deploys new contracts (it moves to v3.2 on 2026-10-26; both are listed).
- **pump.fun curve trades** are built with pump.fun's official SDK (pinned). The program changes often; if a buy fails with a program error, update the SDK.
- **Third-party skills.** ClawHub has shipped hundreds of malicious skills aimed at crypto users. Don't install unknown skills on the box that runs Fren.
