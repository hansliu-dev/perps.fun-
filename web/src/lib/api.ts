import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "./firebase";

// Must match REGION in functions/src/config.ts.
const FUNCTIONS_REGION = "europe-west1";

// Thin wrappers over the Cloud Functions callables that hold all TrueMarkets credentials.
async function call<Req, Res>(name: string, data: Req): Promise<Res> {
  const app = firebaseApp();
  if (!app) throw new Error("Backend not configured: add NEXT_PUBLIC_FIREBASE_* to web/.env.local");
  const res = await httpsCallable<Req, Res>(getFunctions(app, FUNCTIONS_REGION), name, { timeout: 150_000 })(data);
  return res.data;
}

export interface Wallet {
  wallets: Array<{ address: string; chain_family: "solana" | "evm" }>;
  balances: Array<{ assetId: string; chain: string; available: string; total: string; trading: boolean }>;
}

export interface PlaceOrderInput {
  assetId: string;
  symbol: string;
  side: "long" | "short";
  marginUsd: number;
  leverage: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface Position {
  asset_id: string;
  symbol: string;
  side: "long" | "short";
  size: string;
  entry_price: string;
  mark_price: string;
  liquidation_price: string | null;
  margin_used: string;
  unrealized_pnl: string;
  return_on_equity: string;
  leverage: number;
}

export interface Portfolio {
  total_usd: string;
  cash_usd: string;
  unrealized_pnl_usd: string;
  change_24h_pct: string;
  positions: Position[];
  // Which part of each position (base units) was copied from which leader.
  lots?: Array<{ assetId: string; leaderUid: string; leaderHandle: string; size: number }>;
  // Positions still held in older separate copy accounts.
  copies?: Array<{ leaderUid: string; leaderHandle: string; positions: Position[] }>;
}

export const api = {
  onboard: () => call<Record<string, never>, { handle: string }>("onboard", {}),
  placeOrder: (input: PlaceOrderInput) => call<PlaceOrderInput, { orderId: string; status: string; warnings: string[] }>("placePerpOrder", input),
  // Closes part of your own share of a position; copied shares are untouched.
  closePosition: (input: { assetId: string; fraction: number }) => call<typeof input, { orderId: string; status: string }>("closePosition", input),
  // Closes the share of a position copied from one trader, on your own decision.
  closeCopyLot: (input: { assetId: string; leaderUid: string }) => call<typeof input, { closed: string[] }>("closeCopyLot", input),
  getPortfolio: () => call<Record<string, never>, Portfolio>("getPortfolio", {}),
  submitThesis: (input: { symbol: string; period: string; imageDataUrl: string; overlays: unknown[]; caption?: string }) =>
    call<typeof input, { thesisId: string }>("submitThesis", input),
  getWallet: () => call<Record<string, never>, Wallet>("getWallet", {}),
  updateProfile: (input: { displayName?: string; avatarDataUrl?: string }) => call<typeof input, { displayName?: string; avatarUrl?: string }>("updateProfile", input),
  // What TrueMarkets allows from the backend's own location (perps must be listed).
  serverAvailability: () => call<Record<string, never>, { country: string; allowed_product_types: string[] }>("serverAvailability", {}),
  // Same-chain USDC transfer out of the main account. Needs a sign-in from the last 10 minutes.
  withdraw: (input: { assetId: string; amount: number; to: string }) => call<typeof input, { status: string; explorerUrl: string | null }>("withdraw", input),
  // Starts copying in your own account. `budgetUsd` sizes the copies; no money moves.
  follow: (input: { leaderUid: string; budgetUsd: number }) =>
    call<typeof input, { followId: string }>("follow", input),
  // Stops copying; optionally closes what was copied from them.
  unfollow: (input: { leaderUid: string; closePositions: boolean }) => call<typeof input, { ok: true }>("unfollow", input),
};
