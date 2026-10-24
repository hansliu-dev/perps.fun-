import { initializeApp } from "firebase-admin/app";
import { onCall } from "firebase-functions/v2/https";
import { TM_BASE } from "./config.js";
import { callableOptions, requireAuth } from "./api/common.js";

initializeApp();

export { onboard, getPortfolio, getWallet } from "./api/account.js";
export { placePerpOrder, closePosition } from "./api/trade.js";
export { closeCopyLot, follow, unfollow } from "./api/copy.js";
export { withdraw } from "./api/withdraw.js";
export { submitThesis } from "./api/thesis.js";
export { updateProfile } from "./api/profile.js";
export { onSyncRequest, syncLeaders, refreshFollowStats } from "./jobs.js";

// What TrueMarkets allows from this backend's location. Perps must be listed, or every order fails with 403.
export const serverAvailability = onCall(callableOptions, async (req) => {
  requireAuth(req);
  const res = await fetch(`${TM_BASE}/v1/gateway/assets/availability`);
  return res.json();
});
