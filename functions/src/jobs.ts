import { logger } from "firebase-functions";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION, TM_API_KEY, TM_SIGNER_KEY } from "./config.js";
import { syncLeader, type CopyDeps } from "./copy/engine.js";
import { db, firestoreCopyStore, getLedger, getUser, type FollowDoc } from "./store.js";
import { perpAsset, tmRuntime } from "./tm/runtime.js";

const jobOptions = { region: REGION, secrets: [TM_API_KEY, TM_SIGNER_KEY], timeoutSeconds: 300 };

function deps(): CopyDeps {
  const { tm, signer } = tmRuntime();
  return { tm, signer, store: firestoreCopyStore, assets: perpAsset, concurrency: 8 };
}

async function syncUser(uid: string) {
  const user = await getUser(uid);
  if (!user?.tmUserId) return;
  const results = await syncLeader(deps(), uid, user.tmUserId);
  if (results.length) logger.info("copied", { leader: uid, results: results.map((r) => `${r.followId}:${r.status}`) });
}

// Runs right after a user's own order (trade.ts writes syncRequests/{uid}).
export const onSyncRequest = onDocumentWritten({ ...jobOptions, document: "syncRequests/{uid}" }, async (event) => {
  if (!event.data?.after.exists) return;
  await syncUser(event.params.uid);
});

// Catches what no order of ours caused (TP/SL fills, liquidations) and keeps every user's public
// position snapshot fresh for live PnL. Users with followers also get those changes copied.
export const syncLeaders = onSchedule({ ...jobOptions, schedule: "every 1 minutes" }, async () => {
  const users = await db().collection("users").select().get();
  const queue = users.docs.map((d) => d.id);
  await Promise.all(
    Array.from({ length: Math.min(5, queue.length) }, async () => {
      for (let uid = queue.shift(); uid; uid = queue.shift()) {
        await syncUser(uid).catch((err) => logger.error("sync failed", { uid, err: String(err) }));
      }
    }),
  );
});

// Keeps each follow's numbers fresh for the portfolio page: the value of what's been copied from that
// leader (budget plus the copied shares' PnL), and how many markets are open with them.
export const refreshFollowStats = onSchedule({ ...jobOptions, schedule: "every 5 minutes" }, async () => {
  const { tm } = tmRuntime();
  const follows = await db().collection("follows").where("active", "==", true).get();
  for (const doc of follows.docs) {
    const f = doc.data() as FollowDoc;
    try {
      if (f.copyAccountUserId) {
        const p = await tm.getPortfolio(f.copyAccountUserId);
        await doc.ref.update({ equityUsd: Number(p.total_usd), openPositions: p.positions.length });
        continue;
      }
      if (!f.followerTmUserId) continue;
      const [positions, ledger] = await Promise.all([tm.listPositions(f.followerTmUserId), getLedger(f.followerUid)]);
      let pnl = 0;
      let open = 0;
      for (const [assetId, lots] of Object.entries(ledger)) {
        const lot = lots.byLeader[f.leaderUid];
        const pos = positions.find((p) => p.asset_id === assetId);
        if (!lot || !pos || Number(pos.size) <= 0) continue;
        pnl += (Math.min(lot, Number(pos.size)) / Number(pos.size)) * Number(pos.unrealized_pnl);
        open++;
      }
      await doc.ref.update({ equityUsd: (f.budgetUsd ?? 0) + pnl, openPositions: open });
    } catch (err) {
      logger.warn("follow stats failed", { follow: doc.id, err: String(err) });
    }
  }
});
