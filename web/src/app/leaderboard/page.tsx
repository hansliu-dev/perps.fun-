"use client";

import { collection, doc, getDocs, getFirestore, limit, onSnapshot, orderBy, query, where, type Query } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useApp } from "@/components/Providers";
import { firebaseApp, firebaseConfigured } from "@/lib/firebase";
import { formatPnl, useLivePnl } from "@/lib/useLivePnl";

interface Row {
  uid: string;
  handle: string;
  avatarUrl?: string;
  return24h: number;
  pnlUsd: number;
  equityUsd: number;
  openPositions: number;
  latestThesisId?: string;
}

const MEDALS = ["🥇", "🥈", "🥉"];

export default function LeaderboardPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    const app = firebaseApp();
    if (!app) return setRows([]);
    return onSnapshot(doc(getFirestore(app), "leaderboards", "live"), (d) => {
      setRows((d.data()?.rows as Row[]) ?? []);
      setUpdatedAt(d.data()?.updatedAt?.toDate?.() ?? null);
    });
  }, []);

  return (
    <div className="mx-auto grid w-full max-w-7xl flex-1 gap-6 overflow-y-auto px-4 py-6 lg:grid-cols-2">
      <section className="min-w-0">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold">Leaderboard · 24h</h1>
            <p className="text-sm text-muted">
              Ranked by 24h % return on equity, net of deposits.
            </p>
          </div>
          {updatedAt && <span className="text-xs text-muted">Updated {updatedAt.toLocaleTimeString()}</span>}
        </div>

        {!firebaseConfigured && <p className="rounded-md border border-line p-4 text-sm text-muted">Connect Firebase to load the leaderboard.</p>}
        {rows === null && <p className="text-sm text-muted">Loading…</p>}
        {rows?.length === 0 && firebaseConfigured && <p className="rounded-md border border-line p-4 text-sm text-muted">No ranked traders yet. Make a trade to get on the board.</p>}

        {!!rows?.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-xs text-muted">
                <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-normal">
                  <th>#</th>
                  <th>Trader</th>
                  <th className="!text-right">24h return</th>
                  <th className="!text-right">PnL</th>
                  <th className="!text-right">Equity</th>
                  <th className="!text-right">Open</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.uid} className="border-t border-line [&>td]:px-3 [&>td]:py-2.5">
                    <td className="w-10">{MEDALS[i] ?? i + 1}</td>
                    <td>
                      <Link href={`/u/${r.handle}`} className="flex items-center gap-2 hover:underline">
                        {r.avatarUrl ? <img src={r.avatarUrl} alt="" className="h-7 w-7 rounded-full" /> : <span className="h-7 w-7 rounded-full bg-sunken" />}
                        @{r.handle}
                      </Link>
                    </td>
                    <td className={`text-right font-semibold ${r.return24h >= 0 ? "text-long" : "text-short"}`}>
                      {r.return24h >= 0 ? "+" : ""}
                      {(r.return24h * 100).toFixed(2)}%
                    </td>
                    <td className={`text-right ${r.pnlUsd >= 0 ? "text-long" : "text-short"}`}>${r.pnlUsd.toFixed(2)}</td>
                    <td className="text-right">${r.equityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                    <td className="text-right">{r.openPositions}</td>
                    <td className="text-right">
                      {r.latestThesisId && (
                        <Link href={`/thesis/${r.latestThesisId}`} className="text-xs text-accent hover:underline">
                          Thesis
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Discover />
    </div>
  );
}

interface Person {
  uid: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  createdAt?: { toDate: () => Date };
}

const toPerson = (d: { id: string; data: () => Record<string, unknown> }) => ({ uid: d.id, ...d.data() }) as Person;

// Everyone on perps.fun: the 50 newest, or a prefix search on display name and @handle.
function Discover() {
  const { user } = useApp();
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [copying, setCopying] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const pnl = useLivePnl(people?.map((p) => p.uid) ?? []);

  useEffect(() => {
    const app = firebaseApp();
    if (!app || !user) return setCopying(new Set());
    const fq = query(collection(getFirestore(app), "follows"), where("followerUid", "==", user.uid), where("active", "==", true));
    return onSnapshot(fq, (snap) => setCopying(new Set(snap.docs.map((d) => d.get("leaderUid") as string))), () => {});
  }, [user]);

  useEffect(() => {
    const app = firebaseApp();
    if (!app) return setPeople([]);
    const db = getFirestore(app);
    const users = collection(db, "users");
    const term = q.trim().toLowerCase().replace(/^@/, "");
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        let found: Person[];
        if (!term) {
          found = (await getDocs(query(users, orderBy("createdAt", "desc"), limit(50)))).docs.map(toPerson);
        } else {
          const prefix = (field: string): Query => query(users, where(field, ">=", term), where(field, "<", term + "\uf8ff"), orderBy(field), limit(25));
          const [byName, byHandle] = await Promise.all([getDocs(prefix("displayNameLower")), getDocs(prefix("handle"))]);
          const seen = new Map<string, Person>();
          for (const d of [...byName.docs, ...byHandle.docs]) seen.set(d.id, toPerson(d));
          found = [...seen.values()].slice(0, 50);
        }
        if (!cancelled) {
          setPeople(found);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }, term ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <section className="min-w-0">
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Discover traders</h2>
        <p className="text-sm text-muted">{q.trim() ? "Matching names and @handles." : "The 50 newest people on perps.fun."}</p>
      </div>
      <input id="trader-search" className="input mb-3 w-full" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or @handle" autoComplete="off" />
      {error && <p className="text-sm text-short">{error}</p>}
      {people === null && !error && <p className="text-sm text-muted">Loading…</p>}
      {people?.length === 0 && <p className="rounded-md border border-line p-4 text-sm text-muted">{q.trim() ? `No one matches “${q.trim()}”.` : "No one has joined yet."}</p>}
      {!!people?.length && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
          {people.map((p) => {
            const name = p.displayName || `@${p.handle}`;
            const isMe = p.uid === user?.uid;
            const live = formatPnl(pnl[p.uid] ?? { pnlUsd: 0, pct: 0, openPositions: 0 });
            return (
              <li key={p.uid} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar url={p.avatarUrl} name={name} size={36} />
                <Link href={`/u/${p.handle}`} className="min-w-0 flex-1 hover:underline">
                  <div className="truncate text-sm font-medium">{name}</div>
                  <div className="truncate text-xs text-muted">
                    @{p.handle}
                    {p.createdAt && ` · joined ${p.createdAt.toDate().toLocaleDateString()}`}
                  </div>
                </Link>
                <div className={`w-24 shrink-0 text-right tabular-nums ${live.tone}`} title="Unrealized PnL on open positions, live">
                  <div className="text-sm font-semibold">{live.pct}</div>
                  <div className="text-xs">{live.usd}</div>
                </div>
                <div className="flex w-20 shrink-0 justify-end">
                  {isMe ? (
                    <span className="rounded-full bg-sunken px-2.5 py-1 text-xs text-muted">You</span>
                  ) : copying.has(p.uid) ? (
                    <Link href="/portfolio" className="rounded-full border border-accent/40 px-2.5 py-1 text-xs text-accent">
                      Copying
                    </Link>
                  ) : (
                    <Link href={`/u/${p.handle}`} className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                      Copy
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
