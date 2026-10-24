import { sign } from "node:crypto";
import type { ApiKey } from "./keys.js";

export interface OrgToken {
  accessToken: string;
  organizationId: string;
  expiresAt: number; // ms epoch
}

// Signs `{key_id}.{timestamp}` with ES256; the signature is raw r‖s (not DER), base64url without padding.
export function signTokenChallenge(key: ApiKey, timestamp: number): string {
  return sign("sha256", Buffer.from(`${key.keyId}.${timestamp}`, "utf8"), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

export function decodeOrganizationId(jwt: string): string {
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  const orgId = claims?.claims?.tm?.organization_id ?? claims?.tm?.organization_id;
  if (!orgId) throw new Error("organization_id missing from token claims");
  return orgId;
}

export async function mintOrgToken(baseUrl: string, key: ApiKey, fetchImpl = fetch): Promise<OrgToken> {
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await fetchImpl(`${baseUrl}/v1/auth/api-key/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key_id: key.keyId, timestamp, signature: signTokenChallenge(key, timestamp) }),
  });
  if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: string };
  // expires_in is an ISO timestamp despite its name; fall back to the documented 1h lifetime.
  const parsed = Date.parse(body.expires_in);
  return {
    accessToken: body.access_token,
    organizationId: decodeOrganizationId(body.access_token),
    expiresAt: Number.isNaN(parsed) ? Date.now() + 60 * 60 * 1000 : parsed,
  };
}

// Caches the org token and re-mints ~10 minutes before expiry (there is no refresh token).
export class TokenProvider {
  private token?: OrgToken;
  private inflight?: Promise<OrgToken>;

  constructor(
    private baseUrl: string,
    private key: ApiKey,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async get(): Promise<OrgToken> {
    if (this.token && this.token.expiresAt - Date.now() > 10 * 60 * 1000) return this.token;
    this.inflight ??= mintOrgToken(this.baseUrl, this.key, this.fetchImpl).finally(() => {
      this.inflight = undefined;
    });
    this.token = await this.inflight;
    return this.token;
  }
}
