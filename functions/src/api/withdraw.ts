import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { DAILY_WITHDRAWAL_LIMIT_USD, WITHDRAWAL_REAUTH_SECONDS } from "../config.js";
import { assertEligible } from "../geo.js";
import { db } from "../store.js";
import { TmApiError } from "../tm/client.js";
import { tmRuntime, usdcBalances, usdcListings } from "../tm/runtime.js";
import { sendTransfer } from "../tm/transfers.js";
import { callableOptions, guarded, num, requireAccount, requireAuth } from "./common.js";

const EVM = /^0x[a-fA-F0-9]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validAddress(chain: string, to: string): boolean {
  return chain === "solana" ? SOLANA.test(to) : EVM.test(to);
}

// Sends USDC from the user's main account to an address on the same chain. Transfers are final.
export const withdraw = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    await assertEligible(req);
    const user = await requireAccount(uid);

    const authTime = Number(req.auth?.token.auth_time ?? 0);
    if (Date.now() / 1000 - authTime > WITHDRAWAL_REAUTH_SECONDS) {
      throw new HttpsError("unauthenticated", "For your security, sign in again to withdraw.", { reauth: true });
    }

    const { assetId, amount, to } = req.data as { assetId: string; amount: number; to: string };
    const listing = (await usdcListings()).find((a) => a.id === assetId);
    if (!listing?.chain) throw new HttpsError("invalid-argument", "Pick which USDC balance to withdraw from.");
    const address = String(to ?? "").trim();
    if (!validAddress(listing.chain, address)) {
      throw new HttpsError("invalid-argument", listing.chain === "solana" ? "That isn't a Solana address." : "That isn't an EVM address (0x followed by 40 hex characters).");
    }
    const value = num(amount, "Amount", { min: 1, max: 1_000_000 });

    const { tm, signer } = tmRuntime();
    const bal = usdcBalances(await tm.getBalances(user.tmUserId)).find((b) => b.asset_id === assetId);
    if (!bal || Number(bal.available) < value) throw new HttpsError("failed-precondition", `Only $${Number(bal?.available ?? 0).toFixed(2)} is available on ${listing.chain}.`);

    const since = Timestamp.fromMillis(Date.now() - 24 * 3600_000);
    const recent = await db().collection("withdrawals").where("uid", "==", uid).where("createdAt", ">=", since).get();
    const used = recent.docs.filter((d) => d.get("status") !== "failed").reduce((s, d) => s + Number(d.get("amount")), 0);
    const limit = DAILY_WITHDRAWAL_LIMIT_USD.value();
    if (used + value > limit) throw new HttpsError("resource-exhausted", `Daily withdrawal limit is $${limit}. You can withdraw $${Math.max(0, limit - used).toFixed(2)} more today.`);

    const ref = db().collection("withdrawals").doc();
    await ref.set({ uid, assetId, chain: listing.chain, to: address, amount: value, status: "pending", createdAt: FieldValue.serverTimestamp() });
    try {
      const t = await sendTransfer(tm, signer, user.tmUserId, { asset_id: assetId, qty: value.toFixed(2), to: address });
      await ref.update({ status: t.status, transferId: t.id, explorerUrl: t.explorer_url ?? null, sent: t.sent ?? null });
      return { status: t.status, explorerUrl: t.explorer_url ?? null };
    } catch (err) {
      await ref.update({ status: "failed", error: err instanceof TmApiError ? (err.type ?? `HTTP ${err.status}`) : String(err) });
      throw err;
    }
  }),
);
