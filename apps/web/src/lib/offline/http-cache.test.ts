import { describe, expect, it } from "vitest";
import {
  buildCacheMeta,
  conditionalHeaders,
  isFresh,
  isResponseNewer,
  parseCacheControl,
  type CacheMeta
} from "./http-cache";

const baseMeta = (overrides: Partial<CacheMeta> = {}): CacheMeta => ({
  url: "https://tiles.example.com/1/0/0.png",
  fetchedAt: 1_000_000,
  noCache: false,
  noStore: false,
  status: 200,
  ...overrides
});

describe("parseCacheControl", () => {
  it("reads directives case-insensitively", () => {
    const parsed = parseCacheControl("public, max-age=3600");
    expect(parsed.noStore).toBe(false);
    expect(parsed.maxAgeMs).toBe(3_600_000);
  });

  it("flags no-store and no-cache", () => {
    expect(parseCacheControl("no-store").noStore).toBe(true);
    expect(parseCacheControl("No-Cache").noCache).toBe(true);
  });

  it("ignores invalid max-age", () => {
    expect(parseCacheControl("max-age=abc").maxAgeMs).toBeUndefined();
    expect(parseCacheControl(null)).toEqual({ noStore: false, noCache: false });
  });
});

describe("isFresh", () => {
  it("is fresh inside the max-age window measured from Date header", () => {
    const meta = baseMeta({ dateAt: 10_000, maxAgeMs: 1000 });
    expect(isFresh(meta, 10_500)).toBe(true);
    expect(isFresh(meta, 11_500)).toBe(false);
  });

  it("falls back to fetchedAt when Date is missing", () => {
    const meta = baseMeta({ fetchedAt: 10_000, maxAgeMs: 1000 });
    expect(isFresh(meta, 10_999)).toBe(true);
  });

  it("uses Expires when no max-age present", () => {
    const meta = baseMeta({ fetchedAt: 0, expiresAt: 5_000 });
    expect(isFresh(meta, 4_999)).toBe(true);
    expect(isFresh(meta, 5_001)).toBe(false);
  });

  it("always revalidates no-cache and never serves no-store", () => {
    expect(isFresh(baseMeta({ noCache: true, maxAgeMs: 9_999_999 }), 0)).toBe(false);
    expect(isFresh(baseMeta({ noStore: true, maxAgeMs: 9_999_999 }), 0)).toBe(false);
  });

  it("treats missing freshness hints as stale (conservative)", () => {
    expect(isFresh(baseMeta({}), 10_000_000)).toBe(false);
  });
});

describe("buildCacheMeta", () => {
  it("extracts etag, last-modified and freshness headers", () => {
    const response = new Response("x", {
      headers: {
        ETag: '"abc123"',
        "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
        "Cache-Control": "max-age=60",
        "Content-Type": "image/png"
      }
    });
    const meta = buildCacheMeta("u", response, 1_000);
    expect(meta.etag).toBe('"abc123"');
    expect(meta.lastModified).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(meta.maxAgeMs).toBe(60_000);
    expect(meta.status).toBe(200);
  });
});

describe("conditionalHeaders", () => {
  it("attaches both validators when known", () => {
    const headers = conditionalHeaders(
      baseMeta({ etag: '"v1"', lastModified: "Wed, 21 Oct 2015 07:28:00 GMT" })
    );
    expect(headers.get("If-None-Match")).toBe('"v1"');
    expect(headers.get("If-Modified-Since")).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("is empty when nothing is cached", () => {
    expect([...conditionalHeaders(undefined).entries()]).toEqual([]);
  });
});

describe("isResponseNewer", () => {
  it("accepts when there is no cached version", () => {
    expect(isResponseNewer(undefined, baseMeta())).toBe(true);
  });

  it("rejects same-ETag responses (304-equivalent content)", () => {
    const cached = baseMeta({ etag: '"v1"' });
    const incoming = baseMeta({ etag: '"v1"' });
    expect(isResponseNewer(cached, incoming)).toBe(false);
  });

  it("uses Last-Modified to refuse downgrading to older content", () => {
    const cached = baseMeta({
      etag: '"v2"',
      lastModified: "Wed, 21 Oct 2020 07:28:00 GMT"
    });
    const older = baseMeta({
      etag: '"v1"',
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT"
    });
    expect(isResponseNewer(cached, older)).toBe(false);
  });

  it("accepts genuinely newer content", () => {
    const cached = baseMeta({
      etag: '"v1"',
      lastModified: "Wed, 21 Oct 2015 07:28:00 GMT"
    });
    const newer = baseMeta({
      etag: '"v2"',
      lastModified: "Wed, 21 Oct 2020 07:28:00 GMT"
    });
    expect(isResponseNewer(cached, newer)).toBe(true);
  });

  it("trusts incoming when validators are absent", () => {
    expect(isResponseNewer(baseMeta(), baseMeta())).toBe(true);
  });
});
