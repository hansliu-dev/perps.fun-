"use client";

import { useEffect, useState } from "react";
import { fetchPerps, type PerpAsset } from "./markets";
import { subscribePrice, type LivePrice } from "./tm-ws";

export function usePerps() {
  const [perps, setPerps] = useState<PerpAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchPerps()
      .then((p) => live && setPerps(p))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, []);
  return { perps, error };
}

export function useLivePrice(symbol: string | undefined) {
  const [price, setPrice] = useState<LivePrice | null>(null);
  useEffect(() => {
    setPrice(null);
    if (!symbol) return;
    return subscribePrice(symbol, setPrice);
  }, [symbol]);
  return price;
}

export function useLivePrices(symbols: string[]) {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const key = symbols.join(",");
  useEffect(() => {
    const offs = symbols.map((s) => subscribePrice(s, (p) => setPrices((prev) => ({ ...prev, [s]: p }))));
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return prices;
}
