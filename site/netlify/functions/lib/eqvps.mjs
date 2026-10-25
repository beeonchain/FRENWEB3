// EQVPS REST API (https://eqvps.com/en/docs/rest): no-KYC VPS paid in crypto.
// Response shapes beyond the documented quickstart are read defensively.

export function eqvpsClient({ base = "https://api.eqvps.com/api/v1/eqvps", fetchFn = fetch } = {}) {
  async function call(method, path, { token, body } = {}) {
    const res = await fetchFn(base + path, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 200) };
    }
    return { ok: res.ok, status: res.status, json };
  }

  const fail = (what, r) => new Error(`EQVPS ${what} failed (${r.status}): ${r.json.message ?? "no message"}`);
  const unwrap = (j) => (j && typeof j === "object" && "data" in j ? j.data : j);

  return {
    async products() {
      const r = await call("GET", "/products");
      if (!r.ok) throw fail("plans", r);
      return unwrap(r.json);
    },

    /** { token } on success, { emailTaken } when the email has an account already. */
    async register(email) {
      const r = await call("POST", "/auth/register", { body: { email } });
      const token = r.json.token ?? r.json.data?.token;
      if (r.ok && token) return { token };
      const emailErr = (r.json.errors?.email ?? []).join(" ");
      if (r.status === 422 && /taken|exist|already|registered/i.test(emailErr || r.json.message || "")) return { emailTaken: true };
      return { message: emailErr || r.json.message };
    },

    async requestCode(email) {
      const r = await call("POST", "/auth/otp/request", { body: { email } });
      if (!r.ok) throw fail("sign-in code", r);
    },

    /** The Bearer token, or null when the code is wrong. */
    async verifyCode(email, code) {
      const r = await call("POST", "/auth/otp/verify", { body: { email, code } });
      if (!r.ok) {
        if (r.status >= 400 && r.status < 500) return null;
        throw fail("sign-in", r);
      }
      return r.json.token ?? r.json.data?.token ?? null;
    },

    /** [{ id, status }] */
    async services(token) {
      const r = await call("GET", "/services", { token });
      if (!r.ok) throw fail("server list", r);
      const list = unwrap(r.json);
      return (Array.isArray(list) ? list : []).map((s) => ({ id: s.id ?? s.service_id, status: s.status }));
    },

    /** { status, host, port } */
    async service(token, id) {
      const r = await call("GET", `/services/${id}`, { token });
      if (!r.ok) throw fail("server status", r);
      const s = unwrap(r.json);
      const access = s.access ?? {};
      return { status: String(s.status ?? "").toLowerCase(), host: access.host ?? s.ip ?? null, port: access.port ?? 22 };
    },

    /** { paid, serviceId?, invoiceId? } */
    async order(token, body) {
      const r = await call("POST", "/orders", { token, body });
      if (!r.ok) throw fail("order", r);
      const j = unwrap(r.json);
      return {
        paid: !!j.paid_from_balance,
        serviceId: j.service_id ?? j.service?.id,
        invoiceId: j.invoice?.id ?? j.invoice_id,
      };
    },

    /** { checkoutUrl, amountUsd? } */
    async payInvoice(token, invoiceId) {
      const r = await call("POST", `/invoices/${invoiceId}/pay`, { token });
      if (!r.ok) throw fail("checkout", r);
      const j = unwrap(r.json);
      const checkoutUrl = j.checkout_url ?? j.url;
      if (!checkoutUrl) throw new Error("EQVPS didn't return a checkout link.");
      const amount = Number(j.amount ?? j.total ?? j.amount_usd);
      return { checkoutUrl, ...(Number.isFinite(amount) && amount > 0 ? { amountUsd: amount } : {}) };
    },
  };
}
