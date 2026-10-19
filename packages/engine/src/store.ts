import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_LIMITS, Limits, type Plan, type ResolvedStep } from "@jarvis/core";

/**
 * Single-file local state (SQLite), so a user's whole setup is one folder they
 * can copy between a laptop and a VPS.
 */

export type PlanStatus = "pending_confirm" | "active" | "done" | "rejected" | "cancelled";
export type StepStatus = "waiting" | "pending" | "filled" | "failed" | "cancelled" | "expired" | "rejected";
export type Mode = "paper" | "live";

export interface PlanRecord {
  id: string;
  createdAt: string;
  request: string;
  plan: Plan;
  status: PlanStatus;
  mode: Mode;
}

export interface StepRecord {
  planId: string;
  idx: number;
  status: StepStatus;
  resolved: ResolvedStep | null;
  result: string | null;
  updatedAt: string;
}

export interface FillRecord {
  planId: string | null;
  idx: number | null;
  venue: string;
  symbol: string;
  action: string;
  size: number;
  price: number;
  usd: number;
  spendUsd: number;
  mode: Mode;
  at?: string;
  ref?: string | null;
}

export interface PaperPosition {
  symbol: string;
  side: "long" | "short";
  size: number;
  entry: number;
  margin: number;
  leverage: number;
  stopPrice: number | null;
  takeProfitPrice: number | null;
}

export interface PaperHolding {
  mint: string;
  symbol: string;
  amount: number;
  costUsd: number;
}

export type PendingKind = "plan" | "limits" | "resume";

export interface PendingAction {
  code: string;
  kind: PendingKind;
  payload: string;
  expiresAt: string;
}

const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, paperStartingUsd = 10_000) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, request TEXT NOT NULL,
        plan_json TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        plan_id TEXT NOT NULL, idx INTEGER NOT NULL, status TEXT NOT NULL,
        resolved_json TEXT, result TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (plan_id, idx)
      );
      CREATE TABLE IF NOT EXISTS fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT, idx INTEGER, venue TEXT NOT NULL,
        symbol TEXT NOT NULL, action TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL,
        usd REAL NOT NULL, spend_usd REAL NOT NULL, mode TEXT NOT NULL, at TEXT NOT NULL, ref TEXT
      );
      CREATE TABLE IF NOT EXISTS paper_positions (
        symbol TEXT PRIMARY KEY, side TEXT NOT NULL, size REAL NOT NULL, entry REAL NOT NULL,
        margin REAL NOT NULL, leverage INTEGER NOT NULL, stop_price REAL, tp_price REAL
      );
      CREATE TABLE IF NOT EXISTS paper_holdings (
        mint TEXT PRIMARY KEY, symbol TEXT NOT NULL, amount REAL NOT NULL, cost_usd REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending (
        code TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL
      );
    `);
    if (this.getKv("paper_usdc") === null) this.setKv("paper_usdc", String(paperStartingUsd));
  }

  // -- kv ------------------------------------------------------------------

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setKv(key: string, value: string) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getLimits(): Limits {
    const raw = this.getKv("limits");
    return raw ? Limits.parse(JSON.parse(raw)) : DEFAULT_LIMITS;
  }

  setLimits(limits: Limits) {
    this.setKv("limits", JSON.stringify(Limits.parse(limits)));
  }

  // -- plans ---------------------------------------------------------------

  insertPlan(rec: Omit<PlanRecord, "createdAt">, resolved: ResolvedStep[], stepStatus: (i: number) => StepStatus) {
    const at = now();
    this.db
      .prepare("INSERT INTO plans (id, created_at, request, plan_json, status, mode) VALUES (?, ?, ?, ?, ?, ?)")
      .run(rec.id, at, rec.request, JSON.stringify(rec.plan), rec.status, rec.mode);
    const ins = this.db.prepare(
      "INSERT INTO steps (plan_id, idx, status, resolved_json, result, updated_at) VALUES (?, ?, ?, ?, NULL, ?)",
    );
    rec.plan.steps.forEach((_, i) => {
      const r = resolved.find((x) => x.index === i) ?? null;
      ins.run(rec.id, i, stepStatus(i), r ? JSON.stringify(r) : null, at);
    });
  }

  getPlan(id: string): PlanRecord | null {
    const row = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Record<string, string> | undefined;
    return row ? toPlan(row) : null;
  }

  setPlanStatus(id: string, status: PlanStatus) {
    this.db.prepare("UPDATE plans SET status = ? WHERE id = ?").run(status, id);
  }

  plansWithStatus(status: PlanStatus): PlanRecord[] {
    return (this.db.prepare("SELECT * FROM plans WHERE status = ? ORDER BY created_at").all(status) as Record<string, string>[]).map(toPlan);
  }

  getSteps(planId: string): StepRecord[] {
    return (this.db.prepare("SELECT * FROM steps WHERE plan_id = ? ORDER BY idx").all(planId) as Record<string, unknown>[]).map(toStep);
  }

  setStep(planId: string, idx: number, status: StepStatus, result?: string, resolved?: ResolvedStep) {
    this.db
      .prepare(
        "UPDATE steps SET status = ?, result = COALESCE(?, result), resolved_json = COALESCE(?, resolved_json), updated_at = ? WHERE plan_id = ? AND idx = ?",
      )
      .run(status, result ?? null, resolved ? JSON.stringify(resolved) : null, now(), planId, idx);
  }

  /** Mark a plan done once none of its steps are still waiting or pending. */
  settlePlan(planId: string) {
    const open = this.getSteps(planId).some((s) => s.status === "waiting" || s.status === "pending");
    if (!open) this.setPlanStatus(planId, "done");
  }

  // -- fills & spend -------------------------------------------------------

  insertFill(f: FillRecord) {
    this.db
      .prepare(
        "INSERT INTO fills (plan_id, idx, venue, symbol, action, size, price, usd, spend_usd, mode, at, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(f.planId, f.idx, f.venue, f.symbol, f.action, f.size, f.price, f.usd, f.spendUsd, f.mode, f.at ?? now(), f.ref ?? null);
  }

  recentFills(limit = 10): FillRecord[] {
    return (this.db.prepare("SELECT * FROM fills ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
      planId: r.plan_id as string | null,
      idx: r.idx as number | null,
      venue: r.venue as string,
      symbol: r.symbol as string,
      action: r.action as string,
      size: r.size as number,
      price: r.price as number,
      usd: r.usd as number,
      spendUsd: r.spend_usd as number,
      mode: r.mode as Mode,
      at: r.at as string,
      ref: r.ref as string | null,
    }));
  }

  spentTodayUsd(mode: Mode, at = new Date()): number {
    const midnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
    const row = this.db
      .prepare("SELECT COALESCE(SUM(spend_usd), 0) AS s FROM fills WHERE at >= ? AND mode = ?")
      .get(midnight, mode) as { s: number };
    return row.s;
  }

  // -- paper ledger --------------------------------------------------------

  paperUsdc(): number {
    return Number(this.getKv("paper_usdc") ?? 0);
  }

  setPaperUsdc(v: number) {
    this.setKv("paper_usdc", String(v));
  }

  paperPositions(): PaperPosition[] {
    return (this.db.prepare("SELECT * FROM paper_positions").all() as Record<string, unknown>[]).map((r) => ({
      symbol: r.symbol as string,
      side: r.side as "long" | "short",
      size: r.size as number,
      entry: r.entry as number,
      margin: r.margin as number,
      leverage: r.leverage as number,
      stopPrice: r.stop_price as number | null,
      takeProfitPrice: r.tp_price as number | null,
    }));
  }

  paperPosition(symbol: string): PaperPosition | null {
    return this.paperPositions().find((p) => p.symbol === symbol) ?? null;
  }

  upsertPaperPosition(p: PaperPosition) {
    this.db
      .prepare(
        `INSERT INTO paper_positions (symbol, side, size, entry, margin, leverage, stop_price, tp_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET side = excluded.side, size = excluded.size, entry = excluded.entry, margin = excluded.margin,
         leverage = excluded.leverage, stop_price = excluded.stop_price, tp_price = excluded.tp_price`,
      )
      .run(p.symbol, p.side, p.size, p.entry, p.margin, p.leverage, p.stopPrice, p.takeProfitPrice);
  }

  deletePaperPosition(symbol: string) {
    this.db.prepare("DELETE FROM paper_positions WHERE symbol = ?").run(symbol);
  }

  paperHoldings(): PaperHolding[] {
    return (this.db.prepare("SELECT * FROM paper_holdings WHERE amount > 0").all() as Record<string, unknown>[]).map((r) => ({
      mint: r.mint as string,
      symbol: r.symbol as string,
      amount: r.amount as number,
      costUsd: r.cost_usd as number,
    }));
  }

  paperHolding(mint: string): PaperHolding | null {
    return this.paperHoldings().find((h) => h.mint === mint) ?? null;
  }

  setPaperHolding(h: PaperHolding) {
    this.db
      .prepare(
        "INSERT INTO paper_holdings (mint, symbol, amount, cost_usd) VALUES (?, ?, ?, ?) ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, amount = excluded.amount, cost_usd = excluded.cost_usd",
      )
      .run(h.mint, h.symbol, h.amount, h.costUsd);
  }

  // -- pending owner approvals -------------------------------------------

  putPending(p: PendingAction) {
    this.db.prepare("INSERT INTO pending (code, kind, payload, expires_at) VALUES (?, ?, ?, ?)").run(p.code, p.kind, p.payload, p.expiresAt);
  }

  takePending(code: string, at = new Date()): PendingAction | null {
    const row = this.db.prepare("SELECT * FROM pending WHERE code = ?").get(code) as Record<string, string> | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM pending WHERE code = ?").run(code);
    if (new Date(row.expires_at!).getTime() < at.getTime()) return null;
    return { code: row.code!, kind: row.kind as PendingKind, payload: row.payload!, expiresAt: row.expires_at! };
  }

  dropPendingForPlan(planId: string) {
    this.db.prepare("DELETE FROM pending WHERE kind = 'plan' AND payload = ?").run(planId);
  }

  // -- events --------------------------------------------------------------

  addEvent(text: string): number {
    const r = this.db.prepare("INSERT INTO events (at, text) VALUES (?, ?)").run(now(), text);
    return Number(r.lastInsertRowid);
  }

  eventsSince(id: number): { id: number; at: string; text: string }[] {
    return this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id").all(id) as { id: number; at: string; text: string }[];
  }

  close() {
    this.db.close();
  }
}

function toPlan(row: Record<string, string>): PlanRecord {
  return {
    id: row.id!,
    createdAt: row.created_at!,
    request: row.request!,
    plan: JSON.parse(row.plan_json!) as Plan,
    status: row.status as PlanStatus,
    mode: row.mode as Mode,
  };
}

function toStep(row: Record<string, unknown>): StepRecord {
  return {
    planId: row.plan_id as string,
    idx: row.idx as number,
    status: row.status as StepStatus,
    resolved: row.resolved_json ? (JSON.parse(row.resolved_json as string) as ResolvedStep) : null,
    result: (row.result as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}
