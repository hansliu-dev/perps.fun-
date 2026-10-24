import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import type { LeaderEvent, PositionSnap } from "./copy/diff.js";
import type { CopyExecution, CopyStore, Follow } from "./copy/engine.js";
import type { Ledger } from "./copy/ledger.js";

// Firestore layout (all writes are server-only; see firestore.rules):
//   users/{uid}            profile + main TrueMarkets account
//   follows/{follower__leader}  copy settings + dedicated copy account
//   leaders/{uid}          leaders with followers, for the scheduled sync
//   snapshots/{uid}        last seen positions of a user's main account
//   trades/{id}            leader position changes (feed, chart markers)
//   copyExecutions/{id}    what each copy did, or why it was skipped
//   ledgers/{uid}          which part of each position was copied from which leader
//   withdrawals/{id}       outgoing transfers
export const db = () => getFirestore();

export interface UserDoc {
  handle: string;
  displayName?: string;
  displayNameLower?: string; // for prefix search
  avatarUrl?: string;
  tmUserId: string;
  wallets: Array<{ address: string; chain_family: "solana" | "evm" }>;
  country?: string;
  createdAt: Timestamp;
}

export interface FollowDoc extends Omit<Follow, "id"> {
  leaderHandle: string;
  leaderAvatarUrl?: string;
  budgetUsd: number;
  copyWallets?: UserDoc["wallets"];
  equityUsd?: number;
  openPositions?: number;
  createdAt: Timestamp;
}

export const followId = (followerUid: string, leaderUid: string) => `${followerUid}__${leaderUid}`;

export async function getUser(uid: string): Promise<UserDoc | null> {
  const d = await db().collection("users").doc(uid).get();
  return d.exists ? (d.data() as UserDoc) : null;
}

const LOCK_TTL_MS = 2 * 60_000;

// Firestore lease: returns a release function, or null if someone else holds it.
async function tryLock(name: string, ttlMs = LOCK_TTL_MS): Promise<(() => Promise<void>) | null> {
  const ref = db().collection("locks").doc(name);
  const token = `${Date.now()}_${Math.random()}`;
  const ok = await db().runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const until = cur.get("until") as number | undefined;
    if (until && until > Date.now()) return false;
    tx.set(ref, { until: Date.now() + ttlMs, token });
    return true;
  });
  if (!ok) return null;
  return async () => {
    await db().runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (cur.get("token") === token) tx.delete(ref);
    });
  };
}

export async function acquireLedgerLock(uid: string, waitMs = 90_000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = await tryLock(`ledger_${uid}`);
    if (release) return release;
    if (Date.now() > deadline) throw new Error("account is busy, try again");
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
  }
}

export async function getLedger(uid: string): Promise<Ledger> {
  return ((await db().collection("ledgers").doc(uid).get()).get("lots") as Ledger | undefined) ?? {};
}

export async function saveLedger(uid: string, ledger: Ledger) {
  await db().collection("ledgers").doc(uid).set({ lots: ledger, at: FieldValue.serverTimestamp() });
}

export const firestoreCopyStore: CopyStore = {
  acquireLeaderLock: (leaderUid) => tryLock(`leader_${leaderUid}`),
  acquireLedgerLock: (uid) => acquireLedgerLock(uid),
  getLedger,
  saveLedger,

  async getSnapshot(leaderUid) {
    const d = await db().collection("snapshots").doc(leaderUid).get();
    return d.exists ? (d.get("positions") as PositionSnap[]) : null;
  },

  async saveSnapshot(leaderUid, positions) {
    await db().collection("snapshots").doc(leaderUid).set({ positions, at: FieldValue.serverTimestamp() });
  },

  async listActiveFollows(leaderUid) {
    const snap = await db().collection("follows").where("leaderUid", "==", leaderUid).where("active", "==", true).get();
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as FollowDoc) }));
  },

  async recordLeaderEvents(leaderUid, events: LeaderEvent[]) {
    const user = await getUser(leaderUid);
    const batch = db().batch();
    for (const e of events) {
      batch.set(db().collection("trades").doc(), {
        uid: leaderUid,
        handle: user?.handle ?? "",
        avatarUrl: user?.avatarUrl ?? null,
        action: e.type,
        assetId: e.assetId,
        symbol: e.symbol,
        side: e.side,
        leverage: "leverage" in e ? e.leverage : null,
        fillPrice: e.type === "open" ? e.entryPrice : null,
        marginPct: e.type === "open" ? e.marginPct : null,
        fraction: e.type === "reduce" ? e.fraction : null,
        ts: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  },

  async recordExecution(e: CopyExecution) {
    const follow = await db().collection("follows").doc(e.followId).get();
    await db().collection("copyExecutions").add({
      ...e,
      followerUid: follow.get("followerUid") ?? null,
      leaderUid: follow.get("leaderUid") ?? null,
      ts: FieldValue.serverTimestamp(),
    });
  },
};
