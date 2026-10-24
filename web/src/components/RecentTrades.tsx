"use client";

import { collection, getFirestore, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { firebaseApp } from "@/lib/firebase";
import { formatPrice } from "@/lib/markets";
import { useProfiles } from "@/lib/profiles";

type Action = "open" | "increase" | "reduce" | "close";

// A trade row: a change to someone's own position (trades/), or a copy placed for them (copyExecutions/).
interface TradeRow {
  id: string;
  ts: number;
  action: Action;
  side: "long" | "short";
  symbol: string;
  leverage: number | null;
  size: string;
  fillPrice: number | null;
  thesisId?: string;
  copiedFrom?: string; // leader uid
  failed?: string;
  skipped?: string;
}

const ACTION_LABEL: Record<Action, string> = { open: "Opened", increase: "Added to", reduce: "Trimmed", close: "Closed" };
const MAX_ROWS = 30;

function sizeText(marginPct: number | null | undefined, fraction: number | null | undefined) {
  if (marginPct) return `${(marginPct * 100).toFixed(1)}% of account`;
  if (fraction) return `${(fraction * 100).toFixed(0)}% of position`;
  return "";
}

// Live list of a user's recent trades. With `includeCopies`, also the trades copied for them (visible only to themselves).
export function RecentTrades({ uid, includeCopies = false, title = "Recent trades" }: { uid: string; includeCopies?: boolean; title?: string }) {
  const [own, setOwn] = useState<TradeRow[]>([]);
  const [copies, setCopies] = useState<TradeRow[]>([]);

  useEffect(() => {
    const app = firebaseApp();
    if (!app) return;
    const q = query(collection(getFirestore(app), "trades"), where("uid", "==", uid), orderBy("ts", "desc"), limit(MAX_ROWS));
    return onSnapshot(
      q,
      (snap) =>
        setOwn(
          snap.docs.map((d) => {
            const t = d.data();
            return {
              id: d.id,
              ts: t.ts?.toMillis?.() ?? Date.now(),
              action: t.action,
              side: t.side,
              symbol: t.symbol,
              leverage: t.leverage ?? null,
              size: sizeText(t.marginPct, t.fraction),
              fillPrice: t.fillPrice ?? null,
              thesisId: t.thesisId,
            };
          }),
        ),
      () => setOwn([]),
    );
  }, [uid]);

  useEffect(() => {
    const app = firebaseApp();
    if (!app || !includeCopies) return setCopies([]);
    const q = query(collection(getFirestore(app), "copyExecutions"), where("followerUid", "==", uid), orderBy("ts", "desc"), limit(MAX_ROWS));
    return onSnapshot(
      q,
      (snap) =>
        setCopies(
          snap.docs.map((d) => {
              const c = d.data();
              const e = c.event ?? {};
              return {
                id: d.id,
                ts: c.ts?.toMillis?.() ?? Date.now(),
                action: e.type,
                side: e.side,
                symbol: e.symbol,
                leverage: e.leverage ?? null,
                size: sizeText(e.marginPct, e.fraction),
                fillPrice: null,
                copiedFrom: c.leaderUid,
                failed: c.status === "failed" ? c.note : undefined,
                skipped: c.status === "skipped" ? c.note : undefined,
              };
          }),
        ),
      () => setCopies([]),
    );
  }, [uid, includeCopies]);

  const rows = useMemo(() => [...own, ...copies].sort((a, b) => b.ts - a.ts).slice(0, MAX_ROWS), [own, copies]);
  const leaders = useProfiles(copies.map((c) => c.copiedFrom!).filter(Boolean));

  return (
    <section className="rounded-lg border border-line">
      <h2 className="border-b border-line px-3 py-2 text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted">No trades yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <tbody>
              {rows.map((t) => {
                const leader = t.copiedFrom ? leaders[t.copiedFrom] : undefined;
                return (
                  <tr key={t.id} className="border-t border-line first:border-0 [&>td]:px-3 [&>td]:py-2">
                    <td className="whitespace-nowrap text-muted">{new Date(t.ts).toLocaleString()}</td>
                    <td className={t.failed ? "text-muted line-through" : t.skipped ? "text-muted" : t.action === "open" || t.action === "increase" ? "text-long" : "text-short"}>
                      {ACTION_LABEL[t.action] ?? t.action} {t.side} {t.symbol}
                    </td>
                    <td>
                      {t.copiedFrom && (
                        <Link href={leader ? `/u/${leader.handle}` : "#"} className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:underline">
                          Copied from @{leader?.handle ?? "…"}
                        </Link>
                      )}
                    </td>
                    <td>{t.leverage ? `${t.leverage}×` : ""}</td>
                    <td className="text-muted">
                      {t.failed ? <span className="text-short">Didn&apos;t go through: {t.failed}</span> : t.skipped ? <span>Not copied: {t.skipped}</span> : t.size}
                    </td>
                    <td>{t.fillPrice ? `@ ${formatPrice(t.fillPrice)}` : ""}</td>
                    <td className="text-right">
                      {t.thesisId && (
                        <Link href={`/thesis/${t.thesisId}`} className="text-accent hover:underline">
                          Thesis
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
