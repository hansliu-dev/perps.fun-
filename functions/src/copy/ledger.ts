import type { PositionSnap } from "./diff.js";

// Copy-trading inside one account. Hyperliquid holds one position per coin per account, so the ledger
// records which part of that position (in base units) was copied from which leader. Whatever isn't
// attributed to a leader is the user's own; only their own part is copied onward to their followers.
export interface AssetLots {
  side: "long" | "short";
  byLeader: Record<string, number>;
}

export type Ledger = Record<string, AssetLots>;

const EPS = 1e-9;

export function lotsTotal(lots: AssetLots | undefined): number {
  return lots ? Object.values(lots.byLeader).reduce((s, v) => s + v, 0) : 0;
}

// Clamps the ledger to what the account actually holds: lots disappear when the position closes or
// flips side, and shrink pro rata when the position is smaller than the lots (liquidation, TP/SL, manual close).
export function reconcile(ledger: Ledger, positions: Array<{ assetId: string; side: "long" | "short"; size: number }>): { ledger: Ledger; changed: boolean } {
  const out: Ledger = {};
  let changed = false;
  for (const [assetId, lots] of Object.entries(ledger)) {
    const pos = positions.find((p) => p.assetId === assetId);
    const total = lotsTotal(lots);
    if (!pos || pos.side !== lots.side || pos.size <= EPS || total <= EPS) {
      changed = true;
      continue;
    }
    if (total > pos.size + EPS) {
      const k = pos.size / total;
      out[assetId] = { side: lots.side, byLeader: Object.fromEntries(Object.entries(lots.byLeader).map(([l, v]) => [l, v * k])) };
      changed = true;
    } else {
      const byLeader = Object.fromEntries(Object.entries(lots.byLeader).filter(([, v]) => v > EPS));
      if (Object.keys(byLeader).length !== Object.keys(lots.byLeader).length) changed = true;
      if (Object.keys(byLeader).length) out[assetId] = { side: lots.side, byLeader };
    }
  }
  return { ledger: out, changed };
}

// The user's own part of each position: the position minus everything copied into it.
// Margin is split in proportion to size.
export function ownPositions(positions: PositionSnap[], ledger: Ledger): PositionSnap[] {
  const out: PositionSnap[] = [];
  for (const p of positions) {
    const lots = ledger[p.assetId];
    const copied = lots && lots.side === p.side ? Math.min(lotsTotal(lots), p.size) : 0;
    const own = p.size - copied;
    if (own <= EPS) continue;
    out.push({ ...p, size: own, marginUsd: p.size > 0 ? (p.marginUsd * own) / p.size : 0 });
  }
  return out;
}

export function addLot(ledger: Ledger, assetId: string, side: "long" | "short", leaderUid: string, size: number): Ledger {
  if (size <= EPS) return ledger;
  const cur = ledger[assetId];
  const byLeader = cur && cur.side === side ? { ...cur.byLeader } : {};
  byLeader[leaderUid] = (byLeader[leaderUid] ?? 0) + size;
  return { ...ledger, [assetId]: { side, byLeader } };
}

export function removeLot(ledger: Ledger, assetId: string, leaderUid: string, size: number | "all"): Ledger {
  const cur = ledger[assetId];
  if (!cur || !(leaderUid in cur.byLeader)) return ledger;
  const left = size === "all" ? 0 : Math.max(0, cur.byLeader[leaderUid] - size);
  const byLeader = { ...cur.byLeader };
  if (left <= EPS) delete byLeader[leaderUid];
  else byLeader[leaderUid] = left;
  const next = { ...ledger };
  if (Object.keys(byLeader).length) next[assetId] = { side: cur.side, byLeader };
  else delete next[assetId];
  return next;
}
