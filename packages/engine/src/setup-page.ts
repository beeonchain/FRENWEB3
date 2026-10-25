/** The browser setup page served by `fren setup --web`. Self-contained: no requests leave this server except fonts. */
export const SETUP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Set up your Fren</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geologica:wght@300..700&display=swap">
<style>
:root{--bg:#fff;--soft:#f5f5f5;--ink:#000;--muted:#5e5e5e;--line:#e3e3e3;--blue:#a5caff;--ok:#1f8a4c;--bad:#c62828;--r:12px}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--soft:#1a1a1a;--ink:#fff;--muted:#a3a3a3;--line:#2c2c2c;--ok:#4cc27e;--bad:#ff6b6b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Geologica,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:40px 16px 80px}
h1{font-size:clamp(32px,6vw,48px);font-weight:500;letter-spacing:-.03em;line-height:1.05;margin:0 0 10px}
.lede{color:var(--muted);font-weight:300;font-size:18px;line-height:1.5;margin:0 0 32px}
.step{border:1px solid var(--line);border-radius:var(--r);padding:20px;margin:0 0 14px;background:var(--bg)}
.step h2{font-size:20px;font-weight:500;margin:0;display:flex;gap:10px;align-items:center}
.step .n{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;border:1px solid var(--ink);font-size:14px;flex:none}
.step.done .n{background:var(--ink);color:var(--bg)}
.step.locked{opacity:.45}
.step .body{margin-top:14px}
.step.done .body,.step.locked .body{display:none}
.step .summary{color:var(--muted);font-size:14px;margin:6px 0 0 38px}
p{line-height:1.5;margin:0 0 12px}
.muted{color:var(--muted)}
label{display:block;font-size:14px;font-weight:500;margin:14px 0 6px}
input,select{width:100%;font:inherit;font-size:16px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--ink)}
input:focus,select:focus{outline:2px solid var(--blue);border-color:var(--ink)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-weight:500;font-size:16px;padding:12px 18px;border-radius:10px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);cursor:pointer;text-decoration:none;margin-top:14px;box-shadow:2px 3px 0 var(--blue)}
button.ghost,.btn.ghost{background:transparent;color:var(--ink);box-shadow:none}
button:disabled{opacity:.5;cursor:wait}
.row{display:flex;gap:10px;flex-wrap:wrap}
.choice{flex:1 1 200px;text-align:left;flex-direction:column;align-items:flex-start;background:transparent;color:var(--ink);box-shadow:none}
.choice small{font-weight:300;color:var(--muted);font-size:13px}
ol{padding-left:20px;margin:0 0 12px;line-height:1.6}
.err{color:var(--bad);font-size:14px;margin-top:10px;min-height:1px}
.ok{color:var(--ok)}
pre.qr{font-family:ui-monospace,Menlo,monospace;line-height:1;font-size:7px;letter-spacing:0;background:#fff;color:#000;padding:12px;border-radius:8px;display:inline-block;margin:8px 0}
@media (min-width:500px){pre.qr{font-size:9px}}
.addr{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all;background:var(--soft);padding:10px 12px;border-radius:8px;margin:4px 0 10px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400}
.check input{width:auto;margin-top:3px}
.spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
.hidden{display:none!important}
.final{text-align:center;padding:40px 0}
.final h1{margin-bottom:16px}
</style>
</head>
<body>
<main>
  <h1>Set up your Fren</h1>
  <p class="lede">Three steps, about five minutes. Everything you enter here stays on your server. Your wallet keys are made here and never leave it.</p>

  <section class="step" id="s-model">
    <h2><span class="n">1</span> Pick Fren's brain</h2>
    <div class="summary" id="model-summary"></div>
    <div class="body">
      <p class="muted">Fren thinks with an AI model you bring. Paste an API key from one of these.</p>
      <label for="provider">Provider</label>
      <select id="provider"></select>
      <label for="apikey">API key</label>
      <input id="apikey" type="password" autocomplete="off" placeholder="Paste it here">
      <p class="muted" style="margin-top:8px;font-size:14px"><a id="keylink" target="_blank" rel="noopener">Get a key</a></p>
      <button id="model-save">Save</button>
      <div class="err" id="model-err"></div>
    </div>
  </section>

  <section class="step locked" id="s-chat">
    <h2><span class="n">2</span> Where you'll talk to it</h2>
    <div class="summary" id="chat-summary"></div>
    <div class="body">
      <div class="row" id="chat-pick">
        <button class="choice" data-pick="telegram">Telegram <small>Recommended. Approval codes reach you on a private line the AI never sees.</small></button>
        <button class="choice" data-pick="whatsapp">WhatsApp <small>Best with a spare number for Fren.</small></button>
      </div>

      <div id="tg" class="hidden">
        <ol>
          <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a> in Telegram and send <b>/newbot</b>.</li>
          <li>Pick a name, then a username that ends in "bot".</li>
          <li>Copy the token it sends you and paste it here.</li>
        </ol>
        <label for="tgtoken">Bot token</label>
        <input id="tgtoken" autocomplete="off" placeholder="123456789:AA...">
        <button id="tg-save">Connect bot</button>
        <div id="tg-find" class="hidden">
          <p style="margin-top:16px">Now open your bot and press <b>Start</b>, so Fren knows it's you.</p>
          <a class="btn" id="tg-open" target="_blank" rel="noopener">Open @bot</a>
          <p class="muted" id="tg-wait" style="margin-top:14px"><span class="spin"></span> Waiting for your message…</p>
          <div id="tg-cands"></div>
          <p class="muted" style="font-size:14px;margin-top:14px">Not working? Message <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a>, copy the Id it shows, and paste it here:</p>
          <div class="row"><input id="tg-manual" inputmode="numeric" placeholder="Your Telegram user id" style="flex:1 1 200px"><button class="ghost" id="tg-manual-save" style="margin-top:0">Use this id</button></div>
        </div>
        <div class="err" id="tg-err"></div>
      </div>

      <div id="wa" class="hidden">
        <p class="muted">Fren gets its own WhatsApp: a spare number (an old phone or a second SIM) works best. You'll chat with it from your own phone.</p>
        <label for="wanum">Your own WhatsApp number, with country code</label>
        <input id="wanum" inputmode="tel" placeholder="+447700900123">
        <button id="wa-start">Show the QR code</button>
        <p class="muted" style="font-size:14px;margin-top:8px">The first time takes about a minute while WhatsApp support installs.</p>
        <div id="wa-qr" class="hidden">
          <p style="margin-top:16px">On the phone with Fren's WhatsApp: <b>Settings → Linked devices → Link a device</b>, then scan:</p>
          <pre class="qr" id="wa-code">Loading…</pre>
          <p class="muted" style="font-size:14px">The code refreshes by itself every few seconds.</p>
        </div>
        <div class="err" id="wa-err"></div>
      </div>
    </div>
  </section>

  <section class="step locked" id="s-wallet">
    <h2><span class="n">3</span> Make your wallets</h2>
    <div class="summary" id="wallet-summary"></div>
    <div class="body">
      <div id="w-form">
        <label for="network">Network</label>
        <p class="muted" style="font-size:14px">Mainnet uses real prices with play money until you switch to live. Testnet is Hyperliquid's test network.</p>
        <select id="network">
          <option value="mainnet">Mainnet (recommended)</option>
          <option value="testnet">Testnet</option>
        </select>
        <label for="jup">Jupiter API key <span class="muted">(optional, for fast launch snipes; free at portal.jup.ag)</span></label>
        <input id="jup" autocomplete="off" placeholder="Leave empty to skip">
        <button id="w-make">Create wallets</button>
      </div>
      <div id="w-done" class="hidden">
        <p class="ok">✓ Wallets ready. Fren starts in paper mode, so no real money moves until you say so.</p>
        <label>Solana (spot, meme coins, Solana yield)</label>
        <div class="addr" id="a-sol"></div>
        <label>Arbitrum or Base (perps, bets, EVM coins)</label>
        <div class="addr" id="a-evm"></div>
        <p class="muted" style="font-size:14px">Send USDC to these, plus a little SOL (~0.05) for Solana fees and some ETH on Arbitrum or Base for gas.</p>
        <p style="margin-top:16px"><b>Download your backup.</b> It's the only copy of your keys off this server. If the server is lost and you don't have it, the funds in these wallets are gone.</p>
        <a class="btn ghost" href="/api/backup" id="backup">Download wallet backup</a>
        <label class="check" style="margin-top:16px"><input type="checkbox" id="saved"> I saved my backup somewhere safe and offline.</label>
        <button id="go" disabled>Start Fren</button>
      </div>
      <div class="err" id="w-err"></div>
    </div>
  </section>

  <section class="final hidden" id="final">
    <h1>Your Fren is live.</h1>
    <p class="lede" id="final-text">Message your bot: "what's my wallet", "long BTC 5x with $20", or "stop everything". When you're ready for real money, send /limits mode=live.</p>
    <p class="muted">This setup page is now closed for good.</p>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: "No answer from your server." }));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
async function busy(btn, errEl, fn) {
  btn.disabled = true; const label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span> ' + label;
  errEl.textContent = "";
  try { await fn(); } catch (e) { errEl.textContent = e.message; } finally { btn.disabled = false; btn.innerHTML = label; }
}
function mark(step, done, summary) {
  const el = $("s-" + step);
  el.classList.toggle("done", done);
  el.classList.remove("locked");
  if (summary !== undefined) $(step + "-summary").textContent = summary;
}
let providers = [];
let chat = null;

async function load() {
  const s = await api("GET", "/api/state");
  providers = s.providers;
  $("provider").innerHTML = providers.map((p) => '<option value="' + p.id + '">' + p.label + "</option>").join("");
  syncKeyLink();
  if (s.done) return showFinal();
  if (s.modelReady) { mark("model", true, "✓ AI model connected"); unlockChat(); }
  if (s.channel) { chat = s.channel; mark("chat", true, "✓ " + (s.channel === "telegram" ? "Telegram" : "WhatsApp") + " connected"); mark("wallet", false); }
  if (s.finished) showWallets(s.finished);
}
function syncKeyLink() { const p = providers.find((x) => x.id === $("provider").value); if (p) $("keylink").href = p.keyUrl; }
$("provider").onchange = syncKeyLink;
$("model-summary").onclick = () => $("s-model").classList.remove("done");
$("model-save").onclick = () => busy($("model-save"), $("model-err"), async () => {
  await api("POST", "/api/model", { provider: $("provider").value, apiKey: $("apikey").value });
  $("apikey").value = "";
  mark("model", true, "✓ AI model connected"); unlockChat();
});
function unlockChat() { if (!chat) mark("chat", false); }

document.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => {
  const pick = b.dataset.pick;
  $("tg").classList.toggle("hidden", pick !== "telegram");
  $("wa").classList.toggle("hidden", pick !== "whatsapp");
});

let finding = false;
let lastSeen = "[]";
$("tg-save").onclick = () => busy($("tg-save"), $("tg-err"), async () => {
  const r = await api("POST", "/api/telegram/token", { token: $("tgtoken").value });
  $("tg-open").href = "https://t.me/" + r.bot;
  $("tg-open").textContent = "Open @" + r.bot;
  $("tg-find").classList.remove("hidden");
  if (!finding) findLoop();
});
async function findLoop() {
  finding = true;
  while (finding) {
    try {
      const r = await api("POST", "/api/telegram/find");
      if (r.busy) { $("tg-wait").textContent = "Something else is reading this bot. Use the id box below."; finding = false; break; }
      const seen = JSON.stringify(r.candidates);
      if (seen === lastSeen) continue;
      lastSeen = seen;
      $("tg-cands").innerHTML = r.candidates.map((c) => '<p>Got a message from <b>' + esc(c.name) + '</b>. <button data-id="' + c.id + '" style="margin:0 0 0 8px;padding:6px 12px">That\\'s me</button></p>').join("");
      $("tg-cands").querySelectorAll("button").forEach((b) => b.onclick = () => confirmTg(b.dataset.id, b));
    } catch (e) { $("tg-err").textContent = e.message; await new Promise((r) => setTimeout(r, 3000)); }
  }
}
function confirmTg(id, btn) {
  return busy(btn, $("tg-err"), async () => {
    await api("POST", "/api/telegram/confirm", { id });
    finding = false;
    chat = "telegram";
    mark("chat", true, "✓ Telegram connected. Check your bot: it just said hi.");
    mark("wallet", false);
  });
}
$("tg-manual-save").onclick = () => confirmTg($("tg-manual").value.trim(), $("tg-manual-save"));

let waTimer = null;
$("wa-start").onclick = () => busy($("wa-start"), $("wa-err"), async () => {
  await api("POST", "/api/whatsapp/start", { number: $("wanum").value });
  $("wa-qr").classList.remove("hidden");
  $("wa-start").textContent = "Try again";
  clearInterval(waTimer);
  waTimer = setInterval(pollQr, 2000);
});
async function pollQr() {
  try {
    const r = await api("GET", "/api/whatsapp/qr");
    if (r.qr) $("wa-code").textContent = r.qr;
    if (r.error) { $("wa-err").textContent = r.error; clearInterval(waTimer); }
    if (r.linked) {
      clearInterval(waTimer);
      chat = "whatsapp";
      mark("chat", true, "✓ WhatsApp connected");
      mark("wallet", false);
    }
  } catch (e) { $("wa-err").textContent = e.message; }
}

$("w-make").onclick = () => busy($("w-make"), $("w-err"), async () => {
  showWallets(await api("POST", "/api/finish", { network: $("network").value, jupiterApiKey: $("jup").value }));
});
function showWallets(f) {
  mark("wallet", false, "");
  $("w-form").classList.add("hidden");
  $("w-done").classList.remove("hidden");
  $("a-sol").textContent = f.addresses.solana;
  $("a-evm").textContent = f.addresses.evm;
}
$("saved").onchange = () => { $("go").disabled = !$("saved").checked; };
$("go").onclick = () => busy($("go"), $("w-err"), async () => {
  await api("POST", "/api/done");
  showFinal();
});
function showFinal() {
  document.querySelectorAll(".step,.lede,main>h1").forEach((e) => e.classList.add("hidden"));
  $("final").classList.remove("hidden");
}
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
load().catch((e) => { document.querySelector(".lede").textContent = e.message; });
</script>
</body>
</html>
`;
