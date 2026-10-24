import type { TmClient, TmPosition } from "../tm/client.js";
import type { SignerKey } from "../tm/keys.js";
import { placeOrder } from "../tm/orders.js";
import { diffPositions, type LeaderEvent, type PositionSnap } from "./diff.js";
import { addLot, ownPositions, reconcile, removeLot, type Ledger } from "./ledger.js";
import { planCopy, planLedgerCopy, type AssetInfo } from "./plan.js";
import type { FollowSettings } from "./sizing.js";

// A follow copies one leader into the follower's own account; the ledger (ledger.ts) tracks which part
// of each position came from which leader. Follows created before that change used a dedicated
// TrueMarkets user per leader (`copyAccountUserId`) and keep working that way until they're stopped.
export interface Follow extends FollowSettings {
  id: string;
  followerUid: string;
  leaderUid: string;
  active: boolean;
  followerTmUserId?: string;
  // Amount of the follower's account set aside for this leader; sizes proportional copies. No money moves.
  budgetUsd?: number;
  copyAccountUserId?: string;
}

export interface CopyExecution {
  followId: string;
  event: LeaderEvent;
  status: "filled" | "skipped" | "failed";
  orderId?: string;
  note: string;
}

export interface CopyStore {
  // Lease so two syncs of the same leader can't copy one change twice; null means another sync holds it.
  acquireLeaderLock(leaderUid: string): Promise<(() => Promise<void>) | null>;
  // Serializes everything that reads or changes one user's positions together with their ledger. Waits for it.
  acquireLedgerLock(uid: string): Promise<() => Promise<void>>;
  getLedger(uid: string): Promise<Ledger>;
  saveLedger(uid: string, ledger: Ledger): Promise<void>;
  getSnapshot(leaderUid: string): Promise<PositionSnap[] | null>;
  saveSnapshot(leaderUid: string, positions: PositionSnap[]): Promise<void>;
  listActiveFollows(leaderUid: string): Promise<Follow[]>;
  // Every change a leader makes to their own positions; feeds the trade log, chart markers and profiles.
  recordLeaderEvents(leaderUid: string, events: LeaderEvent[]): Promise<void>;
  recordExecution(execution: CopyExecution): Promise<void>;
}

export interface CopyDeps {
  tm: TmClient;
  signer: SignerKey;
  store: CopyStore;
  assets: (assetId: string) => Promise<AssetInfo | undefined>;
  concurrency?: number;
}

export function toSnap(p: TmPosition): PositionSnap {
  return {
    assetId: p.asset_id,
    symbol: p.symbol,
    side: p.side,
    size: Number(p.size),
    marginUsd: Number(p.margin_used),
    leverage: p.leverage,
    entryPrice: Number(p.entry_price),
  };
}

// Reads the leader's positions, keeps only their own part (copied trades are never copied onward),
// diffs it against the last snapshot, and mirrors every change into each follower's account.
// Call it after any order a leader places through the app, and on a schedule to catch TP/SL fills and liquidations.
export async function syncLeader(deps: CopyDeps, leaderUid: string, leaderUserId: string): Promise<CopyExecution[]> {
  const release = await deps.store.acquireLeaderLock(leaderUid);
  if (!release) return [];
  try {
    return await syncLocked(deps, leaderUid, leaderUserId);
  } finally {
    await release();
  }
}

// The user's positions and ledger, reconciled together under the ledger lock.
async function readOwn(deps: CopyDeps, uid: string, tmUserId: string) {
  const release = await deps.store.acquireLedgerLock(uid);
  try {
    const [positions, ledger] = await Promise.all([deps.tm.listPositions(tmUserId), deps.store.getLedger(uid)]);
    const all = positions.filter((p) => p.asset_id).map(toSnap);
    const rec = reconcile(ledger, all);
    if (rec.changed) await deps.store.saveLedger(uid, rec.ledger);
    return ownPositions(all, rec.ledger);
  } finally {
    await release();
  }
}

async function syncLocked(deps: CopyDeps, leaderUid: string, leaderUserId: string): Promise<CopyExecution[]> {
  const [own, portfolio, prev] = await Promise.all([readOwn(deps, leaderUid, leaderUserId), deps.tm.getPortfolio(leaderUserId), deps.store.getSnapshot(leaderUid)]);

  // First sight of a leader: record a baseline; don't copy positions opened before anyone followed.
  if (prev === null) {
    await deps.store.saveSnapshot(leaderUid, own);
    return [];
  }

  const events = diffPositions(prev, own, Number(portfolio.total_usd));
  await deps.store.saveSnapshot(leaderUid, own);
  if (!events.length) return [];
  await deps.store.recordLeaderEvents(leaderUid, events);

  const follows = await deps.store.listActiveFollows(leaderUid);
  const results: CopyExecution[] = [];
  const queue = [...follows];
  const workers = Array.from({ length: Math.min(deps.concurrency ?? 8, queue.length) }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      results.push(...(f.copyAccountUserId ? await copyToCopyAccount(deps, f, f.copyAccountUserId, events) : await copyIntoAccount(deps, f, events)));
    }
  });
  await Promise.all(workers);
  return results;
}

function recorder(deps: CopyDeps, follow: Follow, out: CopyExecution[]) {
  return async (event: LeaderEvent, e: Omit<CopyExecution, "followId" | "event">) => {
    const full = { followId: follow.id, event, ...e };
    out.push(full);
    await deps.store.recordExecution(full);
  };
}

const usdcAvailable = (balances: Array<{ symbol: string; available: string }>) =>
  // USDC on any network counts: TrueMarkets routes it into Hyperliquid margin when the order needs it.
  balances.filter((b) => b.symbol === "USDC").reduce((s, b) => s + Number(b.available), 0);

// Copies into the follower's own account and records the copied size against this leader.
async function copyIntoAccount(deps: CopyDeps, follow: Follow, events: LeaderEvent[]): Promise<CopyExecution[]> {
  const out: CopyExecution[] = [];
  const record = recorder(deps, follow, out);
  const tmUserId = follow.followerTmUserId;
  if (!tmUserId) {
    for (const event of events) await record(event, { status: "failed", note: "follower account missing" });
    return out;
  }
  const release = await deps.store.acquireLedgerLock(follow.followerUid);
  try {
    // Events run in order: a flip is "close" then "open" on the same asset.
    for (const event of events) {
      try {
        const asset = await deps.assets(event.assetId);
        if (!asset) {
          await record(event, { status: "skipped", note: "asset not tradable" });
          continue;
        }
        const [positions, portfolio, stored] = await Promise.all([deps.tm.listPositions(tmUserId), deps.tm.getPortfolio(tmUserId), deps.store.getLedger(follow.followerUid)]);
        let ledger = reconcile(stored, positions.map(toSnap)).ledger;
        const position = positions.find((p) => p.asset_id === event.assetId);
        const plan = planLedgerCopy(event, {
          budgetUsd: follow.budgetUsd ?? 0,
          settings: follow,
          availableUsd: usdcAvailable(portfolio.balances),
          position,
          lot: ledger[event.assetId]?.byLeader[follow.leaderUid] ?? 0,
          asset,
        });
        if ("skip" in plan) {
          await deps.store.saveLedger(follow.followerUid, ledger);
          await record(event, { status: "skipped", note: plan.skip });
          continue;
        }

        const order = await placeOrder(deps.tm, deps.signer, tmUserId, plan.order);
        const after = await deps.tm.listPositions(tmUserId);
        // Judge by what the position did, not only the reported status (which can lag a fill).
        const now = after.find((p) => p.asset_id === event.assetId);
        const before = position ? Number(position.size) : 0;
        const added = now && (!position || position.side === now.side) ? Number(now.size) - before : 0;
        const removed = before - (now && position && now.side === position.side ? Number(now.size) : 0);
        const filled = order.status === "complete" || order.status === "filled" || (plan.effect === "add" ? added > 1e-12 : removed > 1e-12);
        if (filled) {
          if (plan.effect === "add") {
            if (now && added > 0) ledger = addLot(ledger, event.assetId, now.side, follow.leaderUid, added);
          } else {
            ledger = removeLot(ledger, event.assetId, follow.leaderUid, plan.size);
          }
        }
        await deps.store.saveLedger(follow.followerUid, reconcile(ledger, after.map(toSnap)).ledger);
        await record(event, { status: filled ? "filled" : "failed", orderId: order.id ?? order.order_id, note: filled ? plan.note : `${plan.note}: ${order.status}` });
      } catch (err) {
        await record(event, { status: "failed", note: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    await release();
  }
  return out;
}

// Older follows: a dedicated account per leader, so its whole position is that leader's copy.
async function copyToCopyAccount(deps: CopyDeps, follow: Follow, accountId: string, events: LeaderEvent[]): Promise<CopyExecution[]> {
  const out: CopyExecution[] = [];
  const record = recorder(deps, follow, out);
  for (const event of events) {
    try {
      const asset = await deps.assets(event.assetId);
      if (!asset) {
        await record(event, { status: "skipped", note: "asset not tradable" });
        continue;
      }
      const [positions, portfolio] = await Promise.all([deps.tm.listPositions(accountId), deps.tm.getPortfolio(accountId)]);
      const account = { equityUsd: Number(portfolio.total_usd), availableUsd: usdcAvailable(portfolio.balances) };
      const plan = planCopy(event, follow, account, positions.find((p) => p.asset_id === event.assetId), asset);
      if ("skip" in plan) {
        await record(event, { status: "skipped", note: plan.skip });
        continue;
      }
      const order = await placeOrder(deps.tm, deps.signer, accountId, plan.order);
      const filled = order.status === "complete" || order.status === "filled";
      await record(event, { status: filled ? "filled" : "failed", orderId: order.id ?? order.order_id, note: filled ? plan.note : `${plan.note}: ${order.status}` });
    } catch (err) {
      await record(event, { status: "failed", note: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
