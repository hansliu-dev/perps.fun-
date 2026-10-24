import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { BLOCKED_COUNTRIES } from "./config.js";

// Country check on every money-moving call. It fails closed: an unknown country is blocked.
// IP-based, so VPNs get through; identity verification would be needed to close that gap.
const cache = new Map<string, { country: string | null; at: number }>();

export function clientIp(req: CallableRequest): string | undefined {
  const fwd = req.rawRequest.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.rawRequest.ip || undefined;
}

export async function countryOf(ip: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.country;
  let country: string | null = null;
  try {
    const res = await fetchImpl(`https://api.country.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) country = ((await res.json()) as { country?: string }).country?.toUpperCase() ?? null;
  } catch {}
  cache.set(ip, { country, at: Date.now() });
  return country;
}

export function isBlocked(country: string | null, blockedList: string): boolean {
  if (!country) return true;
  return blockedList
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .includes(country);
}

export async function assertEligible(req: CallableRequest): Promise<string> {
  const ip = clientIp(req);
  const country = ip ? await countryOf(ip) : null;
  if (isBlocked(country, BLOCKED_COUNTRIES.value())) {
    throw new HttpsError("permission-denied", country ? `perps.fun isn't available in your country (${country}).` : "We couldn't confirm your country, so trading is blocked.");
  }
  return country!;
}
