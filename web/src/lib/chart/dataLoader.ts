import type { DataLoader, KLineData, Period } from "klinecharts";
import { subscribePrice } from "../tm-ws";

// History: TrueMarkets has no REST candles for perps, and its perps are Hyperliquid markets,
// so bars come from Hyperliquid's public candleSnapshot. Live updates come from the TrueMarkets WS.
const HL_INFO = "https://api.hyperliquid.xyz/info";
const PAGE_BARS = 500;

export const PERIODS = [
  { label: "1m", period: { type: "minute", span: 1 }, hl: "1m", ms: 60_000 },
  { label: "5m", period: { type: "minute", span: 5 }, hl: "5m", ms: 300_000 },
  { label: "15m", period: { type: "minute", span: 15 }, hl: "15m", ms: 900_000 },
  { label: "1H", period: { type: "hour", span: 1 }, hl: "1h", ms: 3_600_000 },
  { label: "4H", period: { type: "hour", span: 4 }, hl: "4h", ms: 14_400_000 },
  { label: "1D", period: { type: "day", span: 1 }, hl: "1d", ms: 86_400_000 },
] as const satisfies ReadonlyArray<{ label: string; period: Period; hl: string; ms: number }>;

function periodInfo(p: Period) {
  return PERIODS.find((x) => x.period.type === p.type && x.period.span === p.span) ?? PERIODS[3];
}

async function fetchHistory(coin: string, interval: string, startTime: number, endTime: number): Promise<KLineData[]> {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>;
  return rows.map((r) => ({ timestamp: r.t, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }));
}

export function createDataLoader(): DataLoader {
  const unsubs = new Map<string, () => void>();
  // Latest history bar per ticker+period, so live ticks extend it instead of replacing it.
  const lastBars = new Map<string, KLineData>();

  return {
    async getBars({ type, timestamp, symbol, period, callback }) {
      const info = periodInfo(period);
      if (type === "init") {
        const end = Date.now();
        const bars = await fetchHistory(symbol.ticker, info.hl, end - PAGE_BARS * info.ms, end);
        const last = bars.at(-1);
        if (last) lastBars.set(`${symbol.ticker}:${info.label}`, last);
        callback(bars, { forward: bars.length > 0, backward: false });
      } else if (type === "forward" && timestamp) {
        const bars = await fetchHistory(symbol.ticker, info.hl, timestamp - PAGE_BARS * info.ms, timestamp - 1);
        callback(bars, { forward: bars.length > 0, backward: false });
      } else {
        callback([], false);
      }
    },

    subscribeBar({ symbol, period, callback }) {
      const info = periodInfo(period);
      const key = `${symbol.ticker}:${info.label}`;
      let bar: KLineData | undefined;
      const bucket = (now: number) => Math.floor(now / info.ms) * info.ms;

      // Fold live perp prices into the current bar; KLineChart appends a new bar when the timestamp advances.
      const offPrice = subscribePrice(symbol.ticker, (p) => {
        const price = Number(p.price);
        const t = bucket(Date.parse(p.timestamp) || Date.now());
        const seed = lastBars.get(key);
        // Re-seed if history for this bucket arrived after the first tick.
        if (!bar || bar.timestamp !== t || (bar !== seed && !bar.volume && seed?.timestamp === t)) {
          bar = seed?.timestamp === t ? seed : { timestamp: t, open: price, high: price, low: price, close: price, volume: 0 };
        }
        bar = { ...bar, high: Math.max(bar.high, price), low: Math.min(bar.low, price), close: price };
        callback(bar);
      });

      unsubs.set(key, offPrice);
    },

    unsubscribeBar({ symbol, period }) {
      const key = `${symbol.ticker}:${periodInfo(period).label}`;
      unsubs.get(key)?.();
      unsubs.delete(key);
    },
  };
}
