// Turns two snapshots of a leader's positions into copyable events. Every change is caught the same way,
// whether it came from an order in our app, a TP/SL trigger, or a liquidation.
export interface PositionSnap {
  assetId: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  marginUsd: number;
  leverage: number;
  entryPrice: number;
}

export type LeaderEvent =
  | { type: "open"; assetId: string; symbol: string; side: "long" | "short"; leverage: number; marginPct: number; entryPrice: number }
  | { type: "increase"; assetId: string; symbol: string; side: "long" | "short"; leverage: number; marginGrowth: number }
  | { type: "reduce"; assetId: string; symbol: string; side: "long" | "short"; fraction: number }
  | { type: "close"; assetId: string; symbol: string; side: "long" | "short" };

// Ignore float noise in reported sizes.
const EPS = 1e-9;

export function diffPositions(prev: PositionSnap[], next: PositionSnap[], leaderEquityUsd: number): LeaderEvent[] {
  const before = new Map(prev.map((p) => [p.assetId, p]));
  const after = new Map(next.map((p) => [p.assetId, p]));
  const events: LeaderEvent[] = [];

  for (const assetId of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(assetId);
    const b = after.get(assetId);

    if (a && (!b || b.side !== a.side)) events.push({ type: "close", assetId, symbol: a.symbol, side: a.side });

    if (b && (!a || b.side !== a.side)) {
      events.push({
        type: "open",
        assetId,
        symbol: b.symbol,
        side: b.side,
        leverage: b.leverage,
        marginPct: leaderEquityUsd > 0 ? b.marginUsd / leaderEquityUsd : 0,
        entryPrice: b.entryPrice,
      });
      continue;
    }

    if (!a || !b) continue;
    if (b.size > a.size + EPS) {
      events.push({ type: "increase", assetId, symbol: b.symbol, side: b.side, leverage: b.leverage, marginGrowth: a.marginUsd > 0 ? (b.marginUsd - a.marginUsd) / a.marginUsd : 0 });
    } else if (b.size < a.size - EPS) {
      events.push({ type: "reduce", assetId, symbol: b.symbol, side: b.side, fraction: 1 - b.size / a.size });
    }
  }
  return events;
}
