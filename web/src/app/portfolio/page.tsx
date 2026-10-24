"use client";

import { collection, getFirestore, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Positions, pnlTone, signedUsd, useLiveUnrealized, usePortfolio } from "@/components/Positions";
import { useApp } from "@/components/Providers";
import { RecentTrades } from "@/components/RecentTrades";
import { Spinner, useToast } from "@/components/Toasts";
import { AmountSlider } from "@/components/AmountSlider";
import { api, type Wallet } from "@/lib/api";
import { firebaseApp } from "@/lib/firebase";

// One row per leader the user copies; each has its own TrueMarkets copy account.
interface FollowRow {
  id: string;
  leaderUid: string;
  leaderHandle: string;
  leaderAvatarUrl?: string;
  budgetUsd: number;
  equityUsd?: number;
  openPositions?: number;
}

interface WithdrawalRow {
  id: string;
  amount: number;
  chain: string;
  to: string;
  status: string;
  explorerUrl?: string | null;
  createdAt?: { toDate: () => Date };
}

const CHAIN_LABEL: Record<string, string> = {
  "hypercore-perp": "Hyperliquid (perps)",
  "hypercore-spot": "Hyperliquid (spot)",
  arbitrum: "Arbitrum",
  base: "Base",
  solana: "Solana",
  robinhood: "Robinhood Chain",
};
const chainLabel = (c: string) => CHAIN_LABEL[c] ?? c;
const usd = (v?: string | number) => (v === undefined ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export default function PortfolioPage() {
  const { user, account, signIn } = useApp();
  const toast = useToast();
  const { portfolio, error, reload } = usePortfolio();
  const pnl = useLiveUnrealized(portfolio);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [follows, setFollows] = useState<FollowRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const loadWallet = useCallback(async () => {
    try {
      setWallet(await api.getWallet());
      setWalletError(null);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (account.status !== "ready") return;
    loadWallet();
    const id = setInterval(loadWallet, 15_000);
    return () => clearInterval(id);
  }, [account.status, loadWallet]);

  useEffect(() => {
    const app = firebaseApp();
    if (!app || !user) return;
    const q = query(collection(getFirestore(app), "follows"), where("followerUid", "==", user.uid), where("active", "==", true));
    return onSnapshot(q, (snap) => setFollows(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as FollowRow)));
  }, [user]);

  async function stopCopying(f: FollowRow) {
    if (!confirm(`Stop copying @${f.leaderHandle}? What you copied from them is closed; your own positions aren't touched.`)) return;
    setBusy(f.id);
    setMsg(null);
    try {
      await toast.track(api.unfollow({ leaderUid: f.leaderUid, closePositions: true }), {
        loading: `Stopping copying @${f.leaderHandle} and closing their copied positions…`,
        success: `Stopped copying @${f.leaderHandle}`,
        error: `Couldn't stop copying @${f.leaderHandle}`,
      });
      await Promise.all([reload(), loadWallet()]);
    } catch {
      // The popup shows why.
    } finally {
      setBusy(null);
    }
  }

  if (!user)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-muted">Sign in to see your portfolio.</p>
        <button onClick={signIn} className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white">
          Sign in with Google
        </button>
      </div>
    );

  // Main account plus everything held in copy accounts.
  // USDC on any network is usable: TrueMarkets routes it into Hyperliquid margin when you trade.
  const available = wallet?.balances.reduce((s, b) => s + Number(b.available), 0);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 space-y-6 overflow-y-auto px-4 py-6">
      <h1 className="text-xl font-semibold">Portfolio</h1>
      {(error || msg) && <p className="text-sm text-short">{error ?? msg}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Card label="Available USDC" value={available === undefined ? "—" : usd(available)} />
        <Card label="Unrealized PnL" value={pnl === null ? "—" : signedUsd(pnl)} tone={pnl === null ? undefined : pnlTone(pnl)} />
      </div>

      <section className="rounded-lg border border-line">
        <h2 className="border-b border-line px-3 py-2 text-sm font-medium">Your positions</h2>
        <Positions />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <DepositPanel wallet={wallet} error={walletError} />
        <WithdrawPanel wallet={wallet} onDone={() => Promise.all([reload(), loadWallet()]).then(() => {})} />
      </div>

      <RecentTrades uid={user.uid} includeCopies title="Your recent trades" />

      <WithdrawalHistory uid={user.uid} />

      <section className="rounded-lg border border-line">
        <h2 className="border-b border-line px-3 py-2 text-sm font-medium">Copying</h2>
        {follows.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">
            You aren&apos;t copying anyone yet. Find a trader on the{" "}
            <Link href="/leaderboard" className="text-accent hover:underline">
              leaderboard
            </Link>
            .
          </p>
        ) : (
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-normal">
                <th>Trader</th>
                <th>Budget</th>
                <th>Copy equity</th>
                <th>Open</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {follows.map((f) => {
                const fp = f.equityUsd !== undefined ? f.equityUsd - f.budgetUsd : undefined;
                return (
                  <tr key={f.id} className="border-t border-line [&>td]:px-3 [&>td]:py-2">
                    <td>
                      <Link href={`/u/${f.leaderHandle}`} className="flex items-center gap-2 hover:underline">
                        {f.leaderAvatarUrl ? <img src={f.leaderAvatarUrl} alt="" className="h-6 w-6 rounded-full" /> : <span className="h-6 w-6 rounded-full bg-sunken" />}@{f.leaderHandle}
                      </Link>
                    </td>
                    <td>{usd(f.budgetUsd)}</td>
                    <td>
                      {usd(f.equityUsd)}{" "}
                      {fp !== undefined && (
                        <span className={fp >= 0 ? "text-long" : "text-short"}>
                          ({fp >= 0 ? "+" : "−"}
                          {Math.abs(fp).toFixed(2)})
                        </span>
                      )}
                    </td>
                    <td>{f.openPositions ?? 0}</td>
                    <td className="text-right">
                      <button disabled={busy === f.id} onClick={() => stopCopying(f)} className="inline-flex items-center gap-1.5 rounded bg-sunken px-2 py-1 hover:bg-line disabled:opacity-50">
                        {busy === f.id && <Spinner className="h-3 w-3" />}
                        {busy === f.id ? "Stopping…" : "Stop copying"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function DepositPanel({ wallet, error }: { wallet: Wallet | null; error: string | null }) {
  const evm = wallet?.wallets.find((w) => w.chain_family === "evm")?.address;
  const sol = wallet?.wallets.find((w) => w.chain_family === "solana")?.address;
  return (
    <section id="deposit" className="space-y-3 rounded-lg border border-line p-4 text-sm">
      <h2 className="font-medium">Deposit USDC</h2>
      {error && <p className="text-xs text-short">{error}</p>}
      {!wallet && !error && <p className="text-xs text-muted">Loading your addresses…</p>}
      {evm && (
        <div className="space-y-2">
          <Address label="Your address on Arbitrum, Base and Hyperliquid" value={evm} />
          <p className="text-xs text-muted">USDC on any of these networks, or on Solana below, can be traded right away. It&apos;s moved into Hyperliquid automatically when you open a position.</p>
        </div>
      )}
      {sol && <Address label="Your Solana address (USDC on Solana only)" value={sol} />}
      <p className="text-xs text-short">Only send USDC, and only on the network named. Funds sent on another network can be lost.</p>
      {wallet && (
        <table className="w-full text-xs tabular-nums">
          <tbody>
            {wallet.balances.length === 0 && (
              <tr>
                <td className="py-1 text-muted">No USDC yet.</td>
              </tr>
            )}
            {wallet.balances.map((b) => (
              <tr key={b.assetId} className="border-t border-line first:border-0 [&>td]:py-1.5">
                <td>
                  {chainLabel(b.chain)}
                </td>
                <td className="text-right">{usd(b.available)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Address({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted">{label}</div>
      <div className="flex items-center gap-2 rounded-md bg-sunken px-3 py-2">
        <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
        <button
          onClick={() =>
            navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
          className="shrink-0 text-xs text-accent hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function WithdrawPanel({ wallet, onDone }: { wallet: Wallet | null; onDone: () => Promise<void> }) {
  const { reauth } = useApp();
  const toast = useToast();
  const sources = wallet?.balances.filter((b) => Number(b.available) > 0) ?? [];
  const [assetId, setAssetId] = useState("");
  const [to, setTo] = useState("");
  const [picked, setPicked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; link?: string | null } | null>(null);
  const source = sources.find((b) => b.assetId === assetId) ?? sources[0];
  const maxAmount = Math.floor(Number(source?.available ?? 0) * 100) / 100;
  // Kept within the selected balance when switching networks.
  const amount = Math.min(picked, maxAmount);

  async function submit(retried = false): Promise<void> {
    if (!source) return;
    setBusy(true);
    setResult(null);
    const input = { assetId: source.assetId, amount, to: to.trim() };
    const send = async () => {
      try {
        return await api.withdraw(input);
      } catch (e) {
        // Withdrawals need a recent Google sign-in: confirm it, then send once more.
        if (!retried && (e as { details?: { reauth?: boolean } }).details?.reauth) {
          await reauth();
          return api.withdraw(input);
        }
        throw e;
      }
    };
    try {
      const res = await toast.track(send, {
        loading: `Sending ${usd(amount)} on ${chainLabel(source.chain)}…`,
        success: `Sent ${usd(amount)} on ${chainLabel(source.chain)}`,
        error: "Withdrawal didn't go through",
      });
      setResult({ ok: true, text: `Sent ${usd(amount)} on ${chainLabel(source.chain)}.`, link: res.explorerUrl });
      setPicked(0);
      await onDone();
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-line p-4 text-sm">
      <h2 className="font-medium">Withdraw USDC</h2>
      {sources.length === 0 ? (
        <p className="text-xs text-muted">Nothing to withdraw yet. Close positions to free up margin.</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">From</span>
            <select id="withdraw-source" className="input" value={source?.assetId} onChange={(e) => setAssetId(e.target.value)}>
              {sources.map((b) => (
                <option key={b.assetId} value={b.assetId}>
                  {chainLabel(b.chain)} · {usd(b.available)} available
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">To address on {source ? chainLabel(source.chain) : "this network"}</span>
            <input id="withdraw-to" className="input font-mono text-xs" value={to} onChange={(e) => setTo(e.target.value)} placeholder={source?.chain === "solana" ? "Solana address" : "0x…"} autoComplete="off" spellCheck={false} />
          </label>
          <AmountSlider id="withdraw-amount" label="Amount" value={amount} onChange={setPicked} min={1} max={maxAmount} caption={`of ${usd(maxAmount)} on ${source ? chainLabel(source.chain) : "this network"}`} />
          <p className="text-xs text-muted">
            Transfers are final and stay on the same network.{" "}
            {source?.chain.startsWith("hypercore") && "Hyperliquid balances can only go to another Hyperliquid address. "}
            You&apos;ll be asked to confirm your Google sign-in.
          </p>
          <button type="submit" disabled={busy || !(amount >= 1) || !to.trim()} className="w-full rounded-md bg-ink py-2 font-semibold text-white disabled:opacity-40">
            {busy ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner /> Sending…
              </span>
            ) : (
              `Withdraw ${amount >= 1 ? usd(amount) : ""}`
            )}
          </button>
        </form>
      )}
      {result && (
        <p className={`text-xs ${result.ok ? "text-long" : "text-short"}`}>
          {result.text}{" "}
          {result.link && (
            <a href={result.link} target="_blank" rel="noreferrer" className="underline">
              View transaction
            </a>
          )}
        </p>
      )}
    </section>
  );
}

function WithdrawalHistory({ uid }: { uid: string }) {
  const [rows, setRows] = useState<WithdrawalRow[]>([]);
  useEffect(() => {
    const app = firebaseApp();
    if (!app) return;
    const q = query(collection(getFirestore(app), "withdrawals"), where("uid", "==", uid), orderBy("createdAt", "desc"), limit(10));
    return onSnapshot(q, (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WithdrawalRow)), () => setRows([]));
  }, [uid]);
  if (!rows.length) return null;
  return (
    <section className="rounded-lg border border-line">
      <h2 className="border-b border-line px-3 py-2 text-sm font-medium">Withdrawals</h2>
      <table className="w-full text-xs tabular-nums">
        <tbody>
          {rows.map((w) => (
            <tr key={w.id} className="border-t border-line first:border-0 [&>td]:px-3 [&>td]:py-2">
              <td className="text-muted">{w.createdAt?.toDate().toLocaleString() ?? "…"}</td>
              <td>{usd(w.amount)}</td>
              <td>{chainLabel(w.chain)}</td>
              <td className="font-mono">
                {w.to.slice(0, 6)}…{w.to.slice(-4)}
              </td>
              <td className={w.status === "completed" ? "text-long" : w.status === "failed" ? "text-short" : "text-muted"}>{w.status}</td>
              <td className="text-right">
                {w.explorerUrl && (
                  <a href={w.explorerUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    Tx
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Card({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
