import { createECDH, createPrivateKey, type KeyObject } from "node:crypto";

// Organization API key file downloaded from console.truemarkets.co.
export interface ApiKeyFile {
  key_id: string;
  private_key: { kty: "EC"; crv: "P-256"; d: string; x: string; y: string };
}

// Signer key file: compressed P-256 public key (66 hex) + 32-byte private scalar (hex).
export interface SignerKeyFile {
  signer_public_key: string;
  signer_private_key: string;
}

export interface ApiKey {
  keyId: string;
  privateKey: KeyObject;
}

export interface SignerKey {
  publicKeyHex: string;
  privateKey: KeyObject;
}

export function loadApiKey(file: ApiKeyFile): ApiKey {
  return {
    keyId: file.key_id,
    privateKey: createPrivateKey({ key: file.private_key, format: "jwk" }),
  };
}

export function loadSignerKey(file: SignerKeyFile): SignerKey {
  const d = Buffer.from(file.signer_private_key, "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const compressed = ecdh.getPublicKey("hex", "compressed");
  if (compressed !== file.signer_public_key.toLowerCase()) {
    throw new Error("signer_public_key does not match signer_private_key");
  }
  const uncompressed = ecdh.getPublicKey();
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: d.toString("base64url"),
      x: uncompressed.subarray(1, 33).toString("base64url"),
      y: uncompressed.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  return { publicKeyHex: compressed, privateKey };
}

export function generateSignerKeyFile(): SignerKeyFile {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    signer_public_key: ecdh.getPublicKey("hex", "compressed"),
    signer_private_key: ecdh.getPrivateKey("hex").padStart(64, "0"),
  };
}
