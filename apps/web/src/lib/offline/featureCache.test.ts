import { describe, expect, it } from "vitest";
import {
  planCacheWrites,
  shouldReplaceCached,
  staleReason,
  type CachedFeature,
  type OfflineFeaturePayload
} from "./featureCache";

function payload(id: string, updatedAt: string, overrides: Partial<OfflineFeaturePayload> = {}): OfflineFeaturePayload {
  return {
    id,
    categoryKey: "bench",
    categoryName: "长椅",
    title: `地点 ${id}`,
    description: "",
    condition: "good",
    longitude: 116.4,
    latitude: 39.9,
    updatedAt,
    ...overrides
  };
}

function cached(id: string, updatedAt: string, overrides: Partial<CachedFeature> = {}): CachedFeature {
  return {
    id,
    updatedAt,
    freshnessExpiresAt: null,
    fetchedAt: 1_000,
    expiresAt: 1_000 + 60_000,
    longitude: 116.4,
    latitude: 39.9,
    categoryKey: "bench",
    payload: payload(id, updatedAt),
    ...overrides
  };
}

describe("shouldReplaceCached（过期缓存不能覆盖服务端新版）", () => {
  it("accepts writes into an empty cache", () => {
    expect(shouldReplaceCached(undefined, { updatedAt: "2026-09-01T00:00:00Z" })).toBe(true);
  });

  it("accepts strictly newer server versions", () => {
    const existing = { updatedAt: "2026-09-01T00:00:00Z" };
    expect(shouldReplaceCached(existing, { updatedAt: "2026-09-02T00:00:00Z" })).toBe(true);
  });

  it("accepts equal versions (idempotent re-fetch)", () => {
    const existing = { updatedAt: "2026-09-01T00:00:00Z" };
    expect(shouldReplaceCached(existing, { updatedAt: "2026-09-01T00:00:00Z" })).toBe(true);
  });

  it("rejects stale cache writes over newer server versions", () => {
    const existing = { updatedAt: "2026-09-02T00:00:00Z" };
    expect(shouldReplaceCached(existing, { updatedAt: "2026-09-01T00:00:00Z" })).toBe(false);
  });

  it("rejects unparseable incoming versions and replaces unparseable existing ones", () => {
    expect(shouldReplaceCached({ updatedAt: "2026-09-01T00:00:00Z" }, { updatedAt: "not-a-date" })).toBe(false);
    expect(shouldReplaceCached({ updatedAt: "not-a-date" }, { updatedAt: "2026-09-01T00:00:00Z" })).toBe(true);
  });
});

describe("planCacheWrites", () => {
  const now = 1_000_000;

  it("writes new features with TTL metadata", () => {
    const plan = planCacheWrites(new Map(), [payload("a", "2026-09-01T00:00:00Z")], [], now, 60_000);
    expect(plan.toWrite).toHaveLength(1);
    expect(plan.toWrite[0]).toMatchObject({ id: "a", fetchedAt: now, expiresAt: now + 60_000 });
    expect(plan.rejectedStale).toEqual([]);
  });

  it("rejects stale upserts that would roll back a newer cached version", () => {
    const existing = new Map([["a", cached("a", "2026-09-02T00:00:00Z")]]);
    const plan = planCacheWrites(existing, [payload("a", "2026-09-01T00:00:00Z")], [], now);
    expect(plan.toWrite).toEqual([]);
    expect(plan.rejectedStale).toEqual(["a"]);
  });

  it("applies newer upserts over older cached versions", () => {
    const existing = new Map([["a", cached("a", "2026-09-01T00:00:00Z")]]);
    const plan = planCacheWrites(existing, [payload("a", "2026-09-03T00:00:00Z")], [], now);
    expect(plan.toWrite.map((item) => item.id)).toEqual(["a"]);
  });

  it("delete wins when an id appears in both upserts and deletedIds", () => {
    const existing = new Map([["a", cached("a", "2026-09-01T00:00:00Z")]]);
    const plan = planCacheWrites(existing, [payload("a", "2026-09-03T00:00:00Z")], ["a"], now);
    expect(plan.toWrite).toEqual([]);
    expect(plan.toDelete).toEqual(["a"]);
  });

  it("only deletes ids that exist in cache", () => {
    const plan = planCacheWrites(new Map(), [], ["ghost"], now);
    expect(plan.toDelete).toEqual([]);
  });
});

describe("staleReason", () => {
  const now = 10_000;

  it("is fresh before TTL and business freshness expire", () => {
    const entry = cached("a", "2026-09-01T00:00:00Z", {
      expiresAt: now + 1,
      freshnessExpiresAt: new Date(now + 60_000).toISOString()
    });
    expect(staleReason(entry, now)).toBeNull();
  });

  it("is stale after cache TTL", () => {
    const entry = cached("a", "2026-09-01T00:00:00Z", { expiresAt: now - 1 });
    expect(staleReason(entry, now)).toBe("ttl");
  });

  it("is stale after business freshness expiry", () => {
    const entry = cached("a", "2026-09-01T00:00:00Z", {
      expiresAt: now + 60_000,
      freshnessExpiresAt: new Date(now - 1).toISOString()
    });
    expect(staleReason(entry, now)).toBe("freshness");
  });
});
