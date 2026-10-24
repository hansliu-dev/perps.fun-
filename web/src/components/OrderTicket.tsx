"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { formatPrice, type PerpAsset } from "@/lib/markets";
import { useAvailableUsdc } from "@/lib/useAvailableUsdc";
import { AmountSlider, formatUsd } from "./AmountSlider";
import { useApp } from "./Providers";
import { Spinner, useToast } from "./Toasts";

export function OrderTicket({ asset, markPrice, onFilled }: { asset: PerpAsset; markPrice?: number; onFilled?: () => void }) {
  const { user, account, signIn } = useApp();
  const toast = useToast();
  const blocked = account.status === "blocked" || account.status === "error";
  const maxLev = asset.perp?.max_leverage ?? 1;
  const [side, setSide] = useState<"long" | "short">("long");
  const [picked, setPicked] = useState<number | null>(null);
  const [leverage, setLeverage] = useState(Math.min(5, maxLev));
  const { available, refresh: refreshAvailable } = useAvailableUsdc();
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Hyperliquid's $10 minimum position sets the smallest margin at this leverage.
  const minMargin = Math.ceil((10 / leverage) * 100) / 100;
  const maxMargin = Math.floor((available ?? 0) * 100) / 100;
  const marginNum = Math.round(Math.min(maxMargin, Math.max(minMargin, picked ?? maxMargin / 4)) * 100) / 100;
  const canAfford = maxMargin >= minMargin;
  const notional = marginNum * leverage;
  const size = markPrice ? notional / markPrice : undefined;
  // Isolated margin: liquidation roughly when the move against you ≈ 1/leverage (ignores maintenance margin).
  const liq = markPrice ? (side === "long" ? markPrice * (1 - 1 / leverage) : markPrice * (1 + 1 / leverage)) : undefined;

  async function submit() {
    if (!user) return signIn();
    setBusy(true);
    setMsg(null);
    const label = `${side === "long" ? "Long" : "Short"} ${asset.symbol} ${formatUsd(marginNum)} at ${leverage}×`;
    try {
      const res = await toast.track(
        api.placeOrder({
          assetId: asset.id,
          symbol: asset.symbol,
          side,
          marginUsd: marginNum,
          leverage,
          takeProfit: tp ? Number(tp) : undefined,
          stopLoss: sl ? Number(sl) : undefined,
        }),
        { loading: `Placing ${label}…`, success: (r) => (r.status === "complete" || r.status === "filled" ? `${label} filled` : `${label}: ${r.status}`), error: "Order didn't go through" },
      );
      if (res.warnings?.length) setMsg({ ok: false, text: res.warnings.join(" ") });
      onFilled?.();
      refreshAvailable();
    } catch {
      // The popup shows why.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-sunken p-1">
        {(["long", "short"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`rounded py-1.5 font-semibold capitalize ${side === s ? (s === "long" ? "bg-long text-white" : "bg-short text-white") : "text-muted"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {!user ? (
        <p className="rounded-md bg-sunken p-2.5 text-xs text-muted">Sign in to trade with your USDC.</p>
      ) : available === null ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3.5 w-3.5" /> Checking your balance…
        </p>
      ) : canAfford ? (
        <AmountSlider id="order-margin" label="Margin" value={marginNum} onChange={setPicked} min={minMargin} max={maxMargin} caption={`of ${formatUsd(maxMargin)} available`} />
      ) : (
        <p className="rounded-md bg-sunken p-2.5 text-xs text-muted">
          You need at least {formatUsd(minMargin)} at {leverage}× (a $10 position). You have {formatUsd(maxMargin)}.
        </p>
      )}

      <AmountSlider id="order-leverage" label="Leverage" value={leverage} onChange={setLeverage} min={1} max={maxLev} step={1} format={(v) => `${v}×`} caption={`up to ${maxLev}×`} quickPicks={false} />

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Take profit</span>
          <input value={tp} onChange={(e) => setTp(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Price" inputMode="decimal" className="input" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Stop loss</span>
          <input value={sl} onChange={(e) => setSl(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Price" inputMode="decimal" className="input" />
        </label>
      </div>

      <dl className="space-y-1 rounded-md bg-sunken p-2 text-xs tabular-nums">
        <Row k="Position size" v={size ? `${size.toFixed(4)} ${asset.symbol}` : "—"} />
        <Row k="Notional" v={`$${notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} />
        <Row k="Est. liquidation" v={formatPrice(liq)} />
        <Row k="Funding (1h)" v={asset.perp?.funding_rate ? `${(Number(asset.perp.funding_rate) * 100).toFixed(4)}%` : "—"} />
      </dl>

      <button
        onClick={submit}
        disabled={busy || (!!user && (blocked || account.status !== "ready" || !canAfford))}
        className={`rounded-md py-2.5 font-semibold disabled:opacity-50 ${side === "long" ? "bg-long text-white" : "bg-short text-white"}`}
      >
        {!user ? "Sign in to trade" : blocked ? "Trading unavailable" : account.status !== "ready" ? "Setting up…" : busy ? (
          <span className="inline-flex items-center justify-center gap-2">
            <Spinner /> Placing…
          </span>
        ) : (
          `${side === "long" ? "Long" : "Short"} ${asset.symbol}`
        )}
      </button>
      {msg && <p className={`text-xs ${msg.ok ? "text-long" : "text-short"}`}>{msg.text}</p>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
