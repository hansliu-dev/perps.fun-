"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Portfolio, type Position } from "@/lib/api";
import { formatPrice } from "@/lib/markets";
import { useLivePrices } from "@/lib/usePerps";
import { useApp } from "./Providers";
import { Spinner, useToast } from "./Toasts";

export function usePortfolio(refreshKey = 0) {
  const { user, account } = useApp();
  const ready = account.status === "ready";
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user || !ready) return setPortfolio(null);
    try {
      setPortfolio(await api.getPortfolio());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [user, ready]);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load, refreshKey]);

  return { portfolio, error, reload: load };
}

// One table row: your own share of a position, a share copied from someone, or a position in an older copy account.
interface Row {
  key: string;
  p: Position;
  share: number; // fraction of the whole position this row represents
  size: number;
  copiedFrom?: { uid: string; handle: string };
  legacy?: boolean;
}

function rowsFor(portfolio: Portfolio): Row[] {
  const rows: Row[] = [];
  for (const p of portfolio.positions) {
    const total = Number(p.size);
    const lots = (portfolio.lots ?? []).filter((l) => l.assetId === p.asset_id);
    const copied = Math.min(total, lots.reduce((s, l) => s + l.size, 0));
    if (total - copied > 1e-9) rows.push({ key: `own:${p.asset_id}`, p, share: (total - copied) / total, size: total - copied });
    for (const l of lots) {
      const size = Math.min(l.size, total);
      rows.push({ key: `lot:${p.asset_id}:${l.leaderUid}`, p, share: size / total, size, copiedFrom: { uid: l.leaderUid, handle: l.leaderHandle } });
    }
  }
  for (const c of portfolio.copies ?? []) {
    for (const p of c.positions) rows.push({ key: `legacy:${c.leaderUid}:${p.asset_id}`, p, share: 1, size: Number(p.size), copiedFrom: { uid: c.leaderUid, handle: c.leaderHandle }, legacy: true });
  }
  return rows;
}

// Marks a position to the live price feed (the same one as the chart), falling back to TrueMarkets' mark.
export function livePnl(p: Position, livePrice?: string) {
  const mark = Number(livePrice ?? p.mark_price);
  const pnl = (p.side === "long" ? 1 : -1) * (mark - Number(p.entry_price)) * Number(p.size);
  const margin = Number(p.margin_used);
  return { mark, pnl, roe: margin > 0 ? pnl / margin : 0 };
}

// Total unrealized PnL across the account and any older copy accounts, live.
export function useLiveUnrealized(portfolio: Portfolio | null): number | null {
  const all = portfolio ? [...portfolio.positions, ...(portfolio.copies ?? []).flatMap((c) => c.positions)] : [];
  const prices = useLivePrices([...new Set(all.map((p) => p.symbol))].sort());
  if (!portfolio) return null;
  return all.reduce((s, p) => s + livePnl(p, prices[p.symbol]?.price).pnl, 0);
}

// "+$1.23" / "−$0.005": sign first, more decimals for small amounts so they don't round to zero.
export function signedUsd(v: number) {
  const abs = Math.abs(v);
  const digits = abs > 0 && abs < 1 ? 3 : 2;
  const sign = v > 0.0005 ? "+" : v < -0.0005 ? "−" : "";
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const pnlTone = (v: number) => (v > 0.0005 ? "text-long" : v < -0.0005 ? "text-short" : "text-muted");

export function Positions({ refreshKey }: { refreshKey?: number }) {
  const { user } = useApp();
  const toast = useToast();
  const { portfolio, error, reload } = usePortfolio(refreshKey);
  const [busy, setBusy] = useState<string | null>(null);
  const symbols = portfolio ? [...new Set([...portfolio.positions, ...(portfolio.copies ?? []).flatMap((c) => c.positions)].map((p) => p.symbol))].sort() : [];
  const livePrices = useLivePrices(symbols);

  async function run(key: string, work: () => Promise<unknown>, labels: { loading: string; success: string }) {
    setBusy(key);
    try {
      await toast.track(work, { ...labels, error: "Couldn't close" });
      await reload();
    } catch {
      // The popup already shows the reason.
    } finally {
      setBusy(null);
    }
  }

  if (!user) return <Empty text="Sign in to see your positions." />;
  if (error) return <Empty text={error} />;
  if (!portfolio) return <Empty text="Loading positions…" />;
  const rows = rowsFor(portfolio);
  if (!rows.length) return <Empty text="No open positions." />;

  return (
    <table className="w-full text-xs tabular-nums">
      <thead className="text-muted">
        <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-normal">
          <th>Market</th>
          <th>Size</th>
          <th>Entry</th>
          <th>Mark</th>
          <th>Liq.</th>
          <th>Margin</th>
          <th>PnL (ROE)</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const { p } = r;
          const live = livePnl(p, livePrices[p.symbol]?.price);
          const pnl = live.pnl * r.share;
          const isBusy = busy?.startsWith(r.key) ?? false;
          const decimals = Math.min(8, (p.size.split(".")[1] ?? "").length || 4);
          return (
            <tr key={r.key} className={`row-new border-t border-line [&>td]:px-3 [&>td]:py-2 ${isBusy ? "row-busy" : ""}`}>
              <td>
                <span className={p.side === "long" ? "text-long" : "text-short"}>{p.side === "long" ? "▲" : "▼"}</span> {p.symbol} {p.leverage}×
                {r.copiedFrom && (
                  <Link href={`/u/${r.copiedFrom.handle}`} className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent hover:underline">
                    Copied from @{r.copiedFrom.handle}
                  </Link>
                )}
              </td>
              <td>{r.size.toFixed(decimals)}</td>
              <td>{formatPrice(p.entry_price)}</td>
              <td>{formatPrice(live.mark)}</td>
              <td>{formatPrice(p.liquidation_price ?? undefined)}</td>
              <td>${(Number(p.margin_used) * r.share).toFixed(2)}</td>
              <td className={pnlTone(pnl)}>
                {signedUsd(pnl)} ({live.roe >= 0 ? "+" : "−"}
                {Math.abs(live.roe * 100).toFixed(2)}%)
              </td>
              <td className="space-x-1 whitespace-nowrap text-right">
                {r.legacy ? (
                  <span className="text-[11px] text-muted" title="Held in an older separate copy account. Stop copying on the Portfolio page to close it.">
                    Old copy account
                  </span>
                ) : r.copiedFrom ? (
                  <ActionButton
                    busy={busy === `${r.key}:all`}
                    disabled={!!busy}
                    onClick={() =>
                      run(`${r.key}:all`, () => api.closeCopyLot({ assetId: p.asset_id, leaderUid: r.copiedFrom!.uid }), {
                        loading: `Closing your ${p.symbol} copied from @${r.copiedFrom!.handle}…`,
                        success: `Closed ${p.symbol} copied from @${r.copiedFrom!.handle}`,
                      })
                    }
                  >
                    Close
                  </ActionButton>
                ) : (
                  <>
                    <ActionButton
                      busy={busy === `${r.key}:half`}
                      disabled={!!busy}
                      onClick={() => run(`${r.key}:half`, () => api.closePosition({ assetId: p.asset_id, fraction: 0.5 }), { loading: `Closing half of your ${p.symbol} ${p.side}…`, success: `Closed half of your ${p.symbol} ${p.side}` })}
                    >
                      50%
                    </ActionButton>
                    <ActionButton
                      busy={busy === `${r.key}:all`}
                      disabled={!!busy}
                      onClick={() => run(`${r.key}:all`, () => api.closePosition({ assetId: p.asset_id, fraction: 1 }), { loading: `Closing your ${p.symbol} ${p.side}…`, success: `Closed your ${p.symbol} ${p.side}` })}
                    >
                      Close
                    </ActionButton>
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ActionButton({ busy, disabled, onClick, children }: { busy: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button disabled={disabled} onClick={onClick} className="inline-flex items-center gap-1 rounded bg-sunken px-2 py-1 hover:bg-line disabled:opacity-50">
      {busy && <Spinner className="h-3 w-3" />}
      {children}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-4 text-xs text-muted">{text}</div>;
}
