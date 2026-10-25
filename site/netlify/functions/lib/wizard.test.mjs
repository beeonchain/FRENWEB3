import { describe, expect, it } from "vitest";
import { eqvpsClient } from "./eqvps.mjs";
import { createWizard, view } from "./wizard.mjs";

const PRODUCTS = {
  data: [
    {
      id: 13,
      slug: "micro-ip",
      name: "Micro-IP",
      price: { amount: 10 },
      specs: { vcpu: 2, memory_mb: 2048, disk_gb: 25, ipv4: 1 },
      available_os: [
        { id: 5, name: "Debian 12" },
        { id: 4, name: "Ubuntu 24.04" },
      ],
    },
    { id: 6, slug: "micro", name: "Micro", price: { amount: 5 }, specs: { vcpu: 2, memory_mb: 2048, disk_gb: 25, ipv4: 0 }, available_os: [] },
    { id: 15, slug: "ai-agent-ip", name: "AI-Agent-IP", price: { amount: 15 }, specs: { vcpu: 4, memory_mb: 4096, disk_gb: 40, ipv4: 1 }, available_os: [{ id: 4, name: "Ubuntu 24.04" }] },
  ],
};

/** A fake EQVPS behind fetch, with the shapes from its REST quickstart. */
function fakeEqvps({ existing = false } = {}) {
  const calls = [];
  const state = { services: [{ id: 3, status: "active" }], paid: false, booted: false, orderBody: null };
  const fetchFn = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/api/v1/eqvps", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers?.authorization;
    calls.push(`${init.method ?? "GET"} ${path}`);
    const json = (status, v) => new Response(JSON.stringify(v), { status });
    if (path === "/products") return json(200, PRODUCTS);
    if (path === "/auth/register") {
      if (existing) return json(422, { message: "The email has already been taken.", errors: { email: ["The email has already been taken."] } });
      return json(201, { token: "tok-new", token_type: "Bearer", user: {} });
    }
    if (path === "/auth/otp/request") return json(200, { message: "sent" });
    if (path === "/auth/otp/verify") return body.code === "123456" ? json(200, { token: "tok-old" }) : json(422, { message: "Invalid code." });
    if (!auth?.startsWith("Bearer tok-")) return json(401, { message: "Unauthenticated." });
    if (path === "/services") return json(200, { data: state.services });
    if (path === "/orders") {
      state.orderBody = body;
      return json(200, { invoice: { id: 77 } });
    }
    if (path === "/invoices/77/pay") return json(200, { checkout_url: "https://payram.eqvps.com/pay/abc" });
    const m = path.match(/^\/services\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (id === 3) return json(200, { status: "active", access: { host: "9.9.9.9", port: 22 } });
      return json(200, state.booted ? { status: "active", access: { host: "1.2.3.4", port: 22, command: "ssh root@1.2.3.4" } } : { status: "pending" });
    }
    return json(404, { message: "nope" });
  };
  return { eqvps: eqvpsClient({ base: "https://api.test/api/v1/eqvps", fetchFn }), calls, state };
}

function setup(opts) {
  const fake = fakeEqvps(opts);
  const db = new Map();
  const triggered = [];
  let t = 1_000;
  const wizard = createWizard({
    eqvps: fake.eqvps,
    store: { get: async (id) => (db.has(id) ? structuredClone(db.get(id)) : null), set: async (id, v) => void db.set(id, structuredClone(v)) },
    keygen: () => ({ publicKey: "ssh-ed25519 AAAAkey fren-installer", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----x" }),
    triggerInstall: async (id) => void triggered.push(id),
    now: () => t,
  });
  return { wizard, fake, db, triggered, tick: (ms) => (t += ms) };
}

describe("VPS wizard", () => {
  it("offers the one Fren server plan", async () => {
    const { wizard } = setup();
    expect(await wizard.plans()).toEqual([{ slug: "micro-ip", name: "Micro-IP", priceUsd: 10, vcpu: 2, ramGb: 2, diskGb: 25, recommended: true }]);
  });

  it("registers, orders Ubuntu with the one-time key, and returns the checkout", async () => {
    const { wizard, fake, db } = setup();
    const v = await wizard.start(" Bee@Example.com ", "micro-ip");
    expect(v).toMatchObject({ stage: "awaiting_payment", plan: "micro-ip", checkoutUrl: "https://payram.eqvps.com/pay/abc", amountUsd: 10 });
    expect(v.id.length).toBeGreaterThanOrEqual(32);
    expect(fake.state.orderBody).toEqual({ product: "micro-ip", os_id: 4, ssh_key: "ssh-ed25519 AAAAkey fren-installer" });
    // Secrets stay server-side.
    expect(JSON.stringify(v)).not.toMatch(/tok-|PRIVATE/);
    expect(db.get(v.id).email).toBe("bee@example.com");
  });

  it("signs existing EQVPS customers in with the emailed code", async () => {
    const { wizard } = setup({ existing: true });
    const v = await wizard.start("bee@example.com", "micro-ip");
    expect(v.stage).toBe("needs_code");
    await expect(wizard.code(v.id, "000000")).rejects.toThrow(/didn't work/);
    const after = await wizard.code(v.id, "123 456");
    expect(after.stage).toBe("awaiting_payment");
  });

  it("waits for payment, then the server, then starts the install once", async () => {
    const { wizard, fake, triggered, db } = setup();
    const { id } = await wizard.start("bee@example.com", "micro-ip");
    expect((await wizard.status(id)).stage).toBe("awaiting_payment");

    // Paid: a new server shows up (the old one, id 3, is ignored).
    fake.state.services.push({ id: 41, status: "pending" });
    expect(await wizard.status(id)).toMatchObject({ stage: "provisioning", progress: expect.stringMatching(/Payment received/) });
    expect(triggered).toEqual([]);

    fake.state.booted = true;
    expect((await wizard.status(id)).stage).toBe("installing");
    expect(db.get(id)).toMatchObject({ serviceId: 41, host: "1.2.3.4", port: 22 });
    expect((await wizard.status(id)).stage).toBe("installing");
    expect(triggered).toEqual([id]);
  });

  it("installs over SSH, reports progress, keeps the setup link and forgets the secrets", async () => {
    const { wizard, fake, db } = setup();
    const { id } = await wizard.start("bee@example.com", "micro-ip");
    fake.state.services.push({ id: 41 });
    fake.state.booted = true;
    await wizard.status(id);

    let seen;
    const ssh = async (o) => {
      seen = o;
      o.onLine("==> Building Fren (a couple of minutes)");
      return { code: 0, output: "lots\nFREN_SETUP_URL=https://1-2-3-4.sslip.io/setup?t=abc123\n" };
    };
    await wizard.install(id, ssh, "https://getfren.netlify.app/install.sh");
    expect(seen).toMatchObject({ host: "1.2.3.4", port: 22, privateKey: expect.stringContaining("PRIVATE") });
    expect(seen.command).toBe("curl -fsSL https://getfren.netlify.app/install.sh | bash -s -- --server --web --drop-key fren-installer");
    expect(await wizard.status(id)).toMatchObject({ stage: "ready", setupUrl: "https://1-2-3-4.sslip.io/setup?t=abc123" });
    expect(db.get(id).privateKey).toBeUndefined();
    expect(db.get(id).eqvpsToken).toBeUndefined();

    // A second trigger does nothing.
    await wizard.install(id, async () => {
      throw new Error("should not run");
    }, "x");
  });

  it("reports a failed install with the last lines", async () => {
    const { wizard, fake } = setup();
    const { id } = await wizard.start("bee@example.com", "micro-ip");
    fake.state.services.push({ id: 41 });
    fake.state.booted = true;
    await wizard.status(id);
    await wizard.install(id, async () => ({ code: 1, output: "x Couldn't download Fren from https://github.com/beeonchain/frenweb3.git.\n" }), "u");
    expect(await wizard.status(id)).toMatchObject({ stage: "failed", error: expect.stringMatching(/Couldn't download Fren/) });
  });

  it("times out an install that never reports back", async () => {
    const { wizard, fake, tick } = setup();
    const { id } = await wizard.start("bee@example.com", "micro-ip");
    fake.state.services.push({ id: 41 });
    fake.state.booted = true;
    await wizard.status(id);
    tick(26 * 60_000);
    expect((await wizard.status(id)).stage).toBe("failed");
  });

  it("rejects bad input and unknown ids", async () => {
    const { wizard } = setup();
    await expect(wizard.start("nope", "micro-ip")).rejects.toThrow(/email/);
    await expect(wizard.start("a@b.co", "micro")).rejects.toThrow(/plans/);
    await expect(wizard.start("a@b.co", "ai-agent-ip")).rejects.toThrow(/plans/);
    await expect(wizard.status("x".repeat(32))).rejects.toThrow(/couldn't find/);
  });

  it("never shows tokens or keys", () => {
    expect(view({ id: "i", stage: "ready", plan: "p", eqvpsToken: "t", privateKey: "k", setupUrl: "u" })).toEqual({ id: "i", stage: "ready", plan: "p", setupUrl: "u" });
  });
});
