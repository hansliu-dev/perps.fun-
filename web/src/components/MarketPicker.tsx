"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatPrice, type PerpAsset } from "@/lib/markets";
import { useLivePrices } from "@/lib/usePerps";

// Market switcher: the title opens the full list, with a search box at the top.
export function MarketPicker({ perps, active }: { perps: PerpAsset[] | null; active: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const term = q.trim().toUpperCase().replace(/-PERP$/, "");
    if (!perps) return [];
    if (!term) return perps;
    // Symbols starting with the term first, then ones containing it.
    const starts = perps.filter((p) => p.symbol.startsWith(term));
    const contains = perps.filter((p) => !p.symbol.startsWith(term) && p.symbol.includes(term));
    return [...starts, ...contains];
  }, [perps, q]);

  // Live prices only while the list is open, to keep WebSocket topics low.
  const prices = useLivePrices(open ? results.slice(0, 40).map((p) => p.symbol) : []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setCursor(0), [q]);

  function openList() {
    setQ("");
    setOpen(true);
    requestAnimationFrame(() => search.current?.focus());
  }

  function choose(symbol: string) {
    setOpen(false);
    if (symbol !== active) router.push(`/markets/${symbol}`);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && results[cursor]) choose(results[cursor].symbol);
  }

  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <button
        onClick={() => (open ? setOpen(false) : openList())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-sunken"
      >
        <span className="text-lg font-semibold">{active}-PERP</span>
        <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true" className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M5 7.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 overflow-hidden rounded-lg border border-line bg-panel shadow-xl">
          <div className="border-b border-line p-2">
            <input
              ref={search}
              id="market-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${perps?.length ?? ""} markets`}
              autoComplete="off"
              spellCheck={false}
              className="input w-full"
            />
          </div>
          <ul role="listbox" className="max-h-96 overflow-y-auto py-1">
            {!perps && <li className="px-3 py-2 text-sm text-muted">Loading markets…</li>}
            {perps && results.length === 0 && <li className="px-3 py-2 text-sm text-muted">No market matches “{q.trim()}”.</li>}
            {results.map((p, i) => {
              const live = prices[p.symbol];
              const change = Number(live?.change_24h ?? NaN);
              return (
                <li key={p.id} role="option" aria-selected={p.symbol === active}>
                  <button
                    onClick={() => choose(p.symbol)}
                    onMouseEnter={() => setCursor(i)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${i === cursor ? "bg-sunken" : ""}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`font-medium ${p.symbol === active ? "text-accent" : ""}`}>{p.symbol}</span>
                      <span className="rounded bg-sunken px-1 text-[10px] text-muted">{p.perp?.max_leverage ?? "?"}×</span>
                    </span>
                    <span className="text-right tabular-nums">
                      <span className="block">{formatPrice(live?.price)}</span>
                      <span className={`block text-[11px] ${change >= 0 ? "text-long" : "text-short"}`}>
                        {Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
