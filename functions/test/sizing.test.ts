import { describe, expect, it } from "vitest";
import { sizeCopyIncrease, sizeCopyOpen } from "../src/copy/sizing.js";

describe("sizeCopyOpen", () => {
  it("proportional: mirrors the leader's % of equity", () => {
    // Leader put 10% of equity in at 10x; follower's copy account has $2,000.
    expect(sizeCopyOpen(0.1, 10, { equityUsd: 2_000, availableUsd: 2_000 }, {}, 50)).toEqual({ skip: false, marginUsd: 200, leverage: 10 });
  });

  it("clamps to available balance and leverage caps", () => {
    expect(sizeCopyOpen(0.5, 20, { equityUsd: 10_000, availableUsd: 700 }, {}, 3)).toEqual({ skip: false, marginUsd: 700, leverage: 3 });
  });

  it("skips orders under Hyperliquid's $10 notional minimum", () => {
    expect(sizeCopyOpen(0.01, 2, { equityUsd: 100, availableUsd: 100 }, {}, 50).skip).toBe(true); // $1 × 2 = $2
    expect(sizeCopyOpen(0.01, 10, { equityUsd: 100, availableUsd: 100 }, {}, 50).skip).toBe(false); // $1 × 10 = $10
    expect(sizeCopyOpen(0.5, 5, { equityUsd: 100, availableUsd: 0 }, {}, 50).skip).toBe(true); // nothing available
  });
});

describe("sizeCopyIncrease", () => {
  it("grows the copied position by the leader's growth ratio", () => {
    expect(sizeCopyIncrease(0.5, 200, 10, { equityUsd: 1_000, availableUsd: 800 })).toEqual({ skip: false, marginUsd: 100, leverage: 10 });
  });
});
