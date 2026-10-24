"use client";

import { collection, getFirestore, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { useEffect, useState } from "react";
import { firebaseApp } from "./firebase";

// Theses posted on one market, newest first. Each becomes the author's avatar on that market's chart.
export interface ThesisMarker {
  id: string;
  uid: string;
  ts: number;
  price: number | null;
  imageUrl: string;
  caption: string | null;
  position: { side: "long" | "short"; leverage: number; entry_price: string } | null;
}

export function useThesisMarkers(symbol: string, max = 50): ThesisMarker[] {
  const [markers, setMarkers] = useState<ThesisMarker[]>([]);
  useEffect(() => {
    const app = firebaseApp();
    setMarkers([]);
    if (!app) return;
    const q = query(collection(getFirestore(app), "theses"), where("symbol", "==", symbol), orderBy("ts", "desc"), limit(max));
    return onSnapshot(
      q,
      (snap) =>
        setMarkers(
          snap.docs
            .map((d) => {
              const t = d.data();
              return { id: d.id, uid: t.uid, ts: t.ts?.toMillis?.() ?? Date.now(), price: typeof t.price === "number" ? t.price : null, imageUrl: t.imageUrl, caption: t.caption ?? null, position: t.position ?? null };
            })
            .filter((m) => m.uid && m.imageUrl),
        ),
      (err) => {
        console.error("thesis markers:", err.message);
        setMarkers([]);
      },
    );
  }, [symbol, max]);
  return markers;
}
