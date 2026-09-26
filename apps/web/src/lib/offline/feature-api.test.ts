import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "./cache-store";
import {
  applySyncBatch,
  mergeFeaturesIntoStore,
  queryCachedFeatures,
  toEpochMs,
  type SyncResponse
} from "./feature-api";
import type { CachedFeatureData } from "./types";

function makeFeature(id: string, updatedAt: string, lng = 116.4, lat = 39.9): CachedFeatureData {
  return {
    id,
    categoryKey: "bench",
    categoryName: "长椅",
    title: `地点 ${id}`,
    description: "",
    longitude: lng,
    latitude: lat,
    condition: "good",
    updatedAt,
    media: []
  };
}

function syncResponse(
  features: CachedFeatureData[],
  removed: Array<{ id: string; updatedAt: string }> = [],
  serverTime = "2026-01-02T00:00:00.000Z"
): SyncResponse {
  return { serverTime, hasMore: false, nextCursor: null, features, removed };
}

describe("mergeFeaturesIntoStore", () => {
  it("inserts new features", async () => {
    const store = new MemoryCacheStore();
    const result = await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-01-01T00:00:00Z")], "region-1");
    expect(result.upserted).toBe(1);
    const stored = await store.getFeature("a");
    expect(stored?.updatedAt).toBe(toEpochMs("2026-01-01T00:00:00Z"));
    expect(stored?.regionIds).toEqual(["region-1"]);
  });

  it("never overwrites a newer cached feature with an older payload", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-03-01T00:00:00Z")], "r1");
    const result = await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-01-01T00:00:00Z")], "r2");
    expect(result.upserted).toBe(0);
    expect(result.skipped).toBe(1);
    const stored = await store.getFeature("a");
    expect(stored?.updatedAt).toBe(toEpochMs("2026-03-01T00:00:00Z"));
  });

  it("updates when the incoming payload is newer", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-01-01T00:00:00Z")], null);
    const result = await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-05-01T00:00:00Z")], null);
    expect(result.upserted).toBe(1);
  });

  it("associates additional regions even when the payload is unchanged", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-01-01T00:00:00Z")], "r1");
    await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-01-01T00:00:00Z")], "r2");
    const stored = await store.getFeature("a");
    expect(stored?.regionIds).toEqual(["r1", "r2"]);
  });

  it("refuses to resurrect a feature newer tombstones say was removed", async () => {
    const store = new MemoryCacheStore();
    await store.putTombstone({ id: "a", updatedAt: toEpochMs("2026-06-01T00:00:00Z") });
    const result = await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-01-01T00:00:00Z")], null);
    expect(result.upserted).toBe(0);
    expect(await store.getFeature("a")).toBeUndefined();
  });

  it("accepts a feature whose updatedAt is newer than the tombstone (re-published)", async () => {
    const store = new MemoryCacheStore();
    await store.putTombstone({ id: "a", updatedAt: toEpochMs("2026-01-01T00:00:00Z") });
    const result = await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-06-01T00:00:00Z")], null);
    expect(result.upserted).toBe(1);
  });
});

describe("applySyncBatch", () => {
  it("deletes features listed in removed when the tombstone is newer", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-01-01T00:00:00Z")], null);
    const result = await applySyncBatch(
      store,
      syncResponse([], [{ id: "a", updatedAt: "2026-02-01T00:00:00Z" }])
    );
    expect(result.deleted).toBe(1);
    expect(await store.getFeature("a")).toBeUndefined();
    expect(await store.getTombstone("a")).toBeDefined();
  });

  it("keeps the feature when an out-of-order removal is older than the cached version", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(store, [makeFeature("a", "2026-06-01T00:00:00Z")], null);
    const result = await applySyncBatch(
      store,
      syncResponse([], [{ id: "a", updatedAt: "2026-01-01T00:00:00Z" }])
    );
    expect(result.deleted).toBe(0);
    expect(await store.getFeature("a")).toBeDefined();
  });

  it("upserts and removes in one batch using timestamps", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(
      store,
      [makeFeature("a", "2026-01-01T00:00:00Z"), makeFeature("b", "2026-01-01T00:00:00Z")],
      null
    );
    const result = await applySyncBatch(
      store,
      syncResponse(
        [makeFeature("a", "2026-03-01T00:00:00Z")],
        [{ id: "b", updatedAt: "2026-03-01T00:00:00Z" }]
      )
    );
    expect(result.upserted).toBe(1);
    expect(result.deleted).toBe(1);
  });

  it("a later sync cannot resurrect a removed feature with a stale payload", async () => {
    const store = new MemoryCacheStore();
    await applySyncBatch(
      store,
      syncResponse([makeFeature("a", "2026-01-01T00:00:00Z")], [])
    );
    await applySyncBatch(
      store,
      syncResponse([], [{ id: "a", updatedAt: "2026-05-01T00:00:00Z" }])
    );
    // 乱序重放的旧增量页
    const replay = await applySyncBatch(
      store,
      syncResponse([makeFeature("a", "2026-01-01T00:00:00Z")], [])
    );
    expect(replay.upserted).toBe(0);
    expect(await store.getFeature("a")).toBeUndefined();
  });
});

describe("queryCachedFeatures", () => {
  it("filters by bbox and category and sorts by newest first", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(
      store,
      [
        makeFeature("old", "2026-01-01T00:00:00Z", 116.40, 39.90),
        makeFeature("new", "2026-02-01T00:00:00Z", 116.42, 39.92),
        makeFeature("far", "2026-03-01T00:00:00Z", 100.0, 10.0)
      ],
      null
    );
    const result = await queryCachedFeatures(store, [116.3, 39.8, 116.5, 40.0]);
    expect(result.map((f) => f.id)).toEqual(["new", "old"]);

    const filtered = await queryCachedFeatures(store, [116.3, 39.8, 116.5, 40.0], "drinking_water");
    expect(filtered).toEqual([]);
  });

  it("handles antimeridian-crossing bbox", async () => {
    const store = new MemoryCacheStore();
    await mergeFeaturesIntoStore(store, [makeFeature("p1", "2026-01-01T00:00:00Z", 175, 0)], null);
    await mergeFeaturesIntoStore(store, [makeFeature("p2", "2026-01-01T00:00:00Z", -175, 0)], null);
    await mergeFeaturesIntoStore(store, [makeFeature("p3", "2026-01-01T00:00:00Z", 0, 0)], null);
    const result = await queryCachedFeatures(store, [170, -1, -170, 1]);
    expect(result.map((f) => f.id).sort()).toEqual(["p1", "p2"]);
  });
});
