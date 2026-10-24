import { FieldValue } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { assertEligible } from "../geo.js";
import { logger } from "firebase-functions";
import { toSnap } from "../copy/engine.js";
import { reconcile } from "../copy/ledger.js";
import { db, getLedger, getUser, type FollowDoc, type UserDoc } from "../store.js";
import { TRADING_CHAINS, tmRuntime, usdcBalances } from "../tm/runtime.js";
import { callableOptions, guarded, requireAccount, requireAuth } from "./common.js";

function baseHandle(name: string | undefined, email: string | undefined): string {
  const raw = (name || email?.split("@")[0] || "trader").toLowerCase().replace(/[^a-z0-9_]/g, "");
  return (raw || "trader").slice(0, 15);
}

// Claims a unique handle (handles/{handle} → uid).
async function claimHandle(uid: string, base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const handle = i === 0 ? base : `${base.slice(0, 11)}${Math.floor(1000 + Math.random() * 9000)}`;
    const ref = db().collection("handles").doc(handle);
    const ok = await db().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (cur.exists && cur.get("uid") !== uid) return false;
      tx.set(ref, { uid });
      return true;
    });
    if (ok) return handle;
  }
  throw new Error("could not allocate a handle");
}

// First sign-in: creates the user's TrueMarkets account (idempotent on external_ref_id = Firebase uid).
export const onboard = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    const country = await assertEligible(req);
    const existing = await getUser(uid);
    if (existing?.tmUserId && existing.wallets.length) {
      if (existing.displayNameLower === undefined) {
        await db().collection("users").doc(uid).update({ displayNameLower: (existing.displayName ?? existing.handle).toLowerCase() });
      }
      return { handle: existing.handle };
    }

    const { tm, signer } = tmRuntime();
    let tmUser = await tm.createUser(uid, signer.publicKeyHex);
    for (let i = 0; i < 5 && !tmUser.wallets.length; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      tmUser = await tm.getUser(tmUser.user_id);
    }

    const handle = existing?.handle ?? (await claimHandle(uid, baseHandle(req.auth?.token.name as string | undefined, req.auth?.token.email)));
    const displayName = existing?.displayName ?? (req.auth?.token.name as string | undefined) ?? handle;
    const doc: Partial<UserDoc> = {
      handle,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      avatarUrl: (req.auth?.token.picture as string | undefined) ?? undefined,
      tmUserId: tmUser.user_id,
      wallets: tmUser.wallets,
      country,
    };
    await db()
      .collection("users")
      .doc(uid)
      .set({ ...doc, ...(existing ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
    return { handle };
  }),
);

// The account, which part of each position was copied from whom (`lots`), and positions still held in
// older separate copy accounts (`copies`).
export const getPortfolio = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    const user = await requireAccount(uid);
    const { tm } = tmRuntime();
    const follows = await db().collection("follows").where("followerUid", "==", uid).get();
    const handles = new Map(follows.docs.map((d) => [d.get("leaderUid") as string, d.get("leaderHandle") as string]));
    const [portfolio, ledger, copies] = await Promise.all([
      tm.getPortfolio(user.tmUserId),
      getLedger(uid),
      Promise.all(
        follows.docs
          .filter((d) => d.get("active") === true && d.get("copyAccountUserId"))
          .map(async (d) => {
            const f = d.data() as FollowDoc;
            const positions = await tm.listPositions(f.copyAccountUserId!).catch((err) => {
              logger.warn("copy positions failed", { follow: d.id, err: String(err) });
              return [];
            });
            return { leaderUid: f.leaderUid, leaderHandle: f.leaderHandle, positions };
          }),
      ),
    ]);
    const live = reconcile(ledger, portfolio.positions.map(toSnap)).ledger;
    const lots = Object.entries(live).flatMap(([assetId, l]) =>
      Object.entries(l.byLeader).map(([leaderUid, size]) => ({ assetId, leaderUid, leaderHandle: handles.get(leaderUid) ?? "trader", size })),
    );
    return { ...portfolio, lots, copies };
  }),
);

// Deposit addresses and USDC balances per chain. Only Hyperliquid (HyperCore) USDC backs perp margin.
export const getWallet = onCall(callableOptions, (req) =>
  guarded(async () => {
    const uid = requireAuth(req);
    const user = await requireAccount(uid);
    const { tm } = tmRuntime();
    let wallets = user.wallets;
    if (!wallets.length) {
      wallets = (await tm.getUser(user.tmUserId)).wallets;
      if (wallets.length) await db().collection("users").doc(uid).update({ wallets });
    }
    const balances = usdcBalances(await tm.getBalances(user.tmUserId)).map((b) => ({
      assetId: b.asset_id,
      chain: b.chain ?? "",
      available: b.available,
      total: b.total,
      trading: TRADING_CHAINS.includes(b.chain ?? ""),
    }));
    return { wallets, balances };
  }),
);
