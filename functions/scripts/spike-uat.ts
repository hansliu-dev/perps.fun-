// Milestone 1 spike: token → user → paper deposit → perp long → positions → reduce_only close.
// Usage:
//   TM_KEY_FILE=secrets/uat-api-key.json TM_SIGNER_FILE=secrets/uat-signer.json npm run spike [-- live]
// Missing TM_SIGNER_FILE generates one (keep it: signer keys cannot be rotated).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TokenProvider } from "../src/tm/auth.js";
import { TmClient } from "../src/tm/client.js";
import { TM_BASE_URL, type TmEnv } from "../src/tm/env.js";
import { generateSignerKeyFile, loadApiKey, loadSignerKey } from "../src/tm/keys.js";
import { placeOrder } from "../src/tm/orders.js";

const env: TmEnv = process.argv.includes("live") ? "live" : "paper";
const keyFile = process.env.TM_KEY_FILE;
const signerFile = process.env.TM_SIGNER_FILE ?? "secrets/uat-signer.json";
const symbol = process.env.TM_SYMBOL ?? "BTC";
const margin = process.env.TM_MARGIN ?? (env === "live" ? "2" : "50");
if (!keyFile) throw new Error("Set TM_KEY_FILE to the console API key file");

if (!existsSync(signerFile)) {
  writeFileSync(signerFile, JSON.stringify(generateSignerKeyFile(), null, 2), { mode: 0o600 });
  console.log(`generated signer key → ${signerFile} (back it up)`);
}

const baseUrl = TM_BASE_URL[env];
const client = new TmClient(baseUrl, new TokenProvider(baseUrl, loadApiKey(JSON.parse(readFileSync(keyFile, "utf8")))));
const signer = loadSignerKey(JSON.parse(readFileSync(signerFile, "utf8")));

console.log(`env=${env} base=${baseUrl} org=${await client.organizationId()}`);

const perps = await client.listAssets({ product_type: "perp" });
const perp = perps.find((a) => a.type === "perp" && a.symbol.toUpperCase() === symbol);
if (!perp) throw new Error(`no ${symbol} perp; available: ${perps.map((a) => a.symbol).join(", ")}`);
console.log("perp:", perp.id, perp.symbol, perp.chain, perp.perp);

const user = await client.createUser("spike-user-1", signer.publicKeyHex);
console.log("user:", user.user_id, user.wallets);

if (env === "paper") {
  const usdc = (await client.listAssets()).find((a) => a.symbol === "USDC" && a.venue === "defi");
  if (!usdc) throw new Error("no USDC listing");
  console.log("paper deposit:", await client.paperDeposit(user.user_id, usdc.id, "1000"));
}

const leverage = Math.min(5, perp.perp?.max_leverage ?? 5);
const open = await placeOrder(client, signer, user.user_id, {
  asset_id: perp.id,
  side: "buy",
  type: "market",
  qty: margin,
  qty_unit: "quote",
  leverage,
});
console.log("open:", open);

const positions = await client.listPositions(user.user_id);
console.log("positions:", positions);
const pos = positions.find((p) => p.asset_id === perp.id);

if (pos) {
  const close = await placeOrder(client, signer, user.user_id, {
    asset_id: perp.id,
    side: pos.side === "long" ? "sell" : "buy",
    type: "market",
    qty: pos.size,
    qty_unit: "base",
    reduce_only: true,
  });
  console.log("close:", close);
}

console.log("portfolio:", await client.getPortfolio(user.user_id));

// Check whether candles accept a perp asset_id (fallback: spot symbol).
const candles = await fetch(`${baseUrl}/v1/defi/market/prices/candles?asset_id=${perp.id}&window=1d&resolution=1h`);
console.log("perp candles:", candles.status, (await candles.text()).slice(0, 300));
