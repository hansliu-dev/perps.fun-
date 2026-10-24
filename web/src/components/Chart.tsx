"use client";

import type * as KC from "klinecharts";
import { useEffect, useRef } from "react";
import { createDataLoader } from "@/lib/chart/dataLoader";
import { registerCustomOverlays } from "@/lib/chart/overlays";

export interface ChartHandle {
  chart: KC.Chart;
  kc: typeof KC;
}

interface Props {
  symbol: string;
  period: KC.Period;
  pricePrecision?: number;
  showVolume?: boolean;
  onReady?: (handle: ChartHandle) => void;
  className?: string;
}

const UP = "#16a34a";
const DOWN = "#dc2626";
const STYLES = {
  grid: { horizontal: { color: "#eef0f3" }, vertical: { color: "#eef0f3" } },
  candle: {
    bar: { upColor: UP, downColor: DOWN, upBorderColor: UP, downBorderColor: DOWN, upWickColor: UP, downWickColor: DOWN },
    priceMark: { last: { upColor: UP, downColor: DOWN } },
  },
};

export function Chart({ symbol, period, pricePrecision = 2, showVolume = true, onReady, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const market = useRef({ symbol, period, pricePrecision });
  market.current = { symbol, period, pricePrecision };

  const applyMarket = () => {
    const { symbol, period, pricePrecision } = market.current;
    handle.current?.chart.setSymbol({ ticker: symbol, pricePrecision, volumePrecision: 2 });
    handle.current?.chart.setPeriod(period);
  };

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | undefined;
    (async () => {
      const kc = await import("klinecharts");
      if (disposed || !el.current) return;
      registerCustomOverlays(kc);
      const chart = kc.init(el.current, { styles: "light" });
      if (!chart) return;
      chart.setStyles(STYLES);
      chart.setDataLoader(createDataLoader());
      if (showVolume) chart.createIndicator("VOL");
      handle.current = { chart, kc };
      applyMarket();
      ro = new ResizeObserver(() => chart.resize());
      ro.observe(el.current);
      onReadyRef.current?.(handle.current);
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      if (handle.current) {
        handle.current.kc.dispose(handle.current.chart);
        handle.current = null;
      }
    };
  }, [showVolume]);

  useEffect(() => {
    applyMarket();
  }, [symbol, period.type, period.span, pricePrecision]);

  return <div ref={el} className={className ?? "h-full w-full"} />;
}
