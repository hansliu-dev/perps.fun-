import { sign } from "node:crypto";
import type { SignerKey } from "./keys.js";

export interface OrderPayload {
  digest: string;
  payload: string;
}

// Stamps one Turnkey activity payload: ECDSA P-256/SHA-256 over the exact payload bytes,
// DER-encoded as hex, wrapped in the API-key envelope and base64url-encoded.
// The payload must be passed through untouched (including its trailing newline).
export function stampPayload(payload: string, key: SignerKey): string {
  const signature = sign("sha256", Buffer.from(payload, "utf8"), {
    key: key.privateKey,
    dsaEncoding: "der",
  }).toString("hex");
  const envelope = JSON.stringify({
    publicKey: key.publicKeyHex,
    signature,
    scheme: "SIGNATURE_SCHEME_TK_API_P256",
  });
  return Buffer.from(envelope, "utf8").toString("base64url");
}

export function stampAll(payloads: OrderPayload[], key: SignerKey): string[] {
  return payloads.map((p) => stampPayload(p.payload, key));
}
