import { defineInt, defineSecret, defineString } from "firebase-functions/params";
import { TM_BASE_URL } from "./tm/env.js";

// TrueMarkets decides perp availability from the requesting IP, which is this backend's, so the
// functions must run in a region where perps are allowed. Our own country check (geo.ts) is what
// keeps users from restricted countries out; it must stay on.
export const REGION = "europe-west1";

export const TM_BASE = TM_BASE_URL.live;

// Organization API key file and signer key file (JSON), stored in Secret Manager.
export const TM_API_KEY = defineSecret("TM_API_KEY");
export const TM_SIGNER_KEY = defineSecret("TM_SIGNER_KEY");

// ISO 3166 alpha-2 codes. US: TrueMarkets doesn't offer perps there. The rest: comprehensive sanctions.
export const BLOCKED_COUNTRIES = defineString("BLOCKED_COUNTRIES", { default: "US,CU,IR,KP,SY,RU,BY" });

export const DAILY_WITHDRAWAL_LIMIT_USD = defineInt("DAILY_WITHDRAWAL_LIMIT_USD", { default: 500 });

// A withdrawal needs a Google sign-in this recent (seconds).
export const WITHDRAWAL_REAUTH_SECONDS = 600;
