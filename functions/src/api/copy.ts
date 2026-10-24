import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { toSnap } from "../copy/engine.js";
import { reconcile, removeLot } from "../copy/ledger.js";
import { planLedgerCopy } from "../copy/plan.js";
import { MIN_NOTIONAL_USD } from "../copy/sizing.js";
import { assertEligible } from "../geo.js";
import { acquireLedgerLock, db, followId, getLedger, getUser, saveLedger, type FollowDoc, type UserDoc } from "../store.js";
import type { TmClient } from "../tm/client.js";
import type { SignerKey } from "../tm/keys.js";
import { placeOrder } from "../tm/orders.js";
import { perpAsset, tmRuntime, usdcBalances } from "../tm/runtime.js";
import { sendTransfer } from "../tm/transfers.js";
import { callableOptions, guarded, num, requireAccount, requireAuth } from "./common.js";
import { requestSync } from "./trade.js";

// Copying happens in the follower's own account: following moves no money. The budget is the share of
// the account set aside for this leader, and sizes each copy (they put in 10%, you put in 10% of it).
export const follow = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    await assertEligible(req);
    const me = await requireAccount(uid);
    const d = req.data as { leaderUid: string; budgetUsd: number };
    if (d.leaderUid === uid) throw new HttpsError("invalid-argument", "You can't copy yourself.");
    const leader = await getUser(String(d.leaderUid));
    if (!leader?.tmUserId) throw new HttpsError("not-found", "That trader doesn't exist.");
    const budget = num(d.budgetUsd, "Budget", { min: MIN_NOTIONAL_USD, max: 1_000_000 });

    const equity = Number((await tmRuntime().tm.getPortfolio(me.tmUserId)).total_usd);
    if (budget > equity) throw new HttpsError("failed-precondition", `Your account is worth $${equity.toFixed(2)}. Lower the budget or deposit more.`);

    const ref = db().collection("follows").doc(followId(uid, d.leaderUid));
    const existing = (await ref.get()).data() as FollowDoc | undefined;
    if (existing?.active && existing.copyAccountUserId) {
      throw new HttpsError("failed-precondition", "You're copying them through an older separate copy account. Stop copying first, then copy again.");
    }
    await ref.set(
      {
        followerUid: uid,
        leaderUid: d.leaderUid,
        leaderHandle: leader.handle,
        leaderAvatarUrl: leader.avatarUrl ?? null,
        followerTmUserId: me.tmUserId,
        budgetUsd: budget,
        maxLeverage: FieldValue.delete(),
        active: true,
        copyAccountUserId: FieldValue.delete(),
        copyWallets: FieldValue.delete(),
        ...(existing ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
    if (!existing?.active) {
      await db()
        .collection("leaders")
        .doc(d.leaderUid)
        .set({ tmUserId: leader.tmUserId, activeFollowers: FieldValue.increment(1) }, { merge: true });
    }
    return { followId: ref.id };
  }),
);

// Closes what was copied from one leader (in one market, or all of them), leaving the user's own part
// and other leaders' parts alone.
async function closeCopied(uid: string, tmUserId: string, leaderUid: string, assetId?: string) {
  const { tm, signer } = tmRuntime();
  const release = await acquireLedgerLock(uid);
  const closed: string[] = [];
  try {
    let positions = await tm.listPositions(tmUserId);
    let ledger = reconcile(await getLedger(uid), positions.map(toSnap)).ledger;
    for (const [aid, lots] of Object.entries(ledger)) {
      if ((assetId && aid !== assetId) || !lots.byLeader[leaderUid]) continue;
      const asset = await perpAsset(aid);
      const position = positions.find((p) => p.asset_id === aid);
      if (!asset || !position) continue;
      const plan = planLedgerCopy(
        { type: "close", assetId: aid, symbol: position.symbol, side: position.side },
        { budgetUsd: 0, settings: {}, availableUsd: 0, position, lot: lots.byLeader[leaderUid], asset },
      );
      if ("skip" in plan) continue;
      const order = await placeOrder(tm, signer, tmUserId, plan.order);
      if (order.status === "complete" || order.status === "filled") {
        ledger = removeLot(ledger, aid, leaderUid, "all");
        closed.push(position.symbol);
      }
      positions = await tm.listPositions(tmUserId);
    }
    await saveLedger(uid, reconcile(ledger, positions.map(toSnap)).ledger);
  } finally {
    await release();
  }
  return closed;
}

// Close one copied share by hand: the follower's own decision, whatever the leader does next.
export const closeCopyLot = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    await assertEligible(req);
    const me = await requireAccount(uid);
    const { leaderUid, assetId } = req.data as { leaderUid: string; assetId: string };
    const closed = await closeCopied(uid, me.tmUserId, String(leaderUid), String(assetId));
    if (!closed.length) throw new HttpsError("not-found", "There's no copied position to close here.");
    await requestSync(uid);
    return { closed };
  }),
);

export const unfollow = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    const me = await requireAccount(uid);
    const { leaderUid, closePositions } = req.data as { leaderUid: string; closePositions: boolean };
    const ref = db().collection("follows").doc(followId(uid, String(leaderUid)));
    const f = (await ref.get()).data() as FollowDoc | undefined;
    if (!f) throw new HttpsError("not-found", "You aren't copying this trader.");

    if (f.active) {
      await ref.update({ active: false });
      await db().collection("leaders").doc(f.leaderUid).set({ activeFollowers: FieldValue.increment(-1) }, { merge: true });
    }
    if (f.copyAccountUserId) return { ok: true, ...(await retireCopyAccount(f.copyAccountUserId, me.wallets, closePositions)) };

    const closed = closePositions ? await closeCopied(uid, me.tmUserId, f.leaderUid) : [];
    if (closed.length) await requestSync(uid);
    return { ok: true, closed };
  }),
);

// ---- Older follows that used a separate copy account: close it out and bring the USDC home. ----

async function retireCopyAccount(accountId: string, homeWallets: UserDoc["wallets"], closePositions: boolean) {
  const { tm, signer } = tmRuntime();
  if (closePositions) {
    for (const p of await tm.listPositions(accountId)) {
      await placeOrder(tm, signer, accountId, { asset_id: p.asset_id, side: p.side === "long" ? "sell" : "buy", type: "market", qty: p.size, qty_unit: "base", reduce_only: true });
    }
  }
  // Released margin can take a moment to show as available.
  let result: Awaited<ReturnType<typeof sweepUsdc>> = { returned: [], notReturned: [] };
  for (let i = 0; i < 5 && !result.returned.length; i++) {
    result = await sweepUsdc(tm, signer, accountId, homeWallets);
    if (!result.returned.length) await new Promise((r) => setTimeout(r, 2000));
  }
  return result;
}

// Each USDC balance goes to the home wallet's address on that same network (transfers never cross chains).
async function sweepUsdc(tm: TmClient, signer: SignerKey, fromUserId: string, toWallets: UserDoc["wallets"]) {
  const addressFor = (chain: string) => toWallets.find((w) => w.chain_family === (chain === "solana" ? "solana" : "evm"))?.address;
  const returned: Array<{ chain: string; amount: string }> = [];
  const notReturned: string[] = [];
  for (const b of usdcBalances(await tm.getBalances(fromUserId))) {
    const chain = b.chain ?? "";
    const qty = (Math.floor(Number(b.available) * 100) / 100).toFixed(2);
    const to = addressFor(chain);
    if (!(Number(qty) > 0) || !to) continue;
    try {
      await sendTransfer(tm, signer, fromUserId, { asset_id: b.asset_id, qty, to });
      returned.push({ chain, amount: qty });
    } catch (err) {
      logger.warn("sweep failed", { chain, err: String(err) });
      notReturned.push(chain);
    }
  }
  return { returned, notReturned };
}
