"use client";

import { doc, getFirestore, onSnapshot } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { firebaseApp } from "./firebase";
import { useLivePrices } from "./usePerps";

// Open positions as the backend last saw them (snapshots/{uid}, refreshed after each trade and every minute).
interface SnapPosition {
  symbol: string;
  side: "long" | "short";
  size: number;
  marginUsd: number;
  entryPrice: number;
}

export interface LivePnl {
  pnlUsd: number;
  // Unrealized PnL as a share of the margin in open positions (return on margin). 0 with no positions.
  pct: number;
  openPositions: number;
}

const ZERO: LivePnl = { pnlUsd: 0, pct: 0, openPositions: 0 };

// Marks each person's open positions to the live price feed, so PnL moves tick by tick.
export function useLivePnl(uids: string[]): Record<string, LivePnl> {
  const [snaps, setSnaps] = useState<Record<string, SnapPosition[]>>({});
  const key = [...new Set(uids)].sort().join(",");

  useEffect(() => {
    const app = firebaseApp();
    if (!app || !key) return;
    const db = getFirestore(app);
    const offs = key.split(",").map((uid) =>
      onSnapshot(
        doc(db, "snapshots", uid),
        (d) => setSnaps((prev) => ({ ...prev, [uid]: (d.get("positions") as SnapPosition[] | undefined) ?? [] })),
        () => setSnaps((prev) => ({ ...prev, [uid]: [] })),
      ),
    );
    return () => offs.forEach((off) => off());
  }, [key]);

  const symbols = useMemo(() => [...new Set(Object.values(snaps).flatMap((ps) => ps.map((p) => p.symbol)))].sort(), [snaps]);
  const prices = useLivePrices(symbols);

  return useMemo(() => {
    const out: Record<string, LivePnl> = {};
    for (const uid of key ? key.split(",") : []) {
      const positions = snaps[uid] ?? [];
      let pnl = 0;
      let margin = 0;
      for (const p of positions) {
        const mark = Number(prices[p.symbol]?.price ?? p.entryPrice);
        pnl += (p.side === "long" ? 1 : -1) * (mark - p.entryPrice) * p.size;
        margin += p.marginUsd;
      }
      out[uid] = positions.length ? { pnlUsd: pnl, pct: margin > 0 ? pnl / margin : 0, openPositions: positions.length } : ZERO;
    }
    return out;
  }, [key, snaps, prices]);
}

export function formatPnl(v: LivePnl) {
  const sign = (n: number) => (n > 0.004 ? "+" : n < -0.004 ? "−" : "+");
  return {
    pct: `${sign(v.pct * 100)}${Math.abs(v.pct * 100).toFixed(2)}%`,
    usd: `${sign(v.pnlUsd)}$${Math.abs(v.pnlUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    tone: v.pnlUsd > 0.004 ? "text-long" : v.pnlUsd < -0.004 ? "text-short" : "text-muted",
  };
}
