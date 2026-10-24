import type { CreateOrderRequest, TmPosition } from "../tm/client.js";
import type { LeaderEvent } from "./diff.js";
import { clampLeverage, sizeCopyIncrease, sizeCopyOpen, sizeMargin, type FollowerAccount, type FollowSettings } from "./sizing.js";

export interface AssetInfo {
  id: string;
  sizeDecimals: number;
  maxLeverage: number;
}

export type CopyPlan = { order: CreateOrderRequest; note: string } | { skip: string };

// Rounds down so a partial close never exceeds the position.
export function floorSize(size: number, decimals: number): string {
  const f = 10 ** decimals;
  return (Math.floor(size * f + 1e-9) / f).toFixed(decimals);
}

const closingSide = (side: "long" | "short") => (side === "long" ? "sell" : "buy");

// One leader event → at most one order in the follower's copy account for that leader.
// The copy account holds only this leader's copies, so "close" can safely close the whole position.
export function planCopy(event: LeaderEvent, settings: FollowSettings, account: FollowerAccount, position: TmPosition | undefined, asset: AssetInfo): CopyPlan {
  switch (event.type) {
    case "open": {
      if (position) return { skip: "copy account already holds this asset" };
      const s = sizeCopyOpen(event.marginPct, event.leverage, account, settings, asset.maxLeverage);
      if (s.skip) return { skip: s.reason };
      return {
        order: { asset_id: asset.id, side: event.side === "long" ? "buy" : "sell", type: "market", qty: s.marginUsd.toFixed(2), qty_unit: "quote", leverage: s.leverage },
        note: `open ${event.side} $${s.marginUsd} @ ${s.leverage}x`,
      };
    }
    case "increase": {
      if (!position || position.side !== event.side) return { skip: "no matching copied position to add to" };
      const leverage = clampLeverage(event.leverage, settings, asset.maxLeverage);
      const s = sizeCopyIncrease(event.marginGrowth, Number(position.margin_used), leverage, account);
      if (s.skip) return { skip: s.reason };
      return {
        order: { asset_id: asset.id, side: event.side === "long" ? "buy" : "sell", type: "market", qty: s.marginUsd.toFixed(2), qty_unit: "quote", leverage: s.leverage },
        note: `add $${s.marginUsd} (+${(event.marginGrowth * 100).toFixed(1)}%)`,
      };
    }
    case "reduce":
    case "close": {
      if (!position || position.side !== event.side) return { skip: "no copied position to close" };
      const size = Number(position.size);
      const fraction = event.type === "close" ? 1 : Math.min(1, event.fraction);
      const qty = fraction >= 0.999 ? position.size : floorSize(size * fraction, asset.sizeDecimals);
      if (!(Number(qty) > 0)) return { skip: "reduction rounds to zero" };
      return {
        order: { asset_id: asset.id, side: closingSide(position.side), type: "market", qty, qty_unit: "base", reduce_only: true },
        note: event.type === "close" ? "close 100%" : `reduce ${(fraction * 100).toFixed(1)}%`,
      };
    }
  }
}

// ---- Single-account copying (see ledger.ts) ----

export interface LedgerCopyContext {
  budgetUsd: number;
  settings: FollowSettings;
  availableUsd: number;
  // The follower's whole position in this asset, and the part of it copied from this leader (base units).
  position: TmPosition | undefined;
  lot: number;
  asset: AssetInfo;
}

export type LedgerPlan =
  | { skip: string }
  | { order: CreateOrderRequest; note: string; effect: "add" }
  | { order: CreateOrderRequest; note: string; effect: "remove"; size: number | "all" };

const EPS = 1e-9;

export function planLedgerCopy(event: LeaderEvent, ctx: LedgerCopyContext): LedgerPlan {
  const { position, lot, asset } = ctx;
  switch (event.type) {
    case "open": {
      if (position && position.side !== event.side) return { skip: `you hold an opposite ${event.symbol} position` };
      // One leverage per coin per account: join an existing position at its leverage, keeping the notional the leader intended.
      const target = clampLeverage(event.leverage, ctx.settings, asset.maxLeverage);
      const leverage = position ? position.leverage : target;
      const s = sizeMargin((event.marginPct * ctx.budgetUsd * target) / leverage, leverage, ctx.availableUsd);
      if (s.skip) return { skip: s.reason };
      return {
        order: { asset_id: asset.id, side: event.side === "long" ? "buy" : "sell", type: "market", qty: s.marginUsd.toFixed(2), qty_unit: "quote", leverage },
        note: `open ${event.side} $${s.marginUsd} @ ${leverage}x`,
        effect: "add",
      };
    }
    case "increase": {
      if (!position || position.side !== event.side || lot <= EPS) return { skip: "no copied position to add to" };
      const lotMargin = (lot / Number(position.size)) * Number(position.margin_used);
      const s = sizeMargin(event.marginGrowth * lotMargin, position.leverage, ctx.availableUsd);
      if (s.skip) return { skip: s.reason };
      return {
        order: { asset_id: asset.id, side: event.side === "long" ? "buy" : "sell", type: "market", qty: s.marginUsd.toFixed(2), qty_unit: "quote", leverage: position.leverage },
        note: `add $${s.marginUsd} (+${(event.marginGrowth * 100).toFixed(1)}%)`,
        effect: "add",
      };
    }
    case "reduce":
    case "close": {
      if (!position || position.side !== event.side || lot <= EPS) return { skip: "nothing copied from them in this market" };
      const want = event.type === "close" ? lot : lot * Math.min(1, event.fraction);
      const whole = want >= Number(position.size) - EPS;
      const qty = whole ? position.size : floorSize(want, asset.sizeDecimals);
      if (!(Number(qty) > 0)) return { skip: "reduction rounds to zero" };
      return {
        order: { asset_id: asset.id, side: closingSide(position.side), type: "market", qty, qty_unit: "base", reduce_only: true },
        note: event.type === "close" ? "close their share" : `reduce their share ${(Math.min(1, event.fraction) * 100).toFixed(1)}%`,
        effect: "remove",
        size: event.type === "close" ? "all" : Number(qty),
      };
    }
  }
}
