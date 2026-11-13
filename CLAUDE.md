# CLAUDE.md

Context for AI coding agents (and humans) working in this repo. Read this first, then `HANDOFF.md` for project status, `docs/SECURITY.md` before touching anything that signs or moves money, and `docs/ROADMAP.md` for what's next.

## What this is

Fren is a self-hosted [OpenClaw](https://github.com/openclaw/openclaw) agent that trades on-chain from chat (Telegram, WhatsApp, any OpenClaw channel). The model proposes typed **Plans**; code checks them against the owner's limits; a separate **signer** process holds the keys and enforces hard rules. The model never sees keys, never approves, never polls.

The repo also holds the public website, **getfren.netlify.app** (landing page, `install.sh`, the no-terminal VPS wizard, and the brand book).

Note: GitHub `beeonchain/jarvisweb3` is the old name of this repo and redirects here. There is one repo, not two.

## Layout

```
packages/
  core/             Plan schema (zod), policy engine, conditions, plain-English rendering. Pure, no I/O.
  signer/           Encrypted keystore, wallet creation, signer process + its hard rules (rules.ts, evm.ts, polymarket.ts, derive.ts).
  engine/           `fren` CLI + daemon: venues/, watcher, SQLite store, local HTTP API (127.0.0.1:7420),
                    `fren setup` (terminal) and setup-web.ts (HTTPS setup page on a VPS, port 7421 behind Caddy).
  openclaw-plugin/  OpenClaw plugin: 11 agent tools, owner commands (/ok /stop /resume /limits ...), skills/fren/SKILL.md.
site/
  public/           Static site: index.html, vps/ (wizard UI), brand/ (brand book), install.sh, assets/.
  netlify/functions/ VPS wizard backend: vps-start, vps-code, vps-plans, vps-status, vps-install-background;
                    lib/wizard.mjs (pure state machine), lib/eqvps.mjs (EQVPS REST client), lib/runtime.mjs (Blobs + ssh2 wiring).
  netlify.toml
docs/               SECURITY.md (threat model + known gaps), ROADMAP.md
```

Package dependency order: `core` <- `signer` <- `engine`; `openclaw-plugin` talks to the engine over HTTP only.

## Commands

Node **24.16+** (`.nvmrc` says 24). npm workspaces, TypeScript project references, vitest.

```bash
npm ci
npm run build          # tsc -b over all four packages (also the typecheck)
npm test               # vitest: packages/*/src/**/*.test.ts and site/netlify/**/*.test.mjs
npx vitest run packages/core   # one package
```

CI (`.github/workflows/ci.yml`) runs `npm ci && npm run build && npm test` on every PR and on push to main. Tests use fakes for every venue and an in-process signer; nothing in tests touches a real network or real money. Keep it that way.

Site: `cd site && npm ci` installs the function deps (`@netlify/blobs`, `ssh2`). `netlify dev` from `site/` runs it locally if you have the Netlify CLI; Blobs need a linked site.

Run the engine by hand (paper mode, testnet):

```bash
node packages/engine/dist/cli.js init --network testnet --notify whatsapp:+15551234567
node packages/engine/dist/cli.js start
openclaw plugins install --link --accept-capabilities --force ./packages/openclaw-plugin
```

State lives in `~/.fren` (override with `FREN_HOME`): `config.json`, `keystore.json`, `signer.pass`, `api-token`, `fren.sqlite`.

## Rules of the road

- **Security invariants are the product.** Don't add an agent tool that returns key material, approves a plan, loosens a limit or resumes after `/stop`. Approval codes go to the owner around the model. Any new venue or contract needs an explicit allow-list entry in the signer, plus tests that the signer refuses everything else. Update `docs/SECURITY.md` when you change what the signer will sign.
- **Policy is code, not prompts.** Limits live in `packages/core/src/policy.ts` / `limits.ts`. The agent may tighten, only the owner may loosen.
- **Defaults stay safe:** paper mode, testnet, $500/trade, $2,000/day, 20x, auto-approve <= $100.
- **Plan schema changes:** edit `packages/core/src/plan.ts`, then regenerate the plugin's JSON schema with `node packages/openclaw-plugin/scripts/gen-plan-schema.mjs` (writes `src/plan-schema.json`) and update `skills/fren/SKILL.md` so the agent knows the new grammar.
- **`install.sh` is served live** from `site/public/install.sh` and clones `main` of this repo. Anything merged to `main` ships to every new install immediately. Test installer changes with `--ref <branch>`, and keep `bash -n site/public/install.sh` clean. The script wraps everything in `main()` so a piped `curl | bash` can't run half a file.
- **Never commit secrets.** `.env`, `.fren/`, `*.sqlite`, `.netlify` are gitignored. Docs mention env var *names* only.
- Small PRs into `main`, CI green before merge.

## Deploy

- **Website + wizard:** Netlify site `getfren` (getfren.netlify.app), auto-deploys from `main`. `site/netlify.toml` sets publish `public` and functions `netlify/functions`, so the site's base directory is `site` (check under Site configuration > Build & deploy if a deploy looks wrong). PRs get deploy previews. Wizard state lives in the Netlify Blobs store `fren-vps`.
- **Fren itself** isn't deployed by us: users install it with the one-liner or the VPS wizard, which both pull `main` from GitHub.

## Environment variables (names only)

Netlify site (all optional; defaults are correct for production):
- `EQVPS_API` overrides the EQVPS API base (default `https://api.eqvps.com/api/v1/eqvps`).
- `FREN_INSTALL_URL` overrides the installer the wizard runs (default `<site>/install.sh`). Handy for testing a branch.
- `URL` is set by Netlify.

The wizard does **not** use a shared EQVPS API key: it registers / signs in each visitor to their own EQVPS account with the email they enter.

Engine / signer / installer:
- `FREN_HOME`, `FREN_KEYSTORE`, `FREN_PASSPHRASE_FILE` (preferred) or `FREN_PASSPHRASE`, `FREN_SIGNER_PREFIX` (run the signer as another user)
- `FREN_SOLANA_RPC`, `FREN_ARBITRUM_RPC`, `FREN_EVM_RPCS`, `OPENCLAW_BIN`
- `FREN_SETUP_TOKEN` (web setup page token)
- Installer: `FREN_REPO`, `FREN_REF`, `FREN_APP_DIR`

Per-user secrets go in `~/.fren/config.json`, never in the repo: `jupiterApiKey`, `relayApiKey`, `telegram.botToken` / `ownerChatId`, plus the AI model key the user enters at setup.
