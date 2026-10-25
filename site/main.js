(() => {
  "use strict";
  const t = document.documentElement,
    e = window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    s = (t) => document.querySelector(t),
    o = (t) => [...document.querySelectorAll(t)],
    n = (t) => new Promise((e) => setTimeout(e, t)),
    i = (t, e = 0, s = 1) => Math.min(s, Math.max(e, t)),
    a = (t, e, s) => t + (e - t) * s,
    l = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    r = (t) => 1 - Math.pow(1 - t, 3),
    d = (t) => Math.sin(Math.PI * i(t));
  let p = null;
  function u(e, s) {
    t.classList.contains("is-killed") ||
      o(".pupil:not(.pupil--scripted)").forEach((t) => {
        const o = t.ownerSVGElement.getBoundingClientRect();
        if (!o.width) return;
        const n = o.height / 80,
          i = e - (o.left + 84 * n),
          a = s - (o.top + 40 * n),
          l = Math.hypot(i, a) || 1,
          r = Math.min(8, l / 12);
        (t.setAttribute("cx", (84 + (i / l) * r).toFixed(2)),
          t.setAttribute("cy", (40 + (a / l) * r).toFixed(2)));
      });
  }
  if (!e) {
    let t = null;
    window.addEventListener(
      "mousemove",
      (e) => {
        ((p = [e.clientX, e.clientY]),
          t ||
            (t = requestAnimationFrame(() => {
              ((t = null), u(...p));
            })));
      },
      { passive: !0 },
    );
  }
  const f = s("#scene"),
    y = s("#phone"),
    m = s("#hero"),
    x = [...m.children],
    g = s("#hint"),
    w = s(".top"),
    v = s("#dotfield"),
    L = s("#dotfield-fin"),
    b = s("#hello"),
    F = s("#lets"),
    M = s("#chat-feed"),
    C = s("#does"),
    $ = s("#does-word"),
    E = s("#does-desc"),
    k = o("#does-tabs span:not(.does__thumb)"),
    S = s("#does-thumb");
  function A(t) {
    const e = k[t];
    e && ((S.style.width = e.offsetWidth + "px"), (S.style.transform = `translateX(${e.offsetLeft}px)`));
  }
  const W = s("#safe-title"),
    _ = s("#box-back"),
    T = s("#box-front"),
    B = s("#box-caption"),
    H = o(".tile"),
    P = s("#tiles"),
    q = o("#progress span"),
    Y = o("#progress i"),
    R = s("#fin-l"),
    G = s("#fin-r"),
    I = s("#get"),
    O = [
      {
        word: "trade",
        desc: "Go long or short on crypto, gold and stocks with leverage, or buy calls and puts on Derive.",
        you: "Long gold, $300 at 50x",
        fren: "Done. You’re long gold at 50x.",
        status: "Filled",
        meta: "Gold · Long · 50x · $300",
      },
      {
        word: "buy anything",
        desc: "Solana and pump.fun buys with CA sniping, plus Base and Robinhood Chain. One chat for every chain.",
        you: "Buy $50 of ETH on Base",
        fren: "Done. Your ETH is on Base.",
        status: "Bought",
        meta: "ETH · Base · $50",
      },
      {
        word: "plan ahead",
        desc: "“Say when” orders that fire when your conditions hit, predictions on Polymarket, and idle funds put to work.",
        you: "Short SOL if funding goes above 0.02%",
        fren: "Got it. I’ll short SOL the moment it does.",
        status: "Watching",
        meta: "SOL · Short · funding > 0.02%",
      },
    ];
  function D(t, e, s) {
    const o = document.createElement(t);
    return (e && (o.className = e), null != s && (o.textContent = s), o);
  }
  const z = O.map((t) => {
      const e = (function (t, e) {
          const s = D("div", "msg msg--" + t);
          return (s.appendChild(D("div", "bub", e)), s);
        })("you", t.you),
        s = D("span", "msg__ticks");
      ((s.innerHTML =
        '<svg width="16" height="10" viewBox="0 0 16 10" fill="none"><path d="M1 5.5 4 8.5 10 1.5M7 7.5l1 1 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
        e.firstElementChild.appendChild(s));
      const o = D("div", "msg msg--fren msg--answer"),
        n = D("div", "bub");
      n.appendChild(D("span", "ans__text", t.fren));
      const i = D("span", "ans__receipt");
      return (
        i.append(D("span", "ans__status", t.status), D("span", "ans__meta", t.meta)),
        n.appendChild(i),
        o.appendChild(n),
        M.append(e, o),
        { you: e, fren: o }
      );
    }),
    N = D("div", "msg msg--fren msg--typing"),
    V = D("div", "bub typing");
  (V.append(D("i"), D("i"), D("i")), N.appendChild(V), M.appendChild(N));
  const X = 0.3,
    j = 0.42,
    U = 0.45,
    J = 0.66;
  function K(t, s) {
    s !== t.classList.contains("is-shown") &&
      (s
        ? (function (t) {
            const s = [...M.querySelectorAll(".msg.is-shown")].map((t) => [
              t.firstElementChild,
              t.firstElementChild.getBoundingClientRect().top,
            ]);
            (t.classList.add("is-shown"),
              e ||
                s.forEach(([t, e]) => {
                  const s = e - t.getBoundingClientRect().top;
                  Math.abs(s) < 0.5 ||
                    ((t.style.transition = "none"),
                    (t.style.transform = `translateY(${s}px)`),
                    t.offsetWidth,
                    (t.style.transition = "transform .5s var(--ease)"),
                    (t.style.transform = ""));
                }));
          })(t)
        : (function (t) {
            t.classList.remove("is-shown", "is-read");
          })(t));
  }
  let Q = -1;
  let Z = {},
    tt = [1, 1, 1];
  function et() {
    const e = window.innerWidth,
      s = window.innerHeight,
      o = e < 860,
      n = getComputedStyle(t),
      a = parseFloat(n.getPropertyValue("--phone-w")),
      l = parseFloat(n.getPropertyValue("--phone-h")),
      r = 64,
      d = Math.round(s * (o ? 0.27 : 0.34));
    let c, h, p;
    if ((t.style.setProperty("--peek", d + "px"), o))
      ((c = Math.min(0.85, (0.58 * s) / l)), (h = (e - a * c) / 2), (p = s - l * c - 14));
    else {
      c = Math.min(1, (s - r - 56) / l);
      ((h = Math.max(24, (e - 1120) / 2 + 24) + 0.76 * Math.min(1072, e - 48) - (a * c) / 2),
        (p = r + (s - r - l * c) / 2));
    }
    const u = Math.round(W.offsetTop + W.offsetHeight + (o ? 20 : Math.max(28, 0.04 * s)));
    t.style.setProperty("--tiles-top", u + "px");
    const y = u + P.offsetHeight,
      m = o ? s - 20 - 120 : s - 28 - 150,
      x = i((m - y - (o ? 24 : 36)) / (0.65 * l), o ? 0.36 : 0.4, o ? 0.5 : 0.72),
      g = (e - a * x) / 2,
      w = m - l * x * 0.65,
      v = 1.1 * s,
      L = 1.3 * s,
      b = O.length * L,
      F = 0.95 * s,
      M = 0.42 * s,
      C = H.length * M,
      $ = o ? Math.min(0.8, (s - r - 150) / l) : Math.min(0.9, (s - r - 60) / l),
      E = (e - a * $) / 2,
      k = o ? s - l * $ - 18 : r + (s - r - l * $) / 2,
      S = 1.2 * s,
      A = s + v + b + F + C + S + 0.35 * s;
    f.style.height = A + "px";
    const _ = [v + b, F + C, S + 0.35 * s];
    (q.forEach((t, e) => {
      t.style.flexGrow = _[e];
    }),
      (tt = _),
      (I.style.top = A - s + "px"),
      (Z = {
        vw: e,
        vh: s,
        mobile: o,
        W: a,
        H: l,
        header: r,
        x0: (e - a) / 2,
        y0: s - d,
        s1: c,
        x1: h,
        y1: p,
        s2: x,
        x2: g,
        y2: w,
        s3: $,
        x3: E,
        y3: k,
        intro: v,
        step: L,
        doesLen: b,
        move: F,
        safeStep: M,
        safeLen: C,
        finLen: S,
        sceneH: A,
      }));
  }
  function st(t, e, s, o) {
    const n = (Z.W / 2) * (1 - s),
      i = (Z.H / 2) * (1 - s);
    y.style.transform = `translate(${(t - n).toFixed(1)}px, ${(e - i).toFixed(1)}px) rotate(${o.toFixed(2)}deg) scale(${s.toFixed(4)})`;
  }
  const ot = (t, e, s, o) => (1 - o) * (1 - o) * t + 2 * (1 - o) * o * e + o * o * s;
  function nt(t, s) {
    const o = i(t / Z.intro),
      n = i((t - Z.intro) / Z.doesLen),
      c = i((s - Z.intro) / Z.doesLen),
      h = i((t - Z.intro - Z.doesLen) / Z.move),
      p = (s - Z.intro - Z.doesLen - Z.move) / Z.safeStep,
      u = i((t - Z.intro - Z.doesLen - Z.move - Z.safeLen) / Z.finLen);
    if (u > 0) {
      const t = 16 * d(u / 0.14),
        e = i((u - 0.1) / 0.75),
        s = l(e),
        o = Z.x2 + 0.5 * (Z.x3 - Z.x2),
        n = Math.min(Z.y2, Z.y3) - Z.vh * (Z.mobile ? 0.12 : 0.22),
        r = d((s - 0.82) / 0.18),
        c = a(Z.s2, Z.s3, s) + 0.05 * d(s);
      st(
        ot(Z.x2, o, Z.x3, s),
        ot(Z.y2, n, Z.y3, s) + t * (1 - e) + 12 * r,
        c,
        -8 * Math.sin(2 * Math.PI * s) + 2 * r,
      );
    } else if (h <= 0) {
      const t = 26 * d(o / 0.16),
        e = i((o - 0.08) / 0.92),
        s = l(e),
        n = Z.mobile ? Z.x0 - 0.12 * Z.vw : Z.x0 - 0.06 * Z.vw,
        r = Math.min(Z.y0, Z.y1) - Z.vh * (Z.mobile ? 0.18 : 0.3),
        c = d((s - 0.82) / 0.18),
        h = a(1, Z.s1, s) + 0.06 * d(s);
      st(ot(Z.x0, n, Z.x1, s), ot(Z.y0, r, Z.y1, s) + t * (1 - e) - 10 * c, h, 12 * d(1.1 * s) - 3 * c);
    } else {
      const t = l(h),
        e = (Z.x1 + Z.x2) / 2 + 0.05 * Z.vw,
        s = Math.min(Z.y1, Z.y2) - 0.08 * Z.vh,
        o = d((t - 0.8) / 0.2);
      st(ot(Z.x1, e, Z.x2, t), ot(Z.y1, s, Z.y2, t) + 14 * o, a(Z.s1, Z.s2, t), -10 * d(t) + 2 * o);
    }
    (f.classList.toggle("is-hero", o <= 0.001),
      f.classList.toggle("is-chat", (o > 0.62 && h < 0.4) || u > 0.4),
      f.classList.toggle("is-final", u > 0.4));
    const y = [1, 0.8, 0.6],
      S = [3.4, 3.8, 4.4];
    (x.forEach((t, e) => {
      const s = r(i(o * S[e]));
      ((t.style.opacity = (1 - s).toFixed(3)),
        (t.style.transform = `translateY(${(50 * -s * y[e]).toFixed(1)}px)`));
    }),
      (m.style.visibility = o >= 0.45 ? "hidden" : ""));
    let P = 0;
    (tt.forEach((e, s) => {
      const o = i((t - P) / e);
      ((Y[s].style.transform = `scaleX(${(o > 0.995 ? 1 : o).toFixed(4)})`), (P += e));
    }),
      w.classList.toggle("is-solid", s > Z.sceneH - Z.vh - 8),
      (g.style.opacity = (1 - i(4 * o)).toFixed(3)),
      (v.style.opacity = (1 - i(2.2 * o)).toFixed(3)));
    const q = b.offsetWidth,
      I = b.offsetHeight,
      D = r(i(3.2 * o)),
      V = 26 * d(o / 0.16);
    b.style.opacity = (1 - D).toFixed(3);
    const et = Z.mobile ? Z.x0 + Z.W / 2 - q / 2 : Z.x0 + Z.W - 46,
      nt = Z.mobile ? Z.y0 - I - 18 : Z.y0 - 0.6 * I,
      it = Z.mobile ? 0 : -4;
    b.style.transform = `translate(${(et - 60 * D).toFixed(1)}px, ${(nt + V - 40 * D).toFixed(1)}px) rotate(${(it - 8 * D).toFixed(2)}deg)`;
    const at = i((o - 0.3) / 0.62),
      lt = F.offsetWidth;
    ((F.style.opacity = (
      at <= 0 || at >= 1 ? 0 : at < 0.15 ? at / 0.15 : at > 0.85 ? (1 - at) / 0.15 : 1
    ).toFixed(3)),
      (F.style.transform = `translate(${a(Z.vw / 2 - lt / 2, Z.x1 + Z.W * Z.s1 - lt - 18, l(at)).toFixed(1)}px, ${a(0.55 * Z.vh, Z.y1 + 118 * Z.s1, l(at)).toFixed(1)}px) rotate(${a(-6, 0, at).toFixed(2)}deg)`));
    const rt = i((o - 0.55) / 0.45),
      dt = 1 - i(2.5 * h);
    ((C.style.opacity = (rt * dt).toFixed(3)),
      C.classList.toggle("is-live", rt * dt > 0.9),
      (C.style.transform = `translate(${(28 * -(1 - rt)).toFixed(1)}px, ${(40 * -(1 - dt)).toFixed(1)}px)`),
      (function (t) {
        if (t === Q) return;
        const s = -1 === Q;
        if (((Q = t), k.forEach((e, s) => e.classList.toggle("is-on", s === t)), A(t), s || e))
          return (($.textContent = O[t].word), void (E.textContent = O[t].desc));
        ($.classList.remove("is-in"),
          $.classList.add("is-out"),
          E.classList.add("is-swap"),
          setTimeout(() => {
            Q === t &&
              (($.textContent = O[t].word),
              (E.textContent = O[t].desc),
              $.classList.remove("is-out"),
              $.offsetWidth,
              $.classList.add("is-in"),
              E.classList.remove("is-swap"));
          }, 260));
      })(o >= 1 ? Math.min(O.length - 1, Math.floor(c * O.length)) : 0),
      (function (t, e) {
        const s = Math.min(O.length - 1, Math.floor(t * O.length)),
          o = t * O.length - s,
          n = e && o >= U && o < J ? z[s].fren : null;
        (n || K(N, !1),
          z.forEach((t, n) => {
            const i = e && n < s,
              a = e && n === s;
            (K(t.you, i || (a && o >= X)),
              t.you.classList.toggle("is-read", i || (a && o >= j)),
              K(t.fren, i || (a && o >= J)));
          }),
          n && (N.nextSibling !== n && M.insertBefore(N, n), K(N, !0)));
      })(n, o >= 1));
    const ct = i((h - 0.55) / 0.4) * (1 - i(3 * u));
    ((W.style.opacity = ct.toFixed(3)), (W.style.transform = `translateY(${(24 * (1 - ct)).toFixed(1)}px)`));
    const ht = i((h - 0.25) / 0.45),
      pt = i((u - 0.18) / 0.4);
    var ut;
    ((_.style.opacity = T.style.opacity = (i(3 * ht) * (1 - i(2.5 * pt))).toFixed(3)),
      (_.style.transform = T.style.transform =
        `translateY(${(220 * (1 - r(ht)) + 260 * ((ut = pt), ut * ut * ut)).toFixed(1)}px)`),
      B.classList.toggle("is-on", h >= 1 && u < 0.15));
    const ft = h >= 1 ? Math.min(H.length - 1, Math.floor(p)) : -1;
    H.forEach((t, e) => {
      (t.classList.toggle("is-on", h >= 1 && p >= e && u < 0.12), t.classList.toggle("is-now", e === ft));
    });
    const yt = r(i((u - 0.55) / 0.35)),
      mt = parseFloat(getComputedStyle(R).fontSize),
      xt = R.offsetWidth,
      gt = G.offsetWidth,
      wt = Z.W * Z.s3,
      vt = Math.max(32, 0.03 * Z.vw);
    let Lt, bt, Ft;
    if (!Z.mobile && Z.x3 - vt - xt > 24)
      ((Lt = Z.x3 - vt - xt), (bt = Z.x3 + wt + vt), (Ft = Z.y3 + Z.H * Z.s3 * 0.42 - mt / 2));
    else {
      const t = xt + gt + 0.25 * mt;
      ((Lt = (Z.vw - t) / 2), (bt = Lt + xt + 0.25 * mt), (Ft = Z.header + 18));
    }
    ((R.style.opacity = G.style.opacity = yt.toFixed(3)),
      (L.style.opacity = (0.9 * r(i((u - 0.45) / 0.5))).toFixed(3)),
      (R.style.transform = `translate(${(Lt - 60 * (1 - yt)).toFixed(1)}px, ${Ft.toFixed(1)}px)`),
      (G.style.transform = `translate(${(bt + 60 * (1 - yt)).toFixed(1)}px, ${Ft.toFixed(1)}px)`));
  }
  let it = null,
    at = !1,
    lt = 0;
  function rt(t) {
    const s = window.scrollY - f.offsetTop,
      o = lt ? Math.min(0.05, (t - lt) / 1e3) : 1 / 60;
    ((lt = t),
      (it = null == it || e ? s : it + (s - it) * (1 - Math.exp(-o / 0.32))),
      Math.abs(s - it) < 0.4 && (it = s),
      nt(it, it),
      it !== s ? requestAnimationFrame(rt) : ((at = !1), (lt = 0)));
  }
  function dt() {
    at || ((at = !0), requestAnimationFrame(rt));
  }
  (window.addEventListener("scroll", dt, { passive: !0 }),
    window.addEventListener("resize", () => {
      (et(), (it = null), dt(), A(Math.max(0, Q)));
    }),
    et(),
    rt(performance.now()),
    document.fonts &&
      document.fonts.ready.then(() => {
        (et(), (it = null), dt(), A(Math.max(0, Q)));
      }),
    k.forEach((t, s) => {
      const go = () =>
        window.scrollTo({
          top: f.offsetTop + Z.intro + Z.step * (s + 0.85),
          behavior: e ? "auto" : "smooth",
        });
      (t.setAttribute("role", "button"),
        t.setAttribute("tabindex", "0"),
        t.addEventListener("click", go),
        t.addEventListener("keydown", (ev) => {
          ("Enter" !== ev.key && " " !== ev.key) || (ev.preventDefault(), go());
        }));
    }));
  const ct = s("#loader"),
    ht = s("#loader-mark"),
    pt = s("#hero-mark"),
    ut = b.querySelector(".float__in"),
    ft = ut.textContent;
  async function yt() {
    e ||
      (ut.classList.add("is-typing"),
      ut.replaceChildren(D("i"), D("i"), D("i")),
      dt(),
      await n(950),
      ut.classList.remove("is-typing"),
      (ut.textContent = ft),
      dt());
  }
  function mt() {
    ((ct.hidden = !0),
      (pt.style.visibility = ""),
      t.classList.remove("is-loading", "is-rising"),
      t.classList.add("is-revealing"),
      setTimeout(yt, 950),
      setTimeout(() => t.classList.remove("is-revealing", "is-catch"), 2200));
  }
  if (
    ((() => {
      const t = m.querySelector(".hero__title");
      let e = 0;
      [...t.childNodes].forEach((t) => {
        if (3 === t.nodeType) {
          const s = document.createDocumentFragment();
          (t.textContent.split(/(\s+)/).forEach((t) => {
            if (!t) return;
            if (/^\s+$/.test(t)) return void s.appendChild(document.createTextNode(t));
            const o = D("span", "hw");
            (o.setAttribute("aria-hidden", "true"),
              o.style.setProperty("--i", e++),
              o.appendChild(D("span", null, t)),
              s.appendChild(o));
          }),
            t.replaceWith(s));
        } else
          t.classList &&
            t.classList.contains("plq") &&
            (t.setAttribute("aria-hidden", "true"), t.style.setProperty("--i", e++));
      });
    })(),
    e || window.scrollY > 40)
  )
    ((ct.hidden = !0), t.classList.remove("is-loading"));
  else {
    const e = () => {
      ct.hidden || mt();
    };
    (ct.addEventListener("click", e),
      window.addEventListener("keydown", e, { once: !0 }),
      window.addEventListener("wheel", e, { once: !0, passive: !0 }),
      window.addEventListener("touchstart", e, { once: !0, passive: !0 }),
      (async function () {
        const e = ht.querySelector(".pupil"),
          s = (t, s) => {
            (e.setAttribute("cx", 84 + t), e.setAttribute("cy", 40 + s));
          };
        (await n(300),
          ct.classList.add("is-awake"),
          await n(480),
          s(-8, 0),
          await n(400),
          s(8, 0),
          await n(400),
          ct.classList.add("is-blink"),
          await n(110),
          ct.classList.remove("is-blink"),
          await n(160),
          ct.classList.add("is-gm"),
          await n(800),
          ct.classList.add("is-gm-out"),
          await n(260),
          t.classList.add("is-rising"),
          await n(780));
        const o = pt.querySelector(".pupil");
        ((e.style.transition = "none"),
          e.setAttribute("cx", o.getAttribute("cx")),
          e.setAttribute("cy", o.getAttribute("cy")),
          (pt.style.visibility = "hidden"));
        const i = ht.getBoundingClientRect(),
          a = pt.getBoundingClientRect();
        ((ht.style.transition = "transform .85s cubic-bezier(.6,0,.2,1)"),
          (ht.style.transform = `translate(${a.left - i.left}px, ${a.top - i.top}px) scale(${a.width / i.width})`),
          await n(860),
          t.classList.add("is-catch"),
          mt());
      })().catch(e));
  }
  const xt = new IntersectionObserver(
    (t) => {
      t.forEach((t) => {
        t.isIntersecting && (t.target.classList.add("is-in"), xt.unobserve(t.target));
      });
    },
    { threshold: 0.15 },
  );
  o(".reveal").forEach((t) => (e ? t.classList.add("is-in") : xt.observe(t)));
  const gt = s("#kill"),
    wt = s("#kill-note"),
    vt = wt.textContent;
  gt.addEventListener("click", () => {
    const e = "true" !== gt.getAttribute("aria-checked");
    (gt.setAttribute("aria-checked", String(e)),
      t.classList.toggle("is-killed", e),
      (s("#chat-status").textContent = e ? "paused" : "online"),
      (wt.textContent = e ? "Everything’s paused until you say so." : vt),
      !e && p && u(...p));
  });
})();
(() => {
  "use strict";
  const btn = document.getElementById("cmd-copy"),
    cmd = document.getElementById("cmd-text");
  if (!btn || !cmd) return;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cmd.textContent.trim());
      btn.textContent = "Copied";
    } catch {
      getSelection().selectAllChildren(cmd);
      btn.textContent = "Press ⌘C";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1800);
  });
})();
