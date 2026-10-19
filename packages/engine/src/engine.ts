import { randomBytes, randomUUID } from "node:crypto";
import {
  applyLimitArgs,
  describeConditionStatus,
  describeDecision,
  describeStep,
  evaluateAll,
  evaluatePolicy,
  isTightening,
  price as fmtPrice,
  safeParsePlan,
  snapshotKey,
  signedUsd,
  usd as fmtUsd,
  type Condition,
  type Limits,
  type MarketSnapshot,
  type Plan,
  type PlanStep,
  type PolicyDecision,
  type ResolvedStep,
  type Venue,
} from "@fren/core";
import type { Addresses, SignerApi } from "@fren/signer";
import type { Notifier } from "./notify.js";
import type { Mode, PendingKind, Store } from "./store.js";
import type { HyperliquidVenue } from "./venues/hyperliquid.js";
import type { JupiterVenue } from "./venues/jupiter.js";
import { VenueError, type PositionView, type VenueAdapter } from "./venues/types.js";

export interface FrenDeps {
  store: Store;
  hyperliquid: HyperliquidVenue;
  jupiter: JupiterVenue;
  notifier: Notifier;
  signer: SignerApi | null;
  isTestnet: boolean;
  codeTtlMs?: number;
}

export interface SubmitResult {
  planId: string | null;
  verdict: "executed" | "needs_code" | "rejected" | "invalid";
  /** Plain-English reply for the chat, safe to show the model. Never contains a code. */
  text: string;
  /** True when the code went straight to the owner over a private line. */
  codeSentPrivately?: boolean;
  /**
   * Only set when there is no private line. The caller must deliver this to the
   * owner without showing it to the model.
   */
  ownerCode?: string;
}

export interface OwnerRequestResult {
  text: string;
  codeSentPrivately?: boolean;
  ownerCode?: string;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export class Fren {
  private readonly venues: Record<Venue, VenueAdapter>;
  private ticking = false;

  constructor(private readonly d: FrenDeps) {
    this.venues = { hyperliquid: d.hyperliquid, jupiter: d.jupiter };
  }

  get store() {
    return this.d.store;
  }

  limits(): Limits {
    return this.d.store.getLimits();
  }

  private policyState(mode: Mode) {
    return {
      spentTodayUsd: this.d.store.spentTodayUsd(mode),
      openPositions: mode === "paper" ? this.d.store.paperPositions().length : this.liveOpenPositions,
    };
  }

  /** Refreshed by status() and the watcher; good enough for the open-positions cap. */
  private liveOpenPositions = 0;

  // -- plans ---------------------------------------------------------------

  private async resolveAll(steps: PlanStep[]): Promise<{ resolved: ResolvedStep[]; errors: string[] }> {
    const resolved: ResolvedStep[] = [];
    const errors: string[] = [];
    await Promise.all(
      steps.map(async (step, i) => {
        try {
          const r = await this.venues[step.leg.venue].resolve(step, i);
          r.step = { ...r.step, when: await this.canonicalConditions(r.step.when) };
          resolved.push(r);
        } catch (err) {
          errors.push(`Step ${i + 1}: ${(err as Error).message}`);
        }
      }),
    );
    resolved.sort((a, b) => a.index - b.index);
    return { resolved, errors };
  }

  /** Turn condition markets into the same symbols the watcher snapshots use. */
  private async canonicalConditions(when: Condition[]): Promise<Condition[]> {
    return Promise.all(
      when.map(async (c) => {
        if (c.type === "time") return c;
        if (c.venue === "hyperliquid") {
          const m = await this.d.hyperliquid.markets.get(c.market);
          if (!m) throw new VenueError(`No Hyperliquid market ${c.market} to watch.`);
          return { ...c, market: m.name };
        }
        if (c.type === "price") return { ...c, market: (await this.d.jupiter.token(c.market)).mint };
        return c;
      }),
    );
  }

  async submit(input: unknown): Promise<SubmitResult> {
    const parsed = safeParsePlan(input);
    if (!parsed.success) {
      return {
        planId: null,
        verdict: "invalid",
        text: `That plan doesn't fit the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      };
    }
    const plan = parsed.data;
    const limits = this.limits();
    const mode: Mode = limits.mode;

    const { resolved, errors } = await this.resolveAll(plan.steps);
    if (errors.length) return { planId: null, verdict: "rejected", text: `Couldn't set that up:\n${errors.join("\n")}` };

    const decision = evaluatePolicy(resolved, limits, this.policyState(mode));
    const id = randomUUID().slice(0, 8);
    const header = mode === "paper" ? "📝 Paper mode\n" : "";

    if (decision.verdict === "reject") {
      this.d.store.insertPlan({ id, request: plan.request, plan, status: "rejected", mode }, resolved, () => "rejected");
      return { planId: id, verdict: "rejected", text: `${header}Not doing this:\n${describeDecision(decision, resolved)}` };
    }

    const canonicalPlan: Plan = { ...plan, steps: resolved.map((r) => r.step) };
    if (decision.verdict === "confirm") {
      this.d.store.insertPlan({ id, request: plan.request, plan: canonicalPlan, status: "pending_confirm", mode }, resolved, () => "pending");
      const owner = await this.issueCode("plan", id, `Confirm this plan:\n${describeDecision(decision, resolved)}`);
      return { planId: id, verdict: "needs_code", text: `${header}${describeDecision(decision, resolved)}\n\n${owner.text}`, ...pick(owner) };
    }

    this.d.store.insertPlan({ id, request: plan.request, plan: canonicalPlan, status: "active", mode }, resolved, () => "pending");
    const text = await this.run(id, resolved, decision);
    return { planId: id, verdict: "executed", text: `${header}${text}` };
  }

  /** Run immediate steps now and arm conditional ones. Returns the one-message summary. */
  private async run(planId: string, resolved: ResolvedStep[], decision: PolicyDecision): Promise<string> {
    const rec = this.d.store.getPlan(planId);
    if (!rec) throw new Error(`Unknown plan ${planId}`);
    const lines: string[] = [];
    for (const r of resolved) {
      const warn = decision.steps.find((s) => s.index === r.index)?.warnings ?? [];
      if (r.step.when.length > 0) {
        this.d.store.setStep(planId, r.index, "waiting");
        lines.push(`👀 Watching: ${describeStep(r.step, r)}`);
        continue;
      }
      lines.push(await this.executeStep(planId, r, rec.mode));
      for (const w of warn) lines.push(`   ⚠️ ${w}`);
    }
    this.d.store.settlePlan(planId);
    if (this.d.store.getPlan(planId)?.status !== "done") this.d.store.setPlanStatus(planId, "active");
    return lines.join("\n");
  }

  private async executeStep(planId: string, r: ResolvedStep, mode: Mode): Promise<string> {
    try {
      const res = await this.venues[r.step.leg.venue].execute(r, { mode, planId, idx: r.index });
      this.d.store.setStep(planId, r.index, "filled", res.text);
      return res.text;
    } catch (err) {
      const msg = `❌ ${describeStep(r.step, r)}: ${(err as Error).message}`;
      this.d.store.setStep(planId, r.index, "failed", msg);
      return msg;
    }
  }

  // -- owner approvals -----------------------------------------------------

  private async issueCode(kind: PendingKind, payload: string, privateText: string): Promise<OwnerRequestResult> {
    const code = newCode();
    const ttl = this.d.codeTtlMs ?? 10 * 60_000;
    this.d.store.putPending({ code, kind, payload, expiresAt: new Date(Date.now() + ttl).toISOString() });
    const minutes = Math.round(ttl / 60_000);
    const sent = await this.d.notifier.sendPrivate(`🔐 ${privateText}\n\nReply /ok ${code} within ${minutes} min.`).catch(() => false);
    if (sent) return { text: `I sent you a confirmation code privately. Reply /ok <code> to go ahead.`, codeSentPrivately: true };
    return { text: `Reply /ok <code> with the code I just sent you to go ahead.`, codeSentPrivately: false, ownerCode: code };
  }

  /** The /ok command. Codes only ever reach the owner, so this is the owner speaking. */
  async approve(code: string): Promise<string> {
    const p = this.d.store.takePending(code.trim().toUpperCase());
    if (!p) return "That code is wrong or expired.";
    if (p.kind === "limits") {
      this.d.store.setLimits(JSON.parse(p.payload) as Limits);
      return `✅ Limits updated.\n${describeLimits(this.limits())}`;
    }
    if (p.kind === "resume") {
      this.d.store.setLimits({ ...this.limits(), paused: false });
      return "✅ Fren is back on. The watcher is running again.";
    }
    const rec = this.d.store.getPlan(p.payload);
    if (!rec || rec.status !== "pending_confirm") return "That plan is no longer waiting for approval.";
    const { resolved, errors } = await this.resolveAll(rec.plan.steps);
    if (errors.length) {
      this.d.store.setPlanStatus(rec.id, "rejected");
      return `Couldn't run it after all:\n${errors.join("\n")}`;
    }
    // Prices and caps may have moved while the owner read the code: check again.
    const limits = this.limits();
    const decision = evaluatePolicy(resolved, limits, this.policyState(rec.mode), { preApproved: true });
    if (decision.verdict === "reject") {
      this.d.store.setPlanStatus(rec.id, "rejected");
      return `Not doing this after all:\n${describeDecision(decision, resolved)}`;
    }
    this.d.store.setPlanStatus(rec.id, "active");
    return this.run(rec.id, resolved, decision);
  }

  /** Limits: tightening applies at once; loosening needs the owner's code. */
  async changeLimits(args: string): Promise<OwnerRequestResult> {
    const current = this.limits();
    let next: Limits;
    try {
      next = applyLimitArgs(current, args);
    } catch (err) {
      return { text: (err as Error).message };
    }
    if (isTightening(current, next)) {
      this.d.store.setLimits(next);
      return { text: `✅ Limits updated.\n${describeLimits(next)}` };
    }
    return this.issueCode("limits", JSON.stringify(next), `Loosen your limits to:\n${describeLimits(next)}`);
  }

  async requestResume(): Promise<OwnerRequestResult> {
    if (!this.limits().paused) return { text: "Fren isn't stopped." };
    return this.issueCode("resume", "", "Turn Fren back on?");
  }

  // -- kill switch -----------------------------------------------------------

  async stop(flatten: boolean): Promise<string> {
    const limits = this.limits();
    this.d.store.setLimits({ ...limits, paused: true });
    let cancelled = 0;
    for (const status of ["active", "pending_confirm"] as const) {
      for (const p of this.d.store.plansWithStatus(status)) {
        for (const s of this.d.store.getSteps(p.id)) {
          if (s.status === "waiting" || s.status === "pending") {
            this.d.store.setStep(p.id, s.idx, "cancelled", "Stopped by kill switch");
            cancelled++;
          }
        }
        this.d.store.dropPendingForPlan(p.id);
        this.d.store.setPlanStatus(p.id, "cancelled");
      }
    }
    const lines = [`🛑 Stopped. Nothing new will execute and the watcher is paused.`];
    if (cancelled) lines.push(`Cancelled ${cancelled} pending or waiting step(s).`);
    if (flatten) {
      const closes = await this.d.hyperliquid.flatten(limits.mode);
      lines.push(...(closes.length ? closes : ["No leveraged positions to close."]));
      lines.push("Spot tokens were left as they are.");
    }
    lines.push("Send /resume to turn trading back on.");
    return lines.join("\n");
  }

  async cancel(planId: string): Promise<string> {
    const rec = this.d.store.getPlan(planId);
    if (!rec) return `No plan ${planId}.`;
    for (const s of this.d.store.getSteps(planId)) {
      if (s.status === "waiting" || s.status === "pending") this.d.store.setStep(planId, s.idx, "cancelled", "Cancelled");
    }
    this.d.store.dropPendingForPlan(planId);
    this.d.store.setPlanStatus(planId, "cancelled");
    return `Cancelled plan ${planId}.`;
  }

  // -- watcher -----------------------------------------------------------------

  private async snapshot(): Promise<MarketSnapshot> {
    const snap: MarketSnapshot = { now: new Date(), prices: new Map(), funding: new Map() };
    const markets = await this.d.hyperliquid.markets.all(true).catch(() => []);
    for (const m of markets) {
      snap.prices.set(snapshotKey("hyperliquid", m.name), m.midPx);
      snap.funding.set(snapshotKey("hyperliquid", m.name), m.fundingHourlyPct);
    }
    const mints = new Set<string>();
    for (const p of this.d.store.plansWithStatus("active")) {
      for (const st of p.plan.steps) for (const c of st.when) if (c.type === "price" && c.venue === "jupiter") mints.add(c.market);
    }
    const px = await this.d.jupiter.prices([...mints]).catch(() => new Map<string, number>());
    for (const [mint, v] of px) snap.prices.set(snapshotKey("jupiter", mint), v);
    return snap;
  }

  /** One watcher pass. Plain code, no LLM: evaluate conditions, fire what's ready, report once each. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const limits = this.limits();
      if (limits.paused) return;
      const snap = await this.snapshot();
      await this.paperExits(snap);

      for (const rec of this.d.store.plansWithStatus("active")) {
        for (const s of this.d.store.getSteps(rec.id)) {
          if (s.status !== "waiting") continue;
          const step = rec.plan.steps[s.idx];
          if (!step) continue;
          if (step.expiresAt && snap.now.getTime() > new Date(step.expiresAt).getTime()) {
            this.d.store.setStep(rec.id, s.idx, "expired", "Expired before its conditions were met");
            await this.d.notifier.alert(`⌛ Expired without firing: ${describeStep(step)}`);
            continue;
          }
          const { statuses, allMet } = evaluateAll(step.when, snap);
          if (!allMet) continue;

          const { resolved, errors } = await this.resolveAll([step]);
          const r = resolved[0];
          if (errors.length || !r) {
            this.d.store.setStep(rec.id, s.idx, "failed", errors.join("; "));
            await this.d.notifier.alert(`❌ Conditions met but couldn't fire: ${errors.join("; ")}`);
            continue;
          }
          r.index = s.idx;
          const decision = evaluatePolicy([r], this.limits(), this.policyState(rec.mode), { preApproved: true });
          if (decision.verdict === "reject") {
            this.d.store.setStep(rec.id, s.idx, "rejected", describeDecision(decision, [r]));
            await this.d.notifier.alert(`❌ Conditions met but your limits blocked it:\n${describeDecision(decision, [r])}`);
            continue;
          }
          const text = await this.executeStep(rec.id, r, rec.mode);
          await this.d.notifier.alert(`⚡ Triggered\n${statuses.map(describeConditionStatus).join("\n")}\n${text}`);
        }
        this.d.store.settlePlan(rec.id);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Hyperliquid enforces live stops itself; paper positions need the watcher to play exchange. */
  private async paperExits(snap: MarketSnapshot) {
    for (const p of this.d.store.paperPositions()) {
      const mark = snap.prices.get(snapshotKey("hyperliquid", p.symbol));
      if (mark === undefined) continue;
      const long = p.side === "long";
      const pnl = (mark - p.entry) * p.size * (long ? 1 : -1);
      let verb: string | null = null;
      if (pnl <= -0.9 * p.margin) verb = "Liquidated";
      else if (p.stopPrice !== null && (long ? mark <= p.stopPrice : mark >= p.stopPrice)) verb = "Stop hit, closed";
      else if (p.takeProfitPrice !== null && (long ? mark >= p.takeProfitPrice : mark <= p.takeProfitPrice)) verb = "Target hit, closed";
      if (!verb) continue;
      const text = this.d.hyperliquid.paperCloseAt(p.symbol, mark, 1, { mode: "paper", planId: null, idx: null }, verb);
      await this.d.notifier.alert(text);
    }
  }

  // -- read-only views -----------------------------------------------------------

  async positions(): Promise<PositionView[]> {
    const mode = this.limits().mode;
    const all = (await Promise.all([this.d.hyperliquid.positions(mode), this.d.jupiter.positions(mode)])).flat();
    if (mode === "live") this.liveOpenPositions = all.filter((p) => p.kind === "perp").length;
    return all;
  }

  async status(): Promise<string> {
    const limits = this.limits();
    const lines: string[] = [];
    lines.push(limits.paused ? "🛑 Stopped (send /resume to turn back on)" : limits.mode === "paper" ? "📝 Paper mode" : "🟢 Live");

    const positions = await this.positions().catch((err: Error) => {
      lines.push(`Couldn't load positions: ${err.message}`);
      return [] as PositionView[];
    });
    if (limits.mode === "paper") lines.push(`Paper USDC: ${fmtUsd(this.d.store.paperUsdc())}`);
    if (positions.length) {
      lines.push("", "Positions:");
      for (const p of positions) lines.push(`• ${describePosition(p)}`);
    } else lines.push("", "No open positions.");

    const waiting: string[] = [];
    const snap = await this.snapshot().catch(() => null);
    for (const rec of this.d.store.plansWithStatus("active")) {
      for (const s of this.d.store.getSteps(rec.id)) {
        const step = rec.plan.steps[s.idx];
        if (s.status !== "waiting" || !step) continue;
        waiting.push(`• [${rec.id}] ${describeStep(step)}`);
        if (snap) for (const st of evaluateAll(step.when, snap).statuses) waiting.push(`   ${describeConditionStatus(st)}`);
      }
    }
    if (waiting.length) lines.push("", "Watching:", ...waiting);
    const pending = this.d.store.plansWithStatus("pending_confirm");
    if (pending.length) lines.push("", `Waiting for your /ok code: ${pending.map((p) => p.id).join(", ")}`);

    lines.push("", `Spent today: ${fmtUsd(this.d.store.spentTodayUsd(limits.mode))} of ${fmtUsd(limits.maxDailyUsd)}`);
    return lines.join("\n");
  }

  async wallet(): Promise<{ text: string; addresses: Addresses | null }> {
    const signer = this.d.signer;
    if (!signer) return { text: "No wallets yet. Run `fren init` on the machine Fren runs on.", addresses: null };
    const a = await signer.addresses();
    const [usdc, hl] = await Promise.all([
      this.d.jupiter.usdcBalance().catch(() => null),
      this.d.hyperliquid.accountValueUsd().catch(() => null),
    ]);
    const net = this.d.isTestnet ? " (testnet)" : "";
    const text = [
      "Your Fren wallets. Only this machine holds the keys.",
      "",
      `Solana: ${a.solana}`,
      `  Send USDC (SPL) here for spot trades, plus about 0.05 SOL for fees.${usdc !== null ? ` Balance: ${fmtUsd(usdc)} USDC.` : ""}`,
      "",
      `EVM / Hyperliquid${net}: ${a.evm}`,
      `  Send USDC on Arbitrum here plus a little ETH for gas, then say "deposit $X to Hyperliquid". Or send USDC straight to this address on Hyperliquid.${hl !== null ? ` Hyperliquid account value: ${fmtUsd(hl)}.` : ""}`,
      "",
      `Trading key on Hyperliquid: ${a.hlAgent} (can trade, cannot withdraw).`,
    ].join("\n");
    return { text, addresses: a };
  }

  async depositToHyperliquid(amountUsd: number): Promise<string> {
    if (!this.d.signer) return "No wallets yet. Run `fren init` first.";
    if (this.limits().paused) return "Fren is stopped. Send /resume first.";
    const { txHash } = await this.d.signer.hlDepositFromArbitrum({ amountUsd, isTestnet: this.d.isTestnet });
    const explorer = this.d.isTestnet ? "https://sepolia.arbiscan.io/tx/" : "https://arbiscan.io/tx/";
    return `✅ Sent ${fmtUsd(amountUsd)} USDC from Arbitrum to your Hyperliquid account. It usually lands in about a minute. ${explorer}${txHash}`;
  }

  async searchMarkets(query: string): Promise<string> {
    const [perps, tokens] = await Promise.all([
      this.d.hyperliquid.markets.search(query).catch(() => []),
      this.d.jupiter.searchTokens(query).catch(() => []),
    ]);
    const lines: string[] = [];
    if (perps.length) {
      lines.push("Hyperliquid perps (use the exact symbol as `market`):");
      for (const m of perps) {
        lines.push(
          `• ${m.name}: ${fmtPrice(m.midPx)}, max ${m.maxLeverage}x, funding ${m.fundingHourlyPct.toFixed(4)}%/h, 24h volume ${fmtUsd(m.dayVolumeUsd)}`,
        );
      }
    }
    const top = tokens.slice(0, 5);
    if (top.length) {
      lines.push("Solana tokens via Jupiter (use the mint as `token`):");
      for (const t of top) {
        lines.push(`• ${t.symbol} (${t.name}) ${t.mint}${t.verified ? " ✔ verified" : " ⚠ unverified"}${t.usdPrice ? `, ${fmtPrice(t.usdPrice)}` : ""}`);
      }
    }
    return lines.length ? lines.join("\n") : `Nothing found for "${query}".`;
  }

  recentEvents(since: number) {
    return this.d.store.eventsSince(since);
  }
}

function pick(o: OwnerRequestResult) {
  return {
    ...(o.codeSentPrivately !== undefined ? { codeSentPrivately: o.codeSentPrivately } : {}),
    ...(o.ownerCode ? { ownerCode: o.ownerCode } : {}),
  };
}

export function describeLimits(l: Limits): string {
  return [
    `Mode: ${l.mode}${l.paused ? " (stopped)" : ""}`,
    `Per trade: ${fmtUsd(l.maxTradeUsd)} · Per day: ${fmtUsd(l.maxDailyUsd)}`,
    `Max leverage: ${l.maxLeverage}x · Max open positions: ${l.maxOpenPositions}`,
    `Auto-approve up to: ${fmtUsd(l.autoApproveUsd)}`,
    `Venues: ${l.allowedVenues.join(", ")}`,
  ].join("\n");
}

function describePosition(p: PositionView): string {
  const pnl = p.pnlUsd === null ? "" : `, PnL ${signedUsd(p.pnlUsd)}`;
  if (p.kind === "perp") {
    const liq = p.liquidationPx ? `, liq ${fmtPrice(p.liquidationPx)}` : "";
    return `${p.side} ${p.size} ${p.symbol} @ ${p.entryPx ? fmtPrice(p.entryPx) : "?"}${p.markPx ? ` (now ${fmtPrice(p.markPx)})` : ""}${pnl}${liq}`;
  }
  return `${p.size} ${p.symbol} worth ${fmtUsd(p.valueUsd)}${pnl}`;
}
