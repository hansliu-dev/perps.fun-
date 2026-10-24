import type { TmClient, TmTransfer } from "./client.js";
import type { SignerKey } from "./keys.js";
import { stampAll } from "./signer.js";

// create → sign payloads → execute. Execute returns once the transaction has landed.
export async function sendTransfer(
  client: TmClient,
  signer: SignerKey,
  userId: string,
  body: { asset_id: string; qty: string; to: string },
): Promise<TmTransfer> {
  const created = await client.createTransfer(userId, body);
  if (!created.payloads?.length) return created;
  return client.executeTransfer(userId, created.id, stampAll(created.payloads, signer));
}
