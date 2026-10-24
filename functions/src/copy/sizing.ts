// Copying is always proportional (the follower commits the same share of their copy budget as the leader
// did of their account) and always at the leader's leverage. Nothing is configurable per follow yet.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface FollowSettings {}

export interface FollowerAccount {
  equityUsd: number;
  availableUsd: number;
}

export type CopySizing = { skip: true; reason: string } | { skip: false; marginUsd: number; leverage: number };

// Hyperliquid rejects orders under $10 notional.
export const MIN_NOTIONAL_USD = 10;

export function clampLeverage(leaderLeverage: number, settings: FollowSettings, assetMaxLeverage: number): number {
  // The leader's leverage, within what the market allows.
  return Math.max(1, Math.min(leaderLeverage, assetMaxLeverage));
}

// Caps margin at what's available and enforces Hyperliquid's $10 minimum position.
export function sizeMargin(margin: number, leverage: number, availableUsd: number): CopySizing {
  return finish(margin, leverage, { equityUsd: 0, availableUsd });
}

function finish(margin: number, leverage: number, follower: FollowerAccount): CopySizing {
  const wanted = margin;
  margin = Math.floor(Math.min(margin, follower.availableUsd) * 100) / 100;
  if (margin * leverage < MIN_NOTIONAL_USD) {
    const usd = (v: number) => `$${v.toFixed(2)}`;
    if (wanted * leverage >= MIN_NOTIONAL_USD) return { skip: true, reason: `not enough USDC available (${usd(follower.availableUsd)})` };
    return { skip: true, reason: `copy would be a ${usd(wanted * leverage)} position, under Hyperliquid's $10 minimum. A bigger budget fixes this` };
  }
  return { skip: false, marginUsd: margin, leverage };
}

// Leader opened a new position using `leaderMarginPct` of their equity.
export function sizeCopyOpen(leaderMarginPct: number, leaderLeverage: number, follower: FollowerAccount, settings: FollowSettings, assetMaxLeverage: number): CopySizing {
  const leverage = clampLeverage(leaderLeverage, settings, assetMaxLeverage);
  if (!(leaderMarginPct > 0)) return { skip: true, reason: "leader margin unknown" };
  return finish(leaderMarginPct * follower.equityUsd, leverage, follower);
}

// Leader added `marginGrowth` (e.g. 0.5 = +50%) to an existing position; the follower grows theirs by the same ratio.
export function sizeCopyIncrease(marginGrowth: number, followerPositionMarginUsd: number, leverage: number, follower: FollowerAccount): CopySizing {
  if (!(marginGrowth > 0) || !(followerPositionMarginUsd > 0)) return { skip: true, reason: "nothing to add" };
  return finish(marginGrowth * followerPositionMarginUsd, leverage, follower);
}
