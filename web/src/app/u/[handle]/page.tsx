"use client";

import { collection, getDocs, getFirestore, limit, orderBy, query, where } from "firebase/firestore";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useApp } from "@/components/Providers";
import { RecentTrades } from "@/components/RecentTrades";
import { Spinner, useToast } from "@/components/Toasts";
import { AmountSlider, formatUsd } from "@/components/AmountSlider";
import { useAvailableUsdc } from "@/lib/useAvailableUsdc";
import { api } from "@/lib/api";
import { firebaseApp } from "@/lib/firebase";

interface Profile {
  uid: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

interface Thesis {
  id: string;
  symbol: string;
  imageUrl: string;
  caption?: string | null;
}

export default function ProfilePage() {
  const { handle } = useParams<{ handle: string }>();
  const { user, signIn } = useApp();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [theses, setTheses] = useState<Thesis[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);

  useEffect(() => {
    const app = firebaseApp();
    if (!app) return setError("Backend not configured.");
    const db = getFirestore(app);
    (async () => {
      const users = await getDocs(query(collection(db, "users"), where("handle", "==", handle), limit(1)));
      if (users.empty) return setError("Trader not found.");
      const p = { uid: users.docs[0].id, ...users.docs[0].data() } as Profile;
      setProfile(p);
      const th = await getDocs(query(collection(db, "theses"), where("uid", "==", p.uid), orderBy("ts", "desc"), limit(12)));
      setTheses(th.docs.map((d) => ({ id: d.id, ...d.data() }) as Thesis));
    })().catch((e) => setError(String(e)));
  }, [handle]);

  if (error) return <p className="p-6 text-sm text-muted">{error}</p>;
  if (!profile) return <p className="p-6 text-sm text-muted">Loading…</p>;

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 space-y-6 overflow-y-auto px-4 py-6">
      <div className="flex items-center gap-4">
        <Avatar url={profile.avatarUrl} name={profile.displayName || profile.handle} size={64} />
        <div>
          <h1 className="text-xl font-semibold">{profile.displayName || `@${profile.handle}`}</h1>
          <div className="text-sm text-muted">@{profile.handle}</div>
        </div>
        {user?.uid !== profile.uid && (
          <button onClick={() => (user ? setCopyOpen(true) : signIn())} className="ml-auto rounded-md bg-accent px-4 py-2 font-semibold text-white">
            Copy trades
          </button>
        )}
      </div>

      {theses.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Theses</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {theses.map((t) => (
              <Link key={t.id} href={`/thesis/${t.id}`} className="overflow-hidden rounded-lg border border-line hover:border-accent">
                <img src={t.imageUrl} alt={`${t.symbol} thesis`} className="aspect-video w-full object-cover" />
                <div className="px-2 py-1 text-xs">
                  <span className="text-muted">{t.symbol}-PERP</span>
                  {t.caption && <p className="mt-0.5 line-clamp-2 text-ink">{t.caption}</p>}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      <RecentTrades uid={profile.uid} />

      {copyOpen && <CopyDialog leader={profile} onClose={() => setCopyOpen(false)} />}
    </div>
  );
}

const MIN_BUDGET = 10;

function CopyDialog({ leader, onClose }: { leader: Profile; onClose: () => void }) {
  const { available } = useAvailableUsdc();
  const max = Math.floor((available ?? 0) * 100) / 100;
  const [budget, setBudget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const toast = useToast();
  // Start at half of what's available once the balance arrives.
  const value = budget ?? Math.max(MIN_BUDGET, Math.floor(max / 2));
  const enough = max >= MIN_BUDGET;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await toast.track(api.follow({ leaderUid: leader.uid, budgetUsd: value }), {
        loading: `Starting to copy @${leader.handle}…`,
        success: `Copying @${leader.handle}. Their next trade will be mirrored.`,
        error: `Couldn't copy @${leader.handle}`,
      });
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="toast-in w-full max-w-md space-y-5 rounded-xl border border-line bg-panel p-5 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Copy @{leader.handle}</h2>

        {available === null ? (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" /> Checking your balance…
          </p>
        ) : enough ? (
          <AmountSlider
            id="copy-budget"
            label="Copy budget"
            value={Math.min(value, max)}
            onChange={setBudget}
            min={MIN_BUDGET}
            max={max}
            caption={`of ${formatUsd(max)} available`}
          />
        ) : (
          <p className="rounded-lg bg-sunken p-3 text-xs text-muted">
            You need at least {formatUsd(MIN_BUDGET)} USDC to copy someone. You have {formatUsd(max)}.{" "}
            <Link href="/portfolio#deposit" className="text-accent hover:underline">
              Deposit
            </Link>
          </p>
        )}


        <div className="rounded-lg bg-sunken p-3 text-xs text-muted">
          <span className="font-medium text-ink">Proportional copying.</span> When they put 10% of their account into a trade, you put 10% of your budget in, at
          the same leverage. The budget stays in your account; no money moves when you start. You can close a copied position yourself at any time, and positions they already hold
          aren&apos;t copied.
        </div>
        {msg && <p className="text-xs text-short">{msg}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-2 text-muted hover:text-ink">
            Cancel
          </button>
          <button onClick={save} disabled={busy || !enough} className="rounded-md bg-accent px-4 py-2 font-semibold text-white disabled:opacity-50">
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Spinner /> Starting…
              </span>
            ) : (
              `Copy with ${formatUsd(enough ? Math.min(value, max) : 0)}`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
