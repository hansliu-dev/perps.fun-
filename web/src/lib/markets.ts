// Real money: TrueMarkets production. Perps execute on Hyperliquid.
export const TM_BASE_URL = "https://api.truemarkets.co";

// Market data (prices/candles) always comes from production: UAT has no ZEC price feed.
export const TM_MARKET_WS = "wss://api.truemarkets.co/v1/defi/market";

export interface PerpAsset {
  id: string;
  symbol: string;
  chain: string;
  asset_class?: "crypto" | "stock";
  status: string;
  perp?: { funding_rate: string | null; open_interest: string | null; volume_24h: string | null; max_leverage: number | null };
}

export const DEFAULT_SYMBOL = "BTC";

export async function fetchPerps(): Promise<PerpAsset[]> {
  const res = await fetch("/api/assets");
  if (!res.ok) throw new Error(`assets ${res.status}`);
  return res.json();
}

export function formatPrice(value: number | string | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === undefined || !Number.isFinite(n)) return "—";
  const digits = n >= 1000 ? 1 : n >= 1 ? 3 : 5;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
