(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const MOCK = params.has("mock");
  const STEPS = ["plan", "pay", "build", "ready"];
  const SCREENS = ["s-plan", "s-code", "s-pay", "s-build", "s-ready", "s-failed"];
  const FALLBACK_PLANS = [
    { slug: "micro-ip", name: "Micro", priceUsd: 10, vcpu: 2, ramGb: 2, recommended: true },
    { slug: "ai-agent-ip", name: "AI Agent", priceUsd: 15 },
    { slug: "small-ip", name: "Small", priceUsd: 16 },
  ];

  let id = params.get("id");
  let timer = null;
  let apiDown = false;
  const NOT_OPEN = "The VPS wizard isn't open yet. Check back very soon, or use the one-line install for now.";

  // ---- API (real, or a local mock when the page has ?mock) ----
  const mock = {
    key: "fren-vps-mock",
    load() {
      try {
        return JSON.parse(sessionStorage.getItem(this.key)) || {};
      } catch {
        return {};
      }
    },
    save(v) {
      try {
        sessionStorage.setItem(this.key, JSON.stringify(v));
      } catch {}
    },
    run(path, body) {
      const db = this.load();
      if (path === "plans") return { plans: FALLBACK_PLANS };
      if (path === "start") {
        const nid = "mock_" + Math.random().toString(36).slice(2, 10);
        db[nid] = { plan: body.plan, t: Date.now(), needsCode: /existing/.test(body.email) };
        this.save(db);
        return db[nid].needsCode ? { id: nid, stage: "needs_code" } : this.view(nid, db[nid]);
      }
      if (path === "code") {
        if (body.code !== "123456") throw new Error("That code didn't match. Try again.");
        db[body.id].needsCode = false;
        db[body.id].t = Date.now();
        this.save(db);
        return this.view(body.id, db[body.id]);
      }
      if (path === "status") {
        if (!db[body.id]) throw new Error("not found");
        return this.view(body.id, db[body.id]);
      }
    },
    view(nid, r) {
      const s = (Date.now() - r.t) / 1000;
      const plan = FALLBACK_PLANS.find((p) => p.slug === r.plan) || FALLBACK_PLANS[0];
      const base = { id: nid, plan: r.plan, amountUsd: plan.priceUsd, checkoutUrl: "https://example.com/checkout/" + nid };
      if (s < 8) return { ...base, stage: "awaiting_payment" };
      if (s < 14) return { ...base, stage: "provisioning", progress: "Booting Ubuntu 24.04" };
      if (s < 22) return { ...base, stage: "installing", progress: "Installing Fren and starting the service" };
      return { ...base, stage: "ready", setupUrl: "https://203-0-113-7.sslip.io/setup?t=mocktoken" };
    },
  };

  async function api(path, body) {
    if (MOCK) {
      await new Promise((r) => setTimeout(r, 350));
      return mock.run(path, body || {});
    }
    const url =
      path === "status" ? `/api/vps/status?id=${encodeURIComponent(body.id)}` : `/api/vps/${path}`;
    const res = await fetch(url, {
      method: path === "plans" || path === "status" ? "GET" : "POST",
      headers: path === "plans" || path === "status" ? {} : { "Content-Type": "application/json" },
      body: path === "plans" || path === "status" ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const e = new Error(
        (data && data.error) ||
          (res.status === 404 || apiDown ? NOT_OPEN : "Something went wrong. Please try again."),
      );
      e.status = res.status;
      throw e;
    }
    return data;
  }

  // ---- UI ----
  function show(screen, step) {
    SCREENS.forEach((s) => ($(s).hidden = s !== screen));
    const at = STEPS.indexOf(step);
    document.querySelectorAll("#rail li").forEach((li, i) => {
      li.classList.toggle("is-now", i === at);
      li.classList.toggle("is-done", i < at);
    });
  }

  function remember(nid) {
    id = nid;
    const u = new URL(location.href);
    u.searchParams.set("id", nid);
    history.replaceState(null, "", u);
  }

  // One plan, sized for Fren: users shouldn't have to compare server specs.
  function renderPlans(plans) {
    const p = plans.find((x) => x.recommended) || plans[0];
    const box = $("plans");
    box.replaceChildren();
    const card = document.createElement("div");
    card.className = "plan plan--only";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "plan";
    input.value = p.slug;
    input.checked = true;
    input.hidden = true;
    const name = document.createElement("b");
    name.textContent = "Fren server";
    const price = document.createElement("span");
    price.className = "plan__price";
    price.append(`$${p.priceUsd}`);
    const per = document.createElement("small");
    per.textContent = " /month";
    price.append(per);
    const spec = document.createElement("span");
    spec.className = "plan__spec";
    spec.textContent =
      "Everything Fren needs to run 24/7" +
      (p.vcpu ? `: ${p.vcpu} vCPU, ${p.ramGb} GB memory and its own IP address.` : ", with its own IP address.") +
      " Billed monthly in crypto, stop anytime.";
    card.append(input, name, price, spec);
    box.append(card);
  }

  function renderStage(d) {
    if (d.id) remember(d.id);
    clearTimeout(timer);
    switch (d.stage) {
      case "needs_code":
        show("s-code", "plan");
        $("code").focus();
        return;
      case "awaiting_payment":
        show("s-pay", "pay");
        if (d.amountUsd != null) $("amount").textContent = `$${d.amountUsd}`;
        if (d.checkoutUrl) {
          $("checkout").href = d.checkoutUrl;
          drawQr(d.checkoutUrl);
        }
        break;
      case "provisioning":
      case "installing": {
        show("s-build", "build");
        const order = ["provisioning", "installing", "ready"];
        const at = order.indexOf(d.stage);
        document.querySelectorAll("#build li").forEach((li, i) => {
          li.classList.toggle("is-done", i < at);
          li.classList.toggle("is-now", i === at);
        });
        $("progress").textContent = d.progress || "";
        break;
      }
      case "ready":
        show("s-ready", "ready");
        $("setup-link").href = d.setupUrl;
        return;
      case "failed":
        show("s-failed", "build");
        $("fail-msg").textContent = d.error || "The server didn't finish setting up.";
        return;
    }
    timer = setTimeout(poll, 5000);
  }

  let qrFor = null;
  function drawQr(url) {
    if (qrFor === url || typeof qrcode !== "function") return;
    qrFor = url;
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    $("qr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  async function poll() {
    try {
      renderStage(await api("status", { id }));
    } catch (e) {
      if (e.status === 400 || e.status === 404 || e.message === "not found") {
        show("s-failed", "plan");
        $("fail-msg").textContent =
          e.status === 400 ? e.message : "We couldn't find that setup. The link may be wrong or expired.";
        return;
      }
      timer = setTimeout(poll, 8000); // network blip: keep trying
    }
  }

  function busy(btn, on, label) {
    btn.disabled = on;
    if (label) btn.innerHTML = label;
  }

  $("s-plan").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("email").value.trim();
    const plan = (document.querySelector('input[name="plan"]:checked') || {}).value;
    $("err-plan").textContent = "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      $("err-plan").textContent = "Enter a valid email address.";
      $("email").focus();
      return;
    }
    const btn = $("go");
    busy(btn, true, "Creating your order…");
    try {
      renderStage(await api("start", { email, plan }));
    } catch (e) {
      $("err-plan").textContent = apiDown ? NOT_OPEN : e.message;
    } finally {
      busy(btn, false, "Continue to payment&nbsp;→");
    }
  });

  $("s-code").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = $("code").value.replace(/\D/g, "");
    $("err-code").textContent = "";
    if (code.length !== 6) {
      $("err-code").textContent = "Enter the 6-digit code from your email.";
      return;
    }
    try {
      renderStage(await api("code", { id, code }));
    } catch (e) {
      $("err-code").textContent = e.message;
    }
  });

  // ---- boot ----
  (async () => {
    renderPlans(FALLBACK_PLANS);
    show("s-plan", "plan");
    if (id) {
      poll();
      return;
    }
    try {
      const { plans } = await api("plans");
      if (Array.isArray(plans) && plans.length) renderPlans(plans);
    } catch {
      apiDown = true;
    }
  })();
})();
