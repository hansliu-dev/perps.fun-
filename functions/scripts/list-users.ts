// Lists every TrueMarkets user in the organization with its wallet addresses. Read-only.
// Usage: TM_KEY_FILE=secrets/prod-api-key.json npm run list-users [-- --csv]
import { readFileSync } from "node:fs";
import { TokenProvider } from "../src/tm/auth.js";
import { TmClient } from "../src/tm/client.js";
import { TM_BASE_URL } from "../src/tm/env.js";
import { loadApiKey } from "../src/tm/keys.js";

const keyFile = process.env.TM_KEY_FILE ?? "secrets/prod-api-key.json";
const base = TM_BASE_URL.live;
const client = new TmClient(base, new TokenProvider(base, loadApiKey(JSON.parse(readFileSync(keyFile, "utf8")))));

const users = await client.listUsers();
const rows = users.map((u) => ({
  kind: u.external_ref_id.includes("__") ? "copy account" : "app user",
  external_ref_id: u.external_ref_id,
  user_id: u.user_id,
  solana: u.wallets.find((w) => w.chain_family === "solana")?.address ?? "(setting up)",
  evm: u.wallets.find((w) => w.chain_family === "evm")?.address ?? "(setting up)",
}));

console.log(`organization ${await client.organizationId()}: ${rows.length} users`);
if (process.argv.includes("--csv")) {
  console.log("kind,external_ref_id,user_id,solana,evm");
  for (const r of rows) console.log([r.kind, r.external_ref_id, r.user_id, r.solana, r.evm].join(","));
} else {
  console.table(rows);
}
