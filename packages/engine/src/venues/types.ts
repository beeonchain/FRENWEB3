import type { PlanStep, ResolvedStep, Venue } from "@fren/core";
import type { Mode } from "../store.js";

export interface ExecContext {
  mode: Mode;
  planId: string | null;
  idx: number | null;
}

export interface ExecResult {
  /** One line for the chat reply: what happened, where, at what price. */
  text: string;
}

export interface PositionView {
  venue: Venue;
  symbol: string;
  kind: "perp" | "spot";
  side: "long" | "short" | "hold";
  size: number;
  entryPx: number | null;
  markPx: number | null;
  valueUsd: number;
  pnlUsd: number | null;
  liquidationPx?: number | null;
}

/** Every venue implements the same shape so the engine never branches on venue. */
export interface VenueAdapter {
  readonly venue: Venue;
  /** Look the market up and price the step. Throws a user-readable Error when it can't. */
  resolve(step: PlanStep, index: number): Promise<ResolvedStep>;
  execute(resolved: ResolvedStep, ctx: ExecContext): Promise<ExecResult>;
  positions(mode: Mode): Promise<PositionView[]>;
  /** Close every perp position (kill switch). Returns one line per close. */
  flatten(mode: Mode): Promise<string[]>;
}

export class VenueError extends Error {
  override name = "VenueError";
}
