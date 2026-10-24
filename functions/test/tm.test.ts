import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeOrganizationId, signTokenChallenge, TokenProvider } from "../src/tm/auth.js";
import { TmClient } from "../src/tm/client.js";
import { generateSignerKeyFile, loadApiKey, loadSignerKey, type ApiKeyFile } from "../src/tm/keys.js";
import { placeOrder } from "../src/tm/orders.js";
import { stampPayload } from "../src/tm/signer.js";

function fakeApiKeyFile(): ApiKeyFile {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as ApiKeyFile["private_key"];
  return { key_id: "11111111-2222-3333-4444-555555555555", private_key: jwk };
}

function fakeJwt(orgId: string) {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "ES256" })}.${b({ claims: { tm: { organization_id: orgId } } })}.sig`;
}

describe("org token challenge", () => {
  it("is a raw r||s ES256 signature over `{key_id}.{timestamp}`, base64url", () => {
    const file = fakeApiKeyFile();
    const key = loadApiKey(file);
    const sig = signTokenChallenge(key, 1_700_000_000);
    const raw = Buffer.from(sig, "base64url");
    expect(raw.length).toBe(64);
    expect(sig).not.toMatch(/[=+/]/);
    const ok = verify("sha256", Buffer.from(`${file.key_id}.1700000000`), { key: createPublicKey(key.privateKey), dsaEncoding: "ieee-p1363" }, raw);
    expect(ok).toBe(true);
  });

  it("reads organization_id from claims.tm", () => {
    expect(decodeOrganizationId(fakeJwt("org-123"))).toBe("org-123");
  });
});

describe("signer key + payload stamping", () => {
  it("round-trips a generated signer key file", () => {
    const file = generateSignerKeyFile();
    expect(file.signer_public_key).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(file.signer_private_key).toHaveLength(64);
    expect(loadSignerKey(file).publicKeyHex).toBe(file.signer_public_key);
  });

  it("rejects a mismatched public key", () => {
    const a = generateSignerKeyFile();
    const b = generateSignerKeyFile();
    expect(() => loadSignerKey({ ...a, signer_public_key: b.signer_public_key })).toThrow();
  });

  it("produces a base64url envelope with a DER hex signature over the exact payload bytes", () => {
    const key = loadSignerKey(generateSignerKeyFile());
    const payload = '{"type":"ACTIVITY_TYPE_SIGN_TRANSACTION_V2","parameters":{}}\n';
    const envelope = JSON.parse(Buffer.from(stampPayload(payload, key), "base64url").toString("utf8"));
    expect(envelope.publicKey).toBe(key.publicKeyHex);
    expect(envelope.scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
    const der = Buffer.from(envelope.signature, "hex");
    expect(der[0]).toBe(0x30);
    const pub = createPublicKey(key.privateKey);
    expect(verify("sha256", Buffer.from(payload), { key: pub, dsaEncoding: "der" }, der)).toBe(true);
    expect(verify("sha256", Buffer.from(payload.trimEnd()), { key: pub, dsaEncoding: "der" }, der)).toBe(false);
  });
});

function mockFetch(routes: Record<string, (body: any) => { status?: number; json: unknown }>) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, headers: init.headers as Record<string, string>, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response("not found", { status: 404 });
    const { status = 200, json } = handler(body);
    return new Response(JSON.stringify(json), { status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function setup(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch({
    "POST /v1/auth/api-key/token": () => ({ json: { access_token: fakeJwt("org-1"), expires_in: new Date(Date.now() + 3600_000).toISOString() } }),
    ...routes,
  });
  const tokens = new TokenProvider("https://tm.test", loadApiKey(fakeApiKeyFile()), m.fetch);
  return { ...m, client: new TmClient("https://tm.test", tokens, m.fetch), signer: loadSignerKey(generateSignerKeyFile()) };
}

describe("placeOrder", () => {
  const order = { asset_id: "a", side: "buy", type: "market", qty: "10", qty_unit: "quote", leverage: 5 } as const;

  it("live: signs payloads, executes, then polls to final with TM-On-Behalf-Of", async () => {
    let polls = 0;
    const { client, signer, calls } = setup({
      "POST /v1/gateway/orders": () => ({ status: 201, json: { order_id: "o1", status: "initialized", payloads: [{ digest: "d", payload: "p1\n" }, { digest: "d", payload: "p2\n" }] } }),
      "POST /v1/gateway/orders/o1/execute": () => ({ json: { status: "pending" } }),
      "GET /v1/gateway/orders/o1": () => ({ json: { id: "o1", status: ++polls < 2 ? "pending" : "complete" } }),
    });
    const res = await placeOrder(client, signer, "user-1", order, { pollIntervalMs: 1 });
    expect(res.status).toBe("complete");
    const exec = calls.find((c) => c.path.endsWith("/execute"))!;
    expect(exec.body.auth_type).toBe("api_key");
    expect(exec.body.signatures).toHaveLength(2);
    expect(exec.headers["TM-On-Behalf-Of"]).toBe("user-1");
  });

  it("market order: keeps polling past a momentary \"active\" until it completes", async () => {
    const statuses = ["pending", "active", "complete"];
    const { client, signer } = setup({
      "POST /v1/gateway/orders": () => ({ status: 201, json: { order_id: "o9", status: "initialized", payloads: [{ digest: "d", payload: "p\n" }] } }),
      "POST /v1/gateway/orders/o9/execute": () => ({ json: { status: "pending" } }),
      "GET /v1/gateway/orders/o9": () => ({ json: { id: "o9", status: statuses.shift() ?? "complete" } }),
    });
    expect((await placeOrder(client, signer, "user-1", order, { pollIntervalMs: 1 })).status).toBe("complete");
  });

  it("limit order: returns once it rests (active)", async () => {
    const { client, signer } = setup({
      "POST /v1/gateway/orders": () => ({ status: 201, json: { order_id: "o10", status: "initialized", payloads: [{ digest: "d", payload: "p\n" }] } }),
      "POST /v1/gateway/orders/o10/execute": () => ({ json: { status: "pending" } }),
      "GET /v1/gateway/orders/o10": () => ({ json: { id: "o10", status: "active" } }),
    });
    const res = await placeOrder(client, signer, "user-1", { asset_id: "a", side: "buy", type: "limit", qty: "1", qty_unit: "base", price: "1", leverage: 2 }, { pollIntervalMs: 1 });
    expect(res.status).toBe("active");
  });

  it("paper: empty payloads with a final status skips execute", async () => {
    const { client, signer, calls } = setup({
      "POST /v1/gateway/orders": () => ({ status: 201, json: { order_id: "o2", status: "complete", payloads: [] } }),
      "GET /v1/gateway/orders/o2": () => ({ json: { id: "o2", status: "complete" } }),
    });
    const res = await placeOrder(client, signer, "user-1", order);
    expect(res.status).toBe("complete");
    expect(calls.some((c) => c.path.endsWith("/execute"))).toBe(false);
  });

  it("throws when no order_id is returned (unfundable quote)", async () => {
    const { client, signer } = setup({
      "POST /v1/gateway/orders": () => ({ status: 201, json: { order_id: "", quote: { issues: ["insufficient_balance"] } } }),
    });
    await expect(placeOrder(client, signer, "user-1", order)).rejects.toThrow(/insufficient_balance/);
  });

  it("re-places once on quote_stale", async () => {
    let creates = 0;
    let executes = 0;
    const { client, signer } = setup({
      "POST /v1/gateway/orders": () => ({ status: 201, json: { order_id: `o${++creates}`, payloads: [{ digest: "d", payload: "p\n" }] } }),
      "POST /v1/gateway/orders/o1/execute": () => (executes++, { status: 422, json: { type: "quote_stale" } }),
      "POST /v1/gateway/orders/o2/execute": () => (executes++, { json: { status: "complete" } }),
      "GET /v1/gateway/orders/o2": () => ({ json: { id: "o2", status: "complete" } }),
    });
    const res = await placeOrder(client, signer, "user-1", order);
    expect(res.id).toBe("o2");
    expect(executes).toBe(2);
  });
});
