"use client";

import type { Period } from "klinecharts";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Chart, type ChartHandle } from "@/components/Chart";
import { usePortfolio } from "@/components/Positions";
import { useApp } from "@/components/Providers";
import { Spinner, useToast } from "@/components/Toasts";
import { api } from "@/lib/api";
import { PERIODS } from "@/lib/chart/dataLoader";
import { DRAWING_TOOLS, serializeDrawings, type SerializedOverlay } from "@/lib/chart/overlays";
import { DEFAULT_SYMBOL, formatPrice } from "@/lib/markets";
import { usePerps } from "@/lib/usePerps";

export default function NewThesisPage() {
  return (
    <Suspense>
      <NewThesis />
    </Suspense>
  );
}

const BG = "#ffffff";
const MAX_CAPTION = 70;

function NewThesis() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, signIn } = useApp();
  const { perps } = usePerps();
  const [symbol, setSymbol] = useState((params.get("symbol") ?? DEFAULT_SYMBOL).toUpperCase());
  const [period, setPeriod] = useState<Period>(PERIODS[3].period);
  const [tool, setTool] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [preview, setPreview] = useState<{ image: string; overlays: SerializedOverlay[] } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [caption, setCaption] = useState("");
  const toast = useToast();
  const handle = useRef<ChartHandle | null>(null);
  const { portfolio } = usePortfolio();
  const position = portfolio?.positions.find((p) => p.symbol === symbol);

  const refreshCount = () => setCount(handle.current ? serializeDrawings(handle.current.chart).length : 0);

  function pick(name: string) {
    if (!handle.current) return;
    setTool(name);
    handle.current.chart.createOverlay({
      name,
      onDrawEnd: () => {
        setTool(null);
        refreshCount();
        return false;
      },
    });
  }

  function undo() {
    const chart = handle.current?.chart;
    const last = chart?.getOverlays().filter((o) => o.name !== "thesisMarker").at(-1);
    if (last) chart!.removeOverlay({ id: last.id });
    refreshCount();
  }

  function clear() {
    handle.current?.chart.removeOverlay();
    refreshCount();
  }

  async function submit() {
    if (!handle.current) return;
    const { chart } = handle.current;
    const snapshot = { image: chart.getConvertPictureUrl(true, "png", BG), overlays: serializeDrawings(chart) };
    if (!user) {
      setPreview(snapshot);
      return;
    }
    setStatus(null);
    setPosting(true);
    try {
      const periodLabel = PERIODS.find((p) => p.period.type === period.type && p.period.span === period.span)?.label ?? "1H";
      await toast.track(api.submitThesis({ symbol, period: periodLabel, imageDataUrl: snapshot.image, overlays: snapshot.overlays, caption: caption.trim() || undefined }), {
        loading: `Posting your ${symbol} thesis…`,
        success: `Thesis posted on ${symbol}`,
        error: "Couldn't post your thesis",
      });
      router.push(`/markets/${symbol}?posted=1`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      setPreview(snapshot);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
        {DRAWING_TOOLS.map((t) => (
          <button
            key={t.name}
            title={t.label}
            aria-label={t.label}
            onClick={() => pick(t.name)}
            className={`flex h-9 w-9 items-center justify-center rounded-md text-lg ${tool === t.name ? "bg-accent text-white" : "text-muted hover:bg-sunken hover:text-ink"}`}
          >
            {t.icon}
          </button>
        ))}
        <div className="my-1 h-px w-8 bg-line" />
        <button title="Undo" aria-label="Undo" onClick={undo} className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink">
          ↶
        </button>
        <button title="Clear all" aria-label="Clear all" onClick={clear} className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-ink">
          ✕
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="input w-32" aria-label="Market">
            {(perps ?? [{ symbol, id: symbol }]).map((p) => (
              <option key={p.id} value={p.symbol}>
                {p.symbol}-PERP
              </option>
            ))}
          </select>
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <button
                key={p.label}
                onClick={() => setPeriod(p.period)}
                className={`rounded px-2 py-0.5 text-xs ${p.period.type === period.type && p.period.span === period.span ? "bg-sunken text-ink" : "text-muted hover:text-ink"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs">
            {position ? (
              <span className={`rounded-full border px-2.5 py-1 ${position.side === "long" ? "border-long/40 text-long" : "border-short/40 text-short"}`}>
                Attaching: {position.side.toUpperCase()} {position.leverage}× @ {formatPrice(position.entry_price)}
              </span>
            ) : (
              <span className="text-muted">{user ? `No open ${symbol} position` : "Sign in to attach your position"}</span>
            )}
            <span className="text-muted">{count} drawing{count === 1 ? "" : "s"}</span>
            <button onClick={user ? submit : signIn} disabled={user ? count === 0 || posting : false} className="rounded-md bg-accent px-4 py-1.5 font-semibold text-white disabled:opacity-40">
              {!user ? (
                "Sign in to post"
              ) : posting ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="h-3.5 w-3.5" /> Posting…
                </span>
              ) : (
                "Post thesis"
              )}
            </button>
            {!user && (
              <button onClick={submit} disabled={count === 0} className="rounded-md border border-line px-3 py-1.5 disabled:opacity-40">
                Preview
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 border-b border-line px-4 py-2">
          <input
            id="thesis-caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value.slice(0, MAX_CAPTION))}
            maxLength={MAX_CAPTION}
            placeholder="Your thesis in one sentence (optional)"
            autoComplete="off"
            className="input flex-1"
          />
          <span className={`w-12 text-right text-xs tabular-nums ${caption.length >= MAX_CAPTION ? "text-short" : "text-muted"}`}>
            {caption.length}/{MAX_CAPTION}
          </span>
        </div>
        <div className="relative min-h-0 flex-1">
          <Chart symbol={symbol} period={period} showVolume={false} onReady={(h) => (handle.current = h)} />
          {count === 0 && !tool && (
            <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center">
              <span className="rounded-full border border-line bg-panel px-4 py-1.5 text-sm text-muted shadow-sm">Pick a tool on the left and draw your thesis.</span>
            </div>
          )}
        </div>
        {status && <div className="border-t border-line px-4 py-2 text-xs text-short">{status}</div>}
      </main>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8" onClick={() => setPreview(null)}>
          <div className="max-w-4xl rounded-xl border border-line bg-panel p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">
                Thesis preview · {symbol} · {preview.overlays.length} drawings
              </h2>
              <a href={preview.image} download={`${symbol}-thesis.png`} className="text-sm text-accent hover:underline">
                Download PNG
              </a>
            </div>
            {caption.trim() && <p className="mb-3 text-sm">{caption.trim()}</p>}
            <img src={preview.image} alt="Thesis snapshot" className="max-h-[70vh] rounded border border-line" />
          </div>
        </div>
      )}
    </div>
  );
}
