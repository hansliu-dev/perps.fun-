"use client";

import type { Period } from "klinecharts";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Chart, type ChartHandle } from "@/components/Chart";
import { MarketPicker } from "@/components/MarketPicker";
import { OrderTicket } from "@/components/OrderTicket";
import { Positions } from "@/components/Positions";
import { PERIODS } from "@/lib/chart/dataLoader";
import { preloadAvatar, type ThesisMarkerData } from "@/lib/chart/overlays";
import { DEFAULT_SYMBOL, formatPrice } from "@/lib/markets";
import { useLivePrice, usePerps } from "@/lib/usePerps";
import { profileName, useProfiles, type Profile } from "@/lib/profiles";
import { useThesisMarkers, type ThesisMarker } from "@/lib/useThesisMarkers";

export default function MarketPage() {
  return (
    <Suspense>
      <Market />
    </Suspense>
  );
}

function Market() {
  const { symbol: raw } = useParams<{ symbol: string }>();
  const symbol = raw.toUpperCase();
  const router = useRouter();
  const { perps, error } = usePerps();
  const asset = perps?.find((p) => p.symbol === symbol);
  const live = useLivePrice(symbol);
  const [period, setPeriod] = useState<Period>(PERIODS[3].period);
  const [refreshKey, setRefreshKey] = useState(0);
  const [hover, setHover] = useState<{ marker: ThesisMarker; x: number; y: number } | null>(null);
  const justPosted = useSearchParams().get("posted") === "1";
  const handle = useRef<ChartHandle | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const markers = useThesisMarkers(symbol);
  const profiles = useProfiles(markers.map((m) => m.uid));

  // Unknown symbol: fall back to a listed market.
  useEffect(() => {
    if (perps && perps.length && !asset) router.replace(`/markets/${perps.find((p) => p.symbol === DEFAULT_SYMBOL)?.symbol ?? perps[0].symbol}`);
  }, [perps, asset, router]);

  // One avatar per thesis, at the time and price it was posted. Hover shows the annotated chart.
  useEffect(() => {
    if (!chartReady || !handle.current) return;
    const { chart } = handle.current;
    let cancelled = false;
    (async () => {
      await Promise.all(Object.values(profiles).map((p) => (p.avatarUrl ? preloadAvatar(p.avatarUrl) : null)));
      // Older theses have no stored price; read it off the chart once bars have loaded.
      for (let i = 0; i < 20 && !cancelled && markers.some((m) => m.price === null) && chart.getDataList().length === 0; i++) await new Promise((r) => setTimeout(r, 250));
      if (cancelled) return;
      const bars = chart.getDataList();
      const priceAt = (ts: number) => [...bars].reverse().find((b) => b.timestamp <= ts)?.close ?? bars.at(-1)?.close;
      chart.removeOverlay({ groupId: "theses" });
      for (const m of [...markers].reverse()) {
        const value = m.price ?? priceAt(m.ts);
        if (value === undefined) continue;
        const p = profiles[m.uid];
        chart.createOverlay({
          name: "thesisMarker",
          groupId: "theses",
          points: [{ timestamp: m.ts, value }],
          extendData: { thesisId: m.id, uid: m.uid, name: profileName(p), avatarUrl: p?.avatarUrl, side: m.position?.side } satisfies ThesisMarkerData,
          onMouseEnter: (e) => setHover({ marker: m, x: e.x ?? 0, y: e.y ?? 0 }),
          onMouseLeave: () => setHover(null),
          onClick: () => router.push(`/thesis/${m.id}`),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [markers, profiles, chartReady, router, period]);

  const change = Number(live?.change_24h ?? NaN);

  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-6 border-b border-line px-4 py-2">
          <MarketPicker perps={perps} active={symbol} />
          <Stat label="Mark" value={formatPrice(live?.price)} />
          <Stat label="24h" value={Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "—"} tone={change >= 0 ? "long" : "short"} />
          <Stat label="Funding / 1h" value={asset?.perp?.funding_rate ? `${(Number(asset.perp.funding_rate) * 100).toFixed(4)}%` : "—"} />
          <Stat label="Open interest" value={asset?.perp?.open_interest ? `${Number(asset.perp.open_interest).toLocaleString()} ${symbol}` : "—"} />
          <Stat label="24h volume" value={asset?.perp?.volume_24h ? `$${(Number(asset.perp.volume_24h) / 1e6).toFixed(1)}M` : "—"} />
          <Link href={`/thesis/new?symbol=${symbol}`} className="ml-auto rounded-md border border-line px-3 py-1.5 text-sm hover:bg-sunken">
            Post thesis
          </Link>
        </div>
        <div className="flex gap-1 border-b border-line px-3 py-1">
          {PERIODS.map((p) => (
            <button
              key={p.label}
              onClick={() => setPeriod(p.period)}
              className={`rounded px-2 py-0.5 text-xs ${p.period.type === period.type && p.period.span === period.span ? "bg-sunken text-ink" : "text-muted hover:text-ink"}`}
            >
              {p.label}
            </button>
          ))}
          {markers.length > 0 && (
            <span className="ml-auto self-center text-[11px] text-muted">
              {markers.length} {markers.length === 1 ? "thesis" : "theses"} on the chart · hover an avatar to see it
            </span>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          <Chart
            symbol={symbol}
            period={period}
            pricePrecision={Number(live?.price ?? 100) >= 1000 ? 1 : 3}
            onReady={(h) => {
              handle.current = h;
              setChartReady(true);
            }}
          />
          {justPosted && <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white">Your thesis is live. Find your avatar on the chart.</div>}
          {hover && <MarkerPopover {...hover} profile={profiles[hover.marker.uid]} />}
        </div>
        <div className="h-48 shrink-0 overflow-y-auto border-t border-line">
          <div className="px-3 py-2 text-xs font-medium text-muted">Positions</div>
          <Positions refreshKey={refreshKey} />
        </div>
      </main>
      <aside className="w-72 shrink-0 border-l border-line bg-panel">
        {error && <p className="p-3 text-xs text-short">{error}</p>}
        {asset ? <OrderTicket asset={asset} markPrice={live ? Number(live.price) : undefined} onFilled={() => setRefreshKey((k) => k + 1)} /> : <p className="p-3 text-sm text-muted">Loading…</p>}
      </aside>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "long" | "short" }) {
  return (
    <div className="text-sm tabular-nums">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={tone === "long" ? "text-long" : tone === "short" ? "text-short" : ""}>{value}</div>
    </div>
  );
}

function MarkerPopover({ marker: m, profile, x, y }: { marker: ThesisMarker; profile?: Profile; x: number; y: number }) {
  const name = profileName(profile);
  // Flip to the left of the cursor near the right edge so the card stays on the chart.
  const left = x > 520 ? x - 316 : x + 16;
  return (
    <div className="pointer-events-none absolute z-20 w-[300px] rounded-lg border border-line bg-panel p-3 text-xs shadow-2xl" style={{ left: Math.max(8, left), top: Math.max(8, y - 60) }}>
      <div className="mb-2 flex items-center gap-2">
        <Avatar url={profile?.avatarUrl} name={name} size={28} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{name}</div>
          <div className="text-muted">{new Date(m.ts).toLocaleString()}</div>
        </div>
      </div>
      {m.caption && <p className="mb-2 text-sm font-medium leading-snug text-ink">{m.caption}</p>}
      {m.position ? (
        <div className={`mb-2 ${m.position.side === "long" ? "text-long" : "text-short"}`}>
          {m.position.side.toUpperCase()} {m.position.leverage}× from {formatPrice(m.position.entry_price)}
        </div>
      ) : (
        <div className="mb-2 text-muted">No open position when posted</div>
      )}
      <img src={m.imageUrl} alt={`${name}'s annotated chart`} className="w-full rounded border border-line" />
      <div className="mt-1.5 text-muted">Click the avatar to open the full thesis</div>
    </div>
  );
}
