import { NextResponse } from "next/server";
import { TM_BASE_URL, type PerpAsset } from "@/lib/markets";

// The TrueMarkets catalog is public but not CORS-enabled for browsers, so we proxy it.
export async function GET() {
  const res = await fetch(`${TM_BASE_URL}/v1/gateway/assets?product_type=perp`, { next: { revalidate: 60 } });
  if (!res.ok) return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
  const { data } = (await res.json()) as { data: (PerpAsset & { type: string })[] };
  const perps = data
    .filter((a) => a.type === "perp" && a.status === "active")
    .sort((a, b) => Number(b.perp?.volume_24h ?? 0) - Number(a.perp?.volume_24h ?? 0));
  return NextResponse.json(perps);
}
