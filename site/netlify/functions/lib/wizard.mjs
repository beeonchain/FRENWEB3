// The /vps wizard's state machine: an EQVPS account and order for the visitor,
// the crypto checkout, then a one-time SSH install of Fren on the new server.
// Pure logic: EQVPS, storage, key generation and the install trigger are passed
// in, so it runs the same in Netlify Functions and in tests.

import { randomBytes } from "node:crypto";

/**
 * One plan, "Fren server": 2 vCPU, 2 GB, its own IPv4 (the setup page on the
 * server needs inbound HTTPS, so no shared-IP plans).
 */
export const PLANS = ["micro-ip"];
export const RECOMMENDED = "micro-ip";
export const KEY_TAG = "fren-installer";
const OS_NAME = "Ubuntu 24.04";
const INSTALL_TIMEOUT_MS = 25 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UserError extends Error {}

/**
 * @param {object} deps
 * @param {ReturnType<import("./eqvps.mjs").eqvpsClient>} deps.eqvps
 * @param {{ get(id: string): Promise<any>, set(id: string, v: any): Promise<void> }} deps.store
 * @param {() => { publicKey: string, privateKey: string }} deps.keygen  publicKey is "ssh-ed25519 AAAA..."
 * @param {(id: string) => Promise<void>} deps.triggerInstall
 * @param {() => number} [deps.now]
 */
export function createWizard(deps) {
  const now = deps.now ?? Date.now;

  async function plans() {
    const products = await deps.eqvps.products();
    return PLANS.map((slug) => products.find((p) => p.slug === slug))
      .filter(Boolean)
      .map((p) => ({
        slug: p.slug,
        name: p.name,
        priceUsd: p.price.amount,
        vcpu: p.specs.vcpu,
        ramGb: Math.round(p.specs.memory_mb / 1024),
        diskGb: p.specs.disk_gb,
        recommended: p.slug === RECOMMENDED,
      }));
  }

  async function start(email, plan) {
    email = String(email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) throw new UserError("That email doesn't look right.");
    if (!PLANS.includes(plan)) throw new UserError("Pick one of the plans.");
    const rec = { id: randomBytes(24).toString("base64url"), email, plan, stage: "new", createdAt: now() };
    const reg = await deps.eqvps.register(email);
    if (reg.token) {
      rec.eqvpsToken = reg.token;
      await order(rec);
    } else if (reg.emailTaken) {
      // Already an EQVPS customer: sign in with the code EQVPS emails them.
      await deps.eqvps.requestCode(email);
      rec.stage = "needs_code";
    } else {
      throw new UserError(reg.message || "The VPS provider didn't accept that email.");
    }
    await save(rec);
    return view(rec);
  }

  async function code(id, codeIn) {
    const rec = await load(id);
    if (rec.stage !== "needs_code") return view(rec);
    const c = String(codeIn ?? "").replace(/\s/g, "");
    if (!/^\d{4,8}$/.test(c)) throw new UserError("Enter the code from the email.");
    const token = await deps.eqvps.verifyCode(rec.email, c);
    if (!token) throw new UserError("That code didn't work. Check the latest email from EQVPS.");
    rec.eqvpsToken = token;
    await order(rec);
    await save(rec);
    return view(rec);
  }

  async function order(rec) {
    const products = await deps.eqvps.products();
    const product = products.find((p) => p.slug === rec.plan);
    if (!product) throw new UserError("That plan isn't available right now.");
    const os = product.available_os.find((o) => o.name === OS_NAME);
    if (!os) throw new UserError(`${OS_NAME} isn't available on that plan right now.`);
    const keys = deps.keygen();
    rec.privateKey = keys.privateKey;
    rec.knownServiceIds = (await deps.eqvps.services(rec.eqvpsToken)).map((s) => s.id);
    const o = await deps.eqvps.order(rec.eqvpsToken, { product: rec.plan, os_id: os.id, ssh_key: `${keys.publicKey.split(" ").slice(0, 2).join(" ")} ${KEY_TAG}` });
    rec.amountUsd = product.price.amount;
    if (o.serviceId) rec.serviceId = o.serviceId;
    if (o.paid) {
      rec.stage = "provisioning";
    } else {
      if (!o.invoiceId) throw new Error("EQVPS returned neither a server nor an invoice.");
      rec.invoiceId = o.invoiceId;
      const pay = await deps.eqvps.payInvoice(rec.eqvpsToken, o.invoiceId);
      rec.checkoutUrl = pay.checkoutUrl;
      if (pay.amountUsd) rec.amountUsd = pay.amountUsd;
      rec.stage = "awaiting_payment";
    }
  }

  /** Called by the page every few seconds; moves things along as EQVPS reports progress. */
  async function status(id) {
    const rec = await load(id);
    if (rec.stage === "awaiting_payment" || rec.stage === "provisioning") {
      const svc = await findService(rec);
      if (svc) {
        rec.serviceId = svc.id;
        const detail = await deps.eqvps.service(rec.eqvpsToken, svc.id);
        if (detail.status === "active" && detail.host) {
          rec.host = detail.host;
          rec.port = detail.port ?? 22;
          rec.stage = "installing";
          rec.progress = "Server is up. Installing Fren…";
          rec.installStartedAt = now();
          await save(rec);
          await deps.triggerInstall(rec.id);
          return view(rec);
        }
        rec.stage = "provisioning";
        rec.progress = "Payment received. Your server is starting…";
      }
      await save(rec);
    } else if (rec.stage === "installing" && now() - rec.installStartedAt > INSTALL_TIMEOUT_MS) {
      rec.stage = "failed";
      rec.error = "Installing took too long. Your server is paid for; contact us with this page's link and we'll finish it.";
      forget(rec);
      await save(rec);
    }
    return view(rec);
  }

  async function findService(rec) {
    const list = await deps.eqvps.services(rec.eqvpsToken);
    if (rec.serviceId) return list.find((s) => s.id === rec.serviceId) ?? { id: rec.serviceId };
    const fresh = list.filter((s) => !rec.knownServiceIds?.includes(s.id));
    return fresh.sort((a, b) => b.id - a.id)[0] ?? null;
  }

  /**
   * The background function's job: SSH in, run the installer, keep the newest
   * progress line, and finish with the setup link. `ssh` runs one command.
   * @param {(o: { host: string, port: number, privateKey: string, command: string, onLine(l: string): void }) => Promise<{ code: number, output: string }>} ssh
   */
  async function install(id, ssh, installUrl) {
    const rec = await load(id);
    if (rec.stage !== "installing" || rec.installClaimed) return;
    rec.installClaimed = true;
    await save(rec);
    let last = 0;
    const onLine = async (line) => {
      const step = line.match(/==>\s*(.+)$/)?.[1];
      if (step && now() - last > 2000) {
        last = now();
        rec.progress = friendly(step);
        await save(rec);
      }
    };
    try {
      const r = await ssh({
        host: rec.host,
        port: rec.port,
        privateKey: rec.privateKey,
        command: `curl -fsSL ${installUrl} | bash -s -- --server --web --drop-key ${KEY_TAG}`,
        onLine,
      });
      const url = r.output.match(/FREN_SETUP_URL=(https:\/\/\S+)/)?.[1];
      if (r.code === 0 && url) {
        rec.stage = "ready";
        rec.setupUrl = url;
        rec.progress = "Done";
      } else {
        rec.stage = "failed";
        rec.error = `The install stopped: ${tail(r.output)}`;
      }
    } catch (err) {
      rec.stage = "failed";
      rec.error = `Couldn't reach your server: ${err.message}`;
    }
    forget(rec);
    await save(rec);
  }

  /** Secrets we only needed to get here. */
  function forget(rec) {
    delete rec.privateKey;
    delete rec.eqvpsToken;
  }

  async function load(id) {
    const rec = typeof id === "string" && id.length >= 20 ? await deps.store.get(id) : null;
    if (!rec) throw new UserError("We couldn't find that setup. Start again from the VPS page.");
    return rec;
  }

  async function save(rec) {
    rec.updatedAt = now();
    await deps.store.set(rec.id, rec);
  }

  return { plans, start, code, status, install };
}

/** What the page sees: never tokens or keys. */
export function view(rec) {
  const v = { id: rec.id, stage: rec.stage, plan: rec.plan };
  for (const k of ["checkoutUrl", "amountUsd", "progress", "setupUrl", "error"]) if (rec[k] !== undefined) v[k] = rec[k];
  return v;
}

function friendly(step) {
  if (/basics/i.test(step)) return "Preparing the server…";
  if (/node|openclaw/i.test(step)) return "Installing OpenClaw…";
  if (/download/i.test(step)) return "Downloading Fren…";
  if (/build/i.test(step)) return "Building Fren (a couple of minutes)…";
  if (/https/i.test(step)) return "Securing your setup page…";
  return step;
}

function tail(output) {
  return (
    output
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .slice(-3)
      .join(" ")
      .slice(0, 400) || "no output"
  );
}
