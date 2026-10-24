import { describe, expect, it } from "vitest";
import { diffPositions, type PositionSnap } from "../src/copy/diff.js";
import { syncLeader, type CopyExecution, type CopyStore, type Follow } from "../src/copy/engine.js";
import { floorSize, planCopy } from "../src/copy/plan.js";
import { addLot, ownPositions, reconcile, removeLot, type Ledger } from "../src/copy/ledger.js";
import type { CreateOrderRequest, TmClient, TmPortfolio, TmPosition } from "../src/tm/client.js";
import { generateSignerKeyFile, loadSignerKey } from "../src/tm/keys.js";

const BTC = "btc-asset";
const snap = (side: "long" | "short", size: number, marginUsd: number, leverage = 10): PositionSnap => ({ assetId: BTC, symbol: "BTC", side, size, marginUsd, leverage, entryPrice: 80_000 });

describe("diffPositions", () => {
  it("open: margin as a share of leader equity", () => {
    expect(diffPositions([], [snap("long", 0.0125, 100)], 1_000)).toEqual([
      { type: "open", assetId: BTC, symbol: "BTC", side: "long", leverage: 10, marginPct: 0.1, entryPrice: 80_000 },
    ]);
  });

  it("increase / reduce / close", () => {
    expect(diffPositions([snap("long", 1, 100)], [snap("long", 1.5, 150)], 1_000)).toMatchObject([{ type: "increase", marginGrowth: 0.5 }]);
    expect(diffPositions([snap("long", 1, 100)], [snap("long", 0.25, 25)], 1_000)).toMatchObject([{ type: "reduce", fraction: 0.75 }]);
    expect(diffPositions([snap("long", 1, 100)], [], 1_000)).toMatchObject([{ type: "close", side: "long" }]);
  });

  it("flip long → short is close then open", () => {
    expect(diffPositions([snap("long", 1, 100)], [snap("short", 1, 200)], 1_000).map((e) => e.type)).toEqual(["close", "open"]);
  });

  it("no change, no events", () => {
    expect(diffPositions([snap("long", 1, 100)], [snap("long", 1, 101)], 1_000)).toEqual([]);
  });
});

describe("planCopy", () => {
  const asset = { id: BTC, sizeDecimals: 5, maxLeverage: 40 };
  const account = { equityUsd: 1_000, availableUsd: 1_000 };
  const pos = (size: string): TmPosition => ({ asset_id: BTC, venue: "defi", symbol: "BTC", side: "long", size, entry_price: "80000", mark_price: "80000", liquidation_price: null, margin_used: "100", unrealized_pnl: "0", return_on_equity: "0", leverage: 10 });

  it("reduce rounds size down to the asset's size decimals", () => {
    const plan = planCopy({ type: "reduce", assetId: BTC, symbol: "BTC", side: "long", fraction: 1 / 3 }, {}, account, pos("0.01250"), asset);
    expect(plan).toMatchObject({ order: { qty: "0.00416", qty_unit: "base", reduce_only: true, side: "sell" } });
  });

  it("close sends the exact position size", () => {
    const plan = planCopy({ type: "close", assetId: BTC, symbol: "BTC", side: "long" }, {}, account, pos("0.01250"), asset);
    expect(plan).toMatchObject({ order: { qty: "0.01250", reduce_only: true } });
  });

  it("skips a close when the copy never opened", () => {
    expect(planCopy({ type: "close", assetId: BTC, symbol: "BTC", side: "long" }, {}, account, undefined, asset)).toHaveProperty("skip");
  });

  it("floorSize", () => {
    expect(floorSize(0.123456, 2)).toBe("0.12");
    expect(floorSize(3, 0)).toBe("3");
  });
});

// Fake TrueMarkets with one positions book per user; market orders fill instantly at $80k.
function fakeTm(books: Record<string, TmPosition[]>, equity: Record<string, number>) {
  const orders: Array<{ userId: string; order: CreateOrderRequest }> = [];
  const tm = {
    async listPositions(userId: string) {
      return books[userId] ?? [];
    },
    async getPortfolio(userId: string): Promise<TmPortfolio> {
      // `equity` is total account value; like TrueMarkets' total_usd it already includes committed margin.
      const c = equity[userId] ?? 0;
      return { total_usd: String(c), balances_usd: String(c), cash_usd: String(c), change_24h_usd: "0", change_24h_pct: "0", unrealized_pnl_usd: "0", realized_pnl_usd: "0", balances: [{ symbol: "USDC", venue: "defi", total: String(c), available: String(c), held: "0", stable: true }], positions: books[userId] ?? [] };
    },
    async createOrder(userId: string, order: CreateOrderRequest) {
      orders.push({ userId, order });
      return { order_id: `o${orders.length}`, status: "complete" as const, payloads: [] };
    },
    async getOrder(_userId: string, id: string) {
      return { id, status: "complete" as const };
    },
  };
  return { tm: tm as unknown as TmClient, orders };
}

function memoryStore(follows: Follow[]) {
  const snaps = new Map<string, PositionSnap[]>();
  const executions: CopyExecution[] = [];
  const ledgers = new Map<string, Ledger>();
  const store: CopyStore = {
    async acquireLeaderLock() {
      return async () => {};
    },
    async acquireLedgerLock() {
      return async () => {};
    },
    async getLedger(uid) {
      return ledgers.get(uid) ?? {};
    },
    async saveLedger(uid, l) {
      ledgers.set(uid, l);
    },
    async getSnapshot(uid) {
      return snaps.get(uid) ?? null;
    },
    async saveSnapshot(uid, p) {
      snaps.set(uid, p);
    },
    async listActiveFollows(uid) {
      return follows.filter((f) => f.leaderUid === uid && f.active);
    },
    async recordExecution(e) {
      executions.push(e);
    },
    async recordLeaderEvents() {},
  };
  return { store, executions, ledgers };
}

const tmPos = (side: "long" | "short", size: string, margin: string, leverage = 10): TmPosition => ({
  asset_id: BTC, venue: "defi", symbol: "BTC", side, size, entry_price: "80000", mark_price: "80000", liquidation_price: null, margin_used: margin, unrealized_pnl: "0", return_on_equity: "0", leverage,
});

describe("syncLeader: one follower copying two leaders in the same asset", () => {
  it("leader A closing only closes A's copy, B's copy stays", async () => {
    // Follower F copies leaders A and B; each copy has its own account (FA, FB) with $1,000.
    const follows: Follow[] = [
      { id: "F_A", followerUid: "F", leaderUid: "A", copyAccountUserId: "FA", active: true },
      { id: "F_B", followerUid: "F", leaderUid: "B", copyAccountUserId: "FB", active: true },
    ];
    const books: Record<string, TmPosition[]> = { tmA: [], tmB: [], FA: [], FB: [] };
    const { tm, orders } = fakeTm(books, { tmA: 10_000, tmB: 4_000, FA: 1_000, FB: 1_000 });
    const { store, executions } = memoryStore(follows);
    const deps = { tm, signer: loadSignerKey(generateSignerKeyFile()), store, assets: async () => ({ id: BTC, sizeDecimals: 5, maxLeverage: 40 }) };

    await syncLeader(deps, "A", "tmA"); // baselines
    await syncLeader(deps, "B", "tmB");

    // A puts 20% of $10k into a 10x BTC long; B puts 5% of $4k into a 5x BTC long.
    books.tmA = [tmPos("long", "0.25", "2000")];
    books.tmB = [tmPos("long", "0.0125", "200", 5)];
    await syncLeader(deps, "A", "tmA");
    await syncLeader(deps, "B", "tmB");
    expect(orders).toEqual([
      { userId: "FA", order: expect.objectContaining({ side: "buy", qty: "200.00", qty_unit: "quote", leverage: 10 }) }, // 20% of $1,000
      { userId: "FB", order: expect.objectContaining({ side: "buy", qty: "50.00", qty_unit: "quote", leverage: 5 }) }, // 5% of $1,000
    ]);

    // Simulate the fills in each copy account.
    books.FA = [tmPos("long", "0.025", "200")];
    books.FB = [tmPos("long", "0.003125", "50", 5)];

    // A closes half, then the rest. Only FA trades; FB is untouched.
    books.tmA = [tmPos("long", "0.125", "1000")];
    await syncLeader(deps, "A", "tmA");
    expect(orders[2]).toEqual({ userId: "FA", order: expect.objectContaining({ side: "sell", qty: "0.01250", reduce_only: true }) });
    books.FA = [tmPos("long", "0.0125", "100")];

    books.tmA = [];
    await syncLeader(deps, "A", "tmA");
    expect(orders[3]).toEqual({ userId: "FA", order: expect.objectContaining({ side: "sell", qty: "0.0125", reduce_only: true }) });
    expect(orders.filter((o) => o.userId === "FB")).toHaveLength(1);
    expect(executions.every((e) => e.status === "filled")).toBe(true);
  });

  it("does not copy positions a leader already had before the first sync", async () => {
    const follows: Follow[] = [{ id: "F_A", followerUid: "F", leaderUid: "A", copyAccountUserId: "FA", active: true }];
    const { tm, orders } = fakeTm({ tmA: [tmPos("long", "1", "1000")], FA: [] }, { tmA: 1_000, FA: 1_000 });
    const { store } = memoryStore(follows);
    await syncLeader({ tm, signer: loadSignerKey(generateSignerKeyFile()), store, assets: async () => ({ id: BTC, sizeDecimals: 5, maxLeverage: 40 }) }, "A", "tmA");
    expect(orders).toEqual([]);
  });
});

describe("ledger", () => {
  const lots: Ledger = { [BTC]: { side: "long", byLeader: { A: 0.2, B: 0.1 } } };

  it("own part = position minus copied lots, margin pro rata", () => {
    const [own] = ownPositions([snap("long", 0.5, 500)], lots);
    expect(own.size).toBeCloseTo(0.2);
    expect(own.marginUsd).toBeCloseTo(200);
    expect(ownPositions([snap("long", 0.3, 300)], lots)).toEqual([]);
  });

  it("reconcile shrinks lots pro rata when the position is smaller, drops them on close or flip", () => {
    const r = reconcile(lots, [{ assetId: BTC, side: "long", size: 0.15 }]);
    expect(r.changed).toBe(true);
    expect(r.ledger[BTC].byLeader.A).toBeCloseTo(0.1);
    expect(r.ledger[BTC].byLeader.B).toBeCloseTo(0.05);
    expect(reconcile(lots, []).ledger).toEqual({});
    expect(reconcile(lots, [{ assetId: BTC, side: "short", size: 1 }]).ledger).toEqual({});
    expect(reconcile(lots, [{ assetId: BTC, side: "long", size: 1 }]).changed).toBe(false);
  });

  it("add/remove lots per leader", () => {
    expect(addLot({}, BTC, "long", "A", 0.1)[BTC].byLeader).toEqual({ A: 0.1 });
    expect(removeLot(lots, BTC, "A", "all")[BTC].byLeader).toEqual({ B: 0.1 });
    expect(removeLot(removeLot(lots, BTC, "A", "all"), BTC, "B", 0.1)).toEqual({});
  });
});

// A fake TrueMarkets that fills market orders at $80k, so the ledger is exercised end to end.
function fillingTm(equity: Record<string, number>) {
  const PRICE = 80_000;
  const books: Record<string, TmPosition[]> = {};
  const orders: Array<{ userId: string; order: CreateOrderRequest }> = [];
  const put = (userId: string, side: "long" | "short", size: number, margin: number, leverage: number) => {
    books[userId] = (books[userId] ?? []).filter((p) => p.asset_id !== BTC);
    if (size > 1e-9) books[userId].push(tmPos(side, String(+size.toFixed(8)), String(+margin.toFixed(6)), leverage));
  };
  const tm = {
    async listPositions(userId: string) {
      return books[userId] ?? [];
    },
    async getPortfolio(userId: string): Promise<TmPortfolio> {
      const c = equity[userId] ?? 0;
      return { total_usd: String(c), balances_usd: String(c), cash_usd: String(c), change_24h_usd: "0", change_24h_pct: "0", unrealized_pnl_usd: "0", realized_pnl_usd: "0", balances: [{ symbol: "USDC", venue: "defi", total: String(c), available: String(c), held: "0", stable: true }], positions: books[userId] ?? [] };
    },
    async createOrder(userId: string, order: CreateOrderRequest) {
      orders.push({ userId, order });
      const cur = (books[userId] ?? []).find((p) => p.asset_id === BTC);
      const size = Number(cur?.size ?? 0);
      const margin = Number(cur?.margin_used ?? 0);
      if (order.reduce_only) {
        const left = Math.max(0, size - Number(order.qty));
        put(userId, cur!.side, left, margin * (left / size), cur!.leverage);
      } else {
        const lev = order.leverage ?? 1;
        put(userId, order.side === "buy" ? "long" : "short", size + (Number(order.qty) * lev) / PRICE, margin + Number(order.qty), lev);
      }
      return { order_id: `o${orders.length}`, status: "complete" as const, payloads: [] };
    },
    async getOrder(_userId: string, id: string) {
      return { id, status: "complete" as const };
    },
  };
  return { tm: tm as unknown as TmClient, orders, books, put };
}

describe("syncLeader in one account (ledger)", () => {
  const assets = async () => ({ id: BTC, sizeDecimals: 6, maxLeverage: 40 });
  const follow = (leader: string, budgetUsd: number): Follow => ({ id: `F_${leader}`, followerUid: "F", leaderUid: leader, followerTmUserId: "tmF", budgetUsd, active: true });

  it("two leaders long BTC: A closing only removes A's share; F's own part and B's share stay", async () => {
    const { tm, orders, books, put } = fillingTm({ tmA: 10_000, tmB: 4_000, tmF: 1_000 });
    const { store, ledgers } = memoryStore([follow("A", 500), follow("B", 500)]);
    const deps = { tm, signer: loadSignerKey(generateSignerKeyFile()), store, assets };
    await syncLeader(deps, "A", "tmA");
    await syncLeader(deps, "B", "tmB");

    // F already holds their own small BTC long.
    put("tmF", "long", 0.001, 8, 10);
    // A puts 20% in at 10x, B puts 5% in at 10x.
    put("tmA", "long", 0.25, 2_000, 10);
    put("tmB", "long", 0.025, 200, 10);
    await syncLeader(deps, "A", "tmA");
    await syncLeader(deps, "B", "tmB");

    // Copies join F's existing 10x position: 20% and 5% of each $500 budget.
    expect(orders.map((o) => [o.userId, o.order.qty, o.order.leverage])).toEqual([["tmF", "100.00", 10], ["tmF", "25.00", 10]]);
    const lots = ledgers.get("F")![BTC].byLeader;
    expect(lots.A).toBeCloseTo(0.0125);
    expect(lots.B).toBeCloseTo(0.003125);
    expect(Number(books.tmF[0].size)).toBeCloseTo(0.001 + 0.0125 + 0.003125);

    // A closes everything: F reduces by exactly A's share.
    put("tmA", "long", 0, 0, 10);
    await syncLeader(deps, "A", "tmA");
    expect(orders[2]).toMatchObject({ userId: "tmF", order: { reduce_only: true, qty: "0.012500" } });
    expect(Number(books.tmF[0].size)).toBeCloseTo(0.001 + 0.003125);
    expect(ledgers.get("F")![BTC].byLeader).toEqual({ B: expect.closeTo(0.003125) });
  });

  it("F's followers copy only F's own trades, never what F copied", async () => {
    const { tm, orders, put } = fillingTm({ tmA: 10_000, tmF: 1_000, tmG: 1_000 });
    const gFollowsF: Follow = { id: "G_F", followerUid: "G", leaderUid: "F", followerTmUserId: "tmG", budgetUsd: 500, active: true };
    const { store } = memoryStore([follow("A", 500), gFollowsF]);
    const deps = { tm, signer: loadSignerKey(generateSignerKeyFile()), store, assets };
    await syncLeader(deps, "A", "tmA");
    await syncLeader(deps, "F", "tmF");

    put("tmA", "long", 0.25, 2_000, 10);
    await syncLeader(deps, "A", "tmA"); // F copies A
    await syncLeader(deps, "F", "tmF"); // F's position grew, but only by copied size
    expect(orders.filter((o) => o.userId === "tmG")).toHaveLength(0);
  });

  it("skips a copy that would fight an opposite position", async () => {
    const { tm, orders, put } = fillingTm({ tmA: 10_000, tmF: 1_000 });
    const { store, executions } = memoryStore([follow("A", 500)]);
    const deps = { tm, signer: loadSignerKey(generateSignerKeyFile()), store, assets };
    await syncLeader(deps, "A", "tmA");
    put("tmF", "short", 0.002, 16, 10);
    put("tmA", "long", 0.25, 2_000, 10);
    await syncLeader(deps, "A", "tmA");
    expect(orders).toHaveLength(0);
    expect(executions[0]).toMatchObject({ status: "skipped", note: expect.stringContaining("opposite") });
  });
});
