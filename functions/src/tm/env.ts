// TrueMarkets environments. Paper trading only exists on UAT; /paper/* answers 404 in production.
export type TmEnv = "live" | "paper";

export const TM_BASE_URL: Record<TmEnv, string> = {
  live: "https://api.truemarkets.co",
  paper: "https://api.uat.truemarkets.co",
};

export const TM_WS_URL: Record<TmEnv, string> = {
  live: "wss://api.truemarkets.co/v1/defi/market",
  paper: "wss://api.uat.truemarkets.co/v1/defi/market",
};
