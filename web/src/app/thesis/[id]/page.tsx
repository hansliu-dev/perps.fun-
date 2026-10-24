"use client";

import { doc, getDoc, getFirestore } from "firebase/firestore";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Chart, type ChartHandle } from "@/components/Chart";
import { PERIODS } from "@/lib/chart/dataLoader";
import { restoreDrawings, type SerializedOverlay } from "@/lib/chart/overlays";
import { firebaseApp } from "@/lib/firebase";
import { formatPrice } from "@/lib/markets";
import { profileName, useProfile } from "@/lib/profiles";

interface Thesis {
  uid: string;
  handle: string;
  avatarUrl?: string;
  symbol: string;
  period: string;
  imageUrl: string;
  caption?: string | null;
  overlays: SerializedOverlay[];
  position?: { side: "long" | "short"; leverage: number; entry_price: string; size: string } | null;
}

export default function ThesisPage() {
  const { id } = useParams<{ id: string }>();
  const [thesis, setThesis] = useState<Thesis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<ChartHandle | null>(null);
  const author = useProfile(thesis?.uid);

  useEffect(() => {
    const app = firebaseApp();
    if (!app) return setError("Backend not configured.");
    getDoc(doc(getFirestore(app), "theses", id))
      .then((d) => (d.exists() ? setThesis(d.data() as Thesis) : setError("Thesis not found.")))
      .catch((e) => setError(String(e)));
  }, [id]);

  if (error) return <p className="p-6 text-sm text-muted">{error}</p>;
  if (!thesis) return <p className="p-6 text-sm text-muted">Loading…</p>;

  const period = (PERIODS.find((p) => p.label === thesis.period) ?? PERIODS[3]).period;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2">
        <Avatar url={author?.avatarUrl ?? thesis.avatarUrl} name={profileName(author)} size={32} />
        <Link href={`/u/${author?.handle ?? thesis.handle}`} className="font-semibold hover:underline">
          {profileName(author) || `@${thesis.handle}`}
        </Link>
        <span className="text-muted">
          {thesis.symbol}-PERP · {thesis.period}
        </span>
        {thesis.position && (
          <span className={thesis.position.side === "long" ? "text-long" : "text-short"}>
            {thesis.position.side.toUpperCase()} {thesis.position.leverage}× @ {formatPrice(thesis.position.entry_price)}
          </span>
        )}
        <Link href={`/markets/${thesis.symbol}`} className="ml-auto rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white">
          Trade {thesis.symbol}
        </Link>
      </div>
      {thesis.caption && <p className="border-b border-line px-4 py-3 text-lg font-medium">{thesis.caption}</p>}
      <div className="min-h-0 flex-1">
        <Chart
          symbol={thesis.symbol}
          period={period}
          showVolume={false}
          onReady={(h) => {
            handle.current = h;
            restoreDrawings(h.chart, thesis.overlays);
          }}
        />
      </div>
    </div>
  );
}
