import { TM_MARKET_WS } from "./markets";

// One shared connection to the TrueMarkets market-data WebSocket with ref-counted topics and reconnect.
export interface LivePrice {
  symbol: string;
  asset_class: "spot" | "perp";
  price: string;
  change_1h?: string;
  change_24h?: string;
  timestamp: string;
}

type Listener = (data: unknown) => void;

class TmMarketSocket {
  private ws?: WebSocket;
  // Keyed upper-case (the server keys symbols upper-case); `topic` keeps the spelling we subscribe with.
  private listeners = new Map<string, { topic: string; fns: Set<Listener> }>();
  private retry = 0;

  subscribe(topic: string, fn: Listener): () => void {
    const key = topic.toUpperCase();
    let entry = this.listeners.get(key);
    if (!entry) {
      entry = { topic, fns: new Set() };
      this.listeners.set(key, entry);
      this.send({ type: "subscribe", topics: [topic] });
    }
    entry.fns.add(fn);
    this.connect();
    return () => {
      entry!.fns.delete(fn);
      if (entry!.fns.size === 0) {
        this.listeners.delete(key);
        this.send({ type: "unsubscribe", topics: [topic] });
      }
    };
  }

  private connect() {
    if (this.ws || typeof window === "undefined") return;
    const ws = new WebSocket(TM_MARKET_WS);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      const topics = [...this.listeners.values()].map((e) => e.topic);
      if (topics.length) ws.send(JSON.stringify({ type: "subscribe", topics }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { type: string; topics?: string[]; data?: unknown };
      if (!msg.topics || msg.data === undefined) return;
      for (const t of msg.topics) this.listeners.get(t.toUpperCase())?.fns.forEach((fn) => fn(msg.data));
    };
    ws.onclose = () => {
      this.ws = undefined;
      if (this.listeners.size === 0) return;
      setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** this.retry++));
    };
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

export const tmSocket = new TmMarketSocket();

export function subscribePrice(symbol: string, fn: (p: LivePrice) => void) {
  return tmSocket.subscribe(`price.${symbol}-PERP`, fn as Listener);
}
