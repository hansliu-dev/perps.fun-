import { TM_API_KEY, TM_BASE, TM_SIGNER_KEY } from "../config.js";
import type { AssetInfo } from "../copy/plan.js";
import { TokenProvider } from "./auth.js";
import { TmClient, type TmAsset, type TmBalance } from "./client.js";
import { loadApiKey, loadSignerKey, type SignerKey } from "./keys.js";

// One client per function instance; the token provider re-mints the org token before it expires.
let runtime: { tm: TmClient; signer: SignerKey } | undefined;

export function tmRuntime() {
  if (!runtime) {
    const key = loadApiKey(JSON.parse(TM_API_KEY.value()));
    runtime = {
      tm: new TmClient(TM_BASE, new TokenProvider(TM_BASE, key)),
      signer: loadSignerKey(JSON.parse(TM_SIGNER_KEY.value())),
    };
  }
  return runtime;
}

let catalog: { at: number; perps: TmAsset[]; spot: TmAsset[] } | undefined;

async function loadCatalog() {
  if (catalog && Date.now() - catalog.at < 5 * 60_000) return catalog;
  const { tm } = tmRuntime();
  const [perps, spot] = await Promise.all([tm.listAssets({ product_type: "perp" }), tm.listAssets()]);
  catalog = { at: Date.now(), perps: perps.filter((a) => a.type === "perp"), spot };
  return catalog;
}

export async function perpAsset(assetId: string): Promise<(TmAsset & AssetInfo) | undefined> {
  const a = (await loadCatalog()).perps.find((p) => p.id === assetId && p.status === "active");
  if (!a) return undefined;
  return { ...a, sizeDecimals: a.decimals ?? 4, maxLeverage: a.perp?.max_leverage ?? 1 };
}

export async function usdcListings(): Promise<TmAsset[]> {
  return (await loadCatalog()).spot.filter((a) => a.symbol === "USDC" && a.venue === "defi");
}

// USDC that backs perp margin lives on Hyperliquid (HyperCore). Prefer those balances when funding copy accounts.
export const TRADING_CHAINS = ["hypercore-perp", "hypercore-spot"];

export function usdcBalances(balances: TmBalance[]): TmBalance[] {
  return balances.filter((b) => b.symbol === "USDC" && b.venue === "defi");
}
