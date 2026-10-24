// Creates the production signer key ONCE. Every user's wallet is tied to it forever; losing it locks
// their funds and it can't be rotated. Refuses to overwrite an existing file.
import { existsSync, writeFileSync } from "node:fs";
import { generateSignerKeyFile } from "../src/tm/keys.js";

const path = process.argv[2] ?? "secrets/prod-signer.json";
if (existsSync(path)) {
  console.error(`${path} already exists. Not overwriting: users may already depend on it.`);
  process.exit(1);
}
const key = generateSignerKeyFile();
writeFileSync(path, JSON.stringify(key, null, 2), { mode: 0o600 });
console.log(`Wrote ${path} (public key ${key.signer_public_key}).`);
console.log("Back it up now (password manager or offline copy) before anyone signs up.");
