# Handoff

Where Fren stands as of November 2026, for the developer taking it over. Technical conventions are in `CLAUDE.md`; the threat model is `docs/SECURITY.md`.

## Ownership and access

- **Owner:** `beeonchain` keeps ownership of this repo, the Netlify site and the EQVPS account. The new developer works as a collaborator.
- **GitHub:** `beeonchain/frenweb3` (public). `beeonchain/jarvisweb3` is the old name and redirects here. Work in branches, open PRs into `main`. `main` may be protected (PR + green CI required).
- **Netlify:** site `getfren` (getfren.netlify.app), invited via the Netlify team. Auto-deploys `main`; PRs get deploy previews.
- **EQVPS:** Bee's own account, for test servers only. The production wizard never uses it (each visitor gets their own EQVPS account). Ask Bee for a test-server login or an invite; don't put credentials in the repo.
- Secrets are never shared over chat or committed. If you need one, ask Bee to set it in Netlify's environment variables or hand it over in a password manager.

## History in one screen

| PR | What |
| --- | --- |
| #1 | Backend: plan schema, policy, signer, engine, OpenClaw plugin. Project renamed Jarvis -> Fren. |
| #2 | Meme coins: pump.fun curve + post-graduation, launch snipes with Jito tip, Base and Robinhood Chain via Relay |
| #3 | Bets: options on Derive and Polymarket, quoted side by side |
| #4 | USDC yield: Jupiter Lend, Kamino, Aave; auto-withdraw when a trade needs cash |
| #5 | Codes and alerts on WhatsApp and any OpenClaw channel |
| #6 | Website: landing page, setup section, VPS page, brand book |
| #7, #8 | VPS path became a no-terminal browser wizard; one plan instead of three; stop polling on rejected ids |
| #9 | One-command install (`install.sh`), guided `fren setup`, web setup on the VPS |

The original product brief (working title "DegenClaw") and venue API research live in Bee's project files, not in this repo. Ask Bee for `openclaw-degen-brief.pdf`, `degenclaw-brief-research.md` and `fren-venue-apis.md` if you want the background.

## How users get Fren

1. **One-liner** (Mac / Linux / WSL): `curl -fsSL https://getfren.netlify.app/install.sh | bash`. Installs Node and OpenClaw if missing, clones `main` into `~/.fren-app`, builds, runs `fren setup` (model login, Telegram or WhatsApp, mainnet/testnet, optional Jupiter key), creates wallets, installs the plugin, starts the daemon. Flags: `--server`, `--web`, `--no-setup`, `--ref`, `--repo`, `--dir`, `--drop-key`.
2. **VPS wizard** at getfren.netlify.app/vps, no terminal:
   - `vps-start`: visitor enters an email. The wizard registers them at EQVPS (or, if the email exists, EQVPS emails a sign-in code -> `vps-code`). It orders plan `micro-ip` (2 vCPU, 2 GB, own IPv4, Ubuntu 24.04, about $10/mo) with a one-time ed25519 key tagged `fren-installer`.
   - Visitor pays the EQVPS crypto/card checkout. `vps-status` polls until the server is active, then fires `vps-install-background` (up to 15 min).
   - That function SSHes in as root once and runs `install.sh --server --web --drop-key fren-installer`. The installer creates a `fren` user, systemd units `fren.service` and `fren-openclaw.service`, Caddy for HTTPS on `https://<ip>.sslip.io/setup`, deletes the one-time key, and prints a one-time setup link. The wizard shows that link and forgets the key.
   - On the setup page the user pastes an AI key, connects Telegram/WhatsApp (QR in page), creates wallets, downloads a backup, presses Start. The setup page and Caddy shut down for good.
   - State: Netlify Blobs store `fren-vps`, one JSON record per order. State machine: `new -> needs_code -> awaiting_payment / provisioning -> installing -> ready | failed` (`site/netlify/functions/lib/wizard.mjs`, unit-tested).

## Brand

The brand book is live at getfren.netlify.app/brand (`site/public/brand/index.html`). Short version: mostly black and white, one blue that means "you" and "go".

- Ink `#000000` (`--ink`): text, outlines, Fren's chat bubbles
- Paper `#FFFFFF` (`--bg`): backgrounds
- Fren Blue `#A5CAFF` (`--blue`): buttons, the user's bubbles, highlights
- Soft `#F5F5F5` (`--soft`): cards, tiles
- Muted `#5E5E5E` (`--muted`): secondary text
- Logos and marks in `site/public/assets/` (black / white variants, favicon, OG image). Sections on type, parts, motion ("the eye is alive") and voice are in the book. Copy voice: plain, short, friendly, no jargon.

## Done

Everything listed under "Done in this first cut" in `docs/ROADMAP.md`, plus the installer, guided setup, web setup and VPS wizard from roadmap item 6. CI is green on `main`.

## Open, in rough priority order

1. **First live run.** Nothing has traded against real services yet. Fund a Hyperliquid testnet account and run the full flow through Telegram and WhatsApp. Then small live orders on Derive, Polymarket and each yield venue (see "Known gaps" in SECURITY.md; Polymarket may need a builder key, Kamino withdraw reads partly undocumented endpoints).
2. **End-to-end VPS wizard test** with a real EQVPS order and payment. EQVPS response shapes beyond their quickstart are read defensively in `lib/eqvps.mjs`; verify them against real responses.
3. The rest of `docs/ROADMAP.md` "Next, in order": options spreads and non-price Polymarket markets, Solana-paid EVM buys via Relay, auto-yield above a cash buffer, more conditions (wallet activity, X mentions, odds), Docker compose, backup/restore, hardening (separate OS users by default, Squads spending-limit wallet, RPC failover, partial fills, signed releases).
4. **Housekeeping:** merged feature branches still exist on GitHub (`jarvis-backend-core`, `fren-meme-coins`, `fren-bets`, `fren-yield`, `fren-whatsapp`, `claude/project-thread-*`) and can be deleted.

## Working with Claude agents

`CLAUDE.md` is loaded automatically by Claude Code. Keep it current when you change commands, layout or invariants, so the next agent (or developer) starts with the right picture.
