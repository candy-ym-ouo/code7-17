import { describe, expect, it } from "vitest";
import { expandTileUrl, parseCacheExpiry } from "./tileCache";

describe("parseCacheExpiry", () => {
  const now = 1_000_000;

  function headers(entries: Record<string, string>): Headers {
    return new Headers(entries);
  }

  it("honors max-age from Cache-Control", () => {
    expect(parseCacheExpiry(headers({ "cache-control": "public, max-age=3600" }), now)).toBe(now + 3_600_000);
  });

  it("treats no-store as non-cacheable", () => {
    expect(parseCacheExpiry(headers({ "cache-control": "no-store" }), now)).toBeNull();
  });

  it("treats no-cache as immediately stale (revalidate next read)", () => {
    expect(parseCacheExpiry(headers({ "cache-control": "no-cache" }), now)).toBe(now);
  });

  it("falls back to Expires header", () => {
    const expires = new Date(now + 60_000).toUTCString();
    expect(parseCacheExpiry(headers({ expires }), now)).toBe(now + 60_000);
  });

  it("uses default TTL when no headers are present", () => {
    expect(parseCacheExpiry(headers({}), now, 7_000)).toBe(now + 7_000);
  });

  it("never returns a past expiry for a stale Expires header", () => {
    const expires = new Date(now - 60_000).toUTCString();
    expect(parseCacheExpiry(headers({ expires }), now)).toBe(now);
  });
});

describe("expandTileUrl", () => {
  it("expands z/x/y placeholders", () => {
    expect(expandTileUrl("https://tiles.example.com/{z}/{x}/{y}.png", { z: 12, x: 3, y: 4 }))
      .toBe("https://tiles.example.com/12/3/4.png");
  });

  it("rotates subdomains deterministically", () => {
    const a = expandTileUrl("https://{s}.tiles.example.com/{z}/{x}/{y}.png", { z: 1, x: 0, y: 0 });
    const b = expandTileUrl("https://{s}.tiles.example.com/{z}/{x}/{y}.png", { z: 1, x: 1, y: 0 });
    expect(a).toContain("//a.");
    expect(b).toContain("//b.");
  });
});
