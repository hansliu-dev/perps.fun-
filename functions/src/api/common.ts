import { logger } from "firebase-functions";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { REGION, TM_API_KEY, TM_SIGNER_KEY } from "../config.js";
import { TmApiError } from "../tm/client.js";
import { OrderNotCreatedError } from "../tm/orders.js";
import { getUser, type UserDoc } from "../store.js";

export const callableOptions = { region: REGION, secrets: [TM_API_KEY, TM_SIGNER_KEY], timeoutSeconds: 120, enforceAppCheck: false };

export function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
}

export async function requireAccount(uid: string): Promise<UserDoc> {
  const user = await getUser(uid);
  if (!user?.tmUserId) throw new HttpsError("failed-precondition", "Your trading account isn't set up yet. Reload the page.");
  return user;
}

export function num(value: unknown, name: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpsError("invalid-argument", `${name} must be a number between ${min} and ${max}.`);
  return n;
}

// Turns TrueMarkets errors into messages a user can act on; everything else is logged and hidden.
export function toHttpsError(err: unknown): HttpsError {
  if (err instanceof HttpsError) return err;
  if (err instanceof OrderNotCreatedError) return new HttpsError("failed-precondition", "Not enough USDC in your trading balance for this order.");
  if (err instanceof TmApiError) {
    logger.warn("TrueMarkets error", { status: err.status, body: err.body });
    if (err.type === "insufficient_balance") return new HttpsError("failed-precondition", "Not enough USDC in your trading balance.");
    if (err.type === "quote_stale") return new HttpsError("aborted", "The price moved before the order landed. Try again.");
    if (err.status === 403) return new HttpsError("permission-denied", "TrueMarkets refused this request (asset not available here, or amount over balance).");
    if (err.status === 422) return new HttpsError("invalid-argument", "TrueMarkets rejected the order (check leverage and size).");
    return new HttpsError("unavailable", "TrueMarkets is unavailable right now. Try again shortly.");
  }
  logger.error(err);
  return new HttpsError("internal", "Something went wrong.");
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttpsError(err);
  }
}
