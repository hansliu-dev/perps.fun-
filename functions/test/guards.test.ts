import { describe, expect, it, vi } from "vitest";
import { validAddress } from "../src/api/withdraw.js";
import { countryOf, isBlocked } from "../src/geo.js";

describe("country check", () => {
  const list = "US,CU,IR,KP,SY,RU,BY";
  it("blocks listed countries and unknown countries", () => {
    expect(isBlocked("US", list)).toBe(true);
    expect(isBlocked(null, list)).toBe(true);
    expect(isBlocked("DE", list)).toBe(false);
  });

  it("fails closed when the lookup errors", async () => {
    const failing = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await countryOf("203.0.113.9", failing)).toBeNull();
  });

  it("reads the country from the lookup", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ip: "198.51.100.7", country: "de" }))) as unknown as typeof fetch;
    expect(await countryOf("198.51.100.7", ok)).toBe("DE");
  });
});

describe("withdrawal addresses", () => {
  it("checks the format for the chain", () => {
    expect(validAddress("arbitrum", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(true);
    expect(validAddress("hypercore-perp", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9604")).toBe(false);
    expect(validAddress("solana", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe(true);
    expect(validAddress("solana", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
  });
});
