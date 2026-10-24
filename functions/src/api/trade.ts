import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { floorSize } from "../copy/plan.js";
import { MIN_NOTIONAL_USD } from "../copy/sizing.js";
import { assertEligible } from "../geo.js";
import { toSnap } from "../copy/engine.js";
import { lotsTotal, reconcile } from "../copy/ledger.js";
import { acquireLedgerLock, db, getLedger, saveLedger } from "../store.js";
import { placeOrder } from "../tm/orders.js";
import { perpAsset, tmRuntime } from "../tm/runtime.js";
import { callableOptions, guarded, num, requireAccount, requireAuth } from "./common.js";

// Any change to a user's positions asks the copy engine to diff them (jobs.ts → syncLeader).
export async function requestSync(uid: string) {
  await db().collection("syncRequests").doc(uid).set({ at: FieldValue.serverTimestamp() });
}

export const placePerpOrder = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    await assertEligible(req);
    const user = await requireAccount(uid);
    const d = req.data as { assetId: string; side: "long" | "short"; marginUsd: number; leverage: number; takeProfit?: number; stopLoss?: number };

    const asset = await perpAsset(String(d.assetId));
    if (!asset) throw new HttpsError("invalid-argument", "Unknown market.");
    if (d.side !== "long" && d.side !== "short") throw new HttpsError("invalid-argument", "Side must be long or short.");
    const leverage = Math.floor(num(d.leverage, "Leverage", { min: 1, max: asset.maxLeverage }));
    const margin = num(d.marginUsd, "Margin", { min: 0.01, max: 1_000_000 });
    if (margin * leverage < MIN_NOTIONAL_USD) throw new HttpsError("invalid-argument", `Position size (margin × leverage) must be at least $${MIN_NOTIONAL_USD}.`);

    const { tm, signer } = tmRuntime();
    // Held so a copy landing at the same moment can't be mistaken for this order (or vice versa).
    const release = await acquireLedgerLock(uid);
    let order;
    try {
      order = await placeOrder(tm, signer, user.tmUserId, {
        asset_id: asset.id,
        side: d.side === "long" ? "buy" : "sell",
        type: "market",
        qty: margin.toFixed(2),
        qty_unit: "quote",
        leverage,
      });
    } finally {
      await release();
    }
    await requestSync(uid);

    // TP/SL are reduce-only trigger orders on the resulting position.
    const warnings: string[] = [];
    if ((d.takeProfit || d.stopLoss) && (order.status === "complete" || order.status === "filled")) {
      const pos = (await tm.listPositions(user.tmUserId)).find((p) => p.asset_id === asset.id);
      for (const [type, price] of [["take_profit", d.takeProfit], ["stop_loss", d.stopLoss]] as const) {
        if (!price || !pos) continue;
        try {
          await placeOrder(tm, signer, user.tmUserId, {
            asset_id: asset.id,
            side: pos.side === "long" ? "sell" : "buy",
            type: "market",
            qty: pos.size,
            qty_unit: "base",
            trigger: { type, price: String(price) },
          });
        } catch (err) {
          logger.warn("trigger order failed", { type, err: String(err) });
          warnings.push(`${type === "take_profit" ? "Take profit" : "Stop loss"} wasn't set: it must be on the ${type === "take_profit" ? "profitable" : "losing"} side of the price.`);
        }
      }
    }
    return { orderId: order.id ?? order.order_id, status: order.status, warnings };
  }),
);

export const closePosition = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    await assertEligible(req);
    const user = await requireAccount(uid);
    const { assetId, fraction } = req.data as { assetId: string; fraction: number };
    const f = num(fraction, "Fraction", { min: 0.01, max: 1 });
    const asset = await perpAsset(String(assetId));
    if (!asset) throw new HttpsError("invalid-argument", "Unknown market.");

    // Closes the user's own part only; copied shares close with their leader or via closeCopyLot.
    const { tm, signer } = tmRuntime();
    const release = await acquireLedgerLock(uid);
    let order;
    try {
      const positions = await tm.listPositions(user.tmUserId);
      const pos = positions.find((p) => p.asset_id === asset.id);
      if (!pos) throw new HttpsError("not-found", "No open position in this market.");
      const ledger = reconcile(await getLedger(uid), positions.map(toSnap)).ledger;
      await saveLedger(uid, ledger);
      const copied = lotsTotal(ledger[asset.id]);
      const own = Math.max(0, Number(pos.size) - copied);
      if (own <= 0) throw new HttpsError("failed-precondition", "This position is all copied. Close the copied shares instead.");
      const whole = f >= 0.999 && copied <= 0;
      const qty = whole ? pos.size : floorSize(own * f, asset.sizeDecimals);
      if (!(Number(qty) > 0)) throw new HttpsError("invalid-argument", "That's smaller than the minimum size.");
      order = await placeOrder(tm, signer, user.tmUserId, {
        asset_id: asset.id,
        side: pos.side === "long" ? "sell" : "buy",
        type: "market",
        qty,
        qty_unit: "base",
        reduce_only: true,
      });
    } finally {
      await release();
    }
    await requestSync(uid);
    return { orderId: order.id ?? order.order_id, status: order.status };
  }),
);
