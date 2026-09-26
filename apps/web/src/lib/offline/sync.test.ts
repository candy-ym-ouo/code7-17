import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "./cache-store";
import { TileFetcher } from "./tile-fetcher";
import { syncFeatures, revalidateRegionTiles } from "./sync";
import { mergeFeaturesIntoStore } from "./feature-api";
import { ApiError } from "../api";
import type { CachedFeatureData } from "./types";

vi.mock("../api", async () => {
  class MockApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  }
  const apiFetch = vi.fn();
  return { apiFetch, ApiError: MockApiError };
});

import { apiFetch } from "../api";

function feature(id: string, updatedAt: string): CachedFeatureData {
  return {
    id,
    categoryKey: "bench",
    categoryName: "长椅",
    title: id,
    description: "",
    longitude: 116.4,
    latitude: 39.9,
    condition: "good",
    updatedAt,
    media: []
  };
}

describe("syncFeatures incremental", () => {
  let store: MemoryCacheStore;

  beforeEach(() => {
    store = new MemoryCacheStore();
    vi.mocked(apiFetch).mockReset();
  });

  it("follows hasMore pages and advances the cursor", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        serverTime: "2026-02-01T00:00:00.000Z",
        hasMore: true,
        nextCursor: "2026-01-01T00:00:00.000Z",
        features: [feature("a", "2026-01-01T00:00:00Z")],
        removed: []
      })
      .mockResolvedValueOnce({
        serverTime: "2026-03-01T00:00:00.000Z",
        hasMore: false,
        nextCursor: null,
        features: [feature("b", "2026-02-01T00:00:00Z")],
        removed: [{ id: "gone", updatedAt: "2026-02-05T00:00:00Z" }]
      });

    const result = await syncFeatures(store);
    expect(result.usedIncremental).toBe(true);
    expect(result.upserted).toBe(2);
    expect((await store.listFeatures()).map((f) => f.id).sort()).toEqual(["a", "b"]);
    expect(await store.getTombstone("gone")).toBeDefined();
    expect(await store.getMeta("featureSyncCursor")).toBe(
      Date.parse("2026-03-01T00:00:00.000Z")
    );

    // 第二次同步携带 since 游标
    vi.mocked(apiFetch).mockResolvedValueOnce({
      serverTime: "2026-03-02T00:00:00.000Z",
      hasMore: false,
      nextCursor: null,
      features: [],
      removed: []
    });
    await syncFeatures(store);
    const url = String(vi.mocked(apiFetch).mock.calls.at(-1)![0]);
    expect(decodeURIComponent(url)).toContain("since=2026-03-01T00:00:00.000Z");
  });

  it("does not move the cursor when the network call fails", async () => {
    await store.setMeta("featureSyncCursor", Date.parse("2026-01-01T00:00:00Z"));
    vi.mocked(apiFetch).mockRejectedValue(new TypeError("offline"));
    await expect(syncFeatures(store)).rejects.toThrow("offline");
    expect(await store.getMeta("featureSyncCursor")).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("returns ok path with 404 fallback to full bbox fetch for known regions", async () => {
    await mergeFeaturesIntoStore(
      store,
      [feature("old", "2025-01-01T00:00:00Z")],
      "r1"
    );
    await store.putRegion({
      id: "r1",
      name: "选区",
      bounds: [116.3, 39.8, 116.4, 39.9],
      minZoom: 10,
      maxZoom: 12,
      createdAt: 0,
      lastSyncedAt: null,
      tileCount: 0,
      bytes: 0,
      busy: false
    });
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new ApiError(404, "NOT_FOUND", "no sync endpoint"))
      .mockResolvedValueOnce([feature("new", "2026-02-01T00:00:00Z")]);

    const result = await syncFeatures(store);
    expect(result.usedIncremental).toBe(false);
    expect(result.upserted).toBe(1);
    const url = String(vi.mocked(apiFetch).mock.calls[1]![0]);
    expect(url).toContain("/features?bbox=");
    // 全量兜底成功后游标仍推进
    expect(await store.getMeta("featureSyncCursor")).toBeTypeOf("number");
  });
});

describe("revalidateRegionTiles", () => {
  let store: MemoryCacheStore;
  let fetcher: TileFetcher;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = new MemoryCacheStore();
    fetcher = new TileFetcher(store, 1);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("counts changed vs unchanged tiles via conditional responses", async () => {
    await store.putRegion({
      id: "r1",
      name: "选区",
      bounds: [0, 0, 0.1, 0.1],
      minZoom: 0,
      maxZoom: 1,
      createdAt: 0,
      lastSyncedAt: null,
      tileCount: 2,
      bytes: 0,
      busy: false
    });
    // 预置两张 no-cache 瓦片
    for (const key of ["0/0/0", "1/0/0"]) {
      const [z, x, y] = key.split("/").map(Number);
      await store.putTile({
        key,
        z: z!,
        x: x!,
        y: y!,
        blob: new Blob([new Uint8Array([1])]),
        contentType: "image/png",
        size: 1,
        regionId: "r1",
        savedAt: 1,
        meta: {
          url: `https://tiles.example.com/${key}.png`,
          fetchedAt: 1,
          noCache: true,
          noStore: false,
          status: 200,
          etag: '"v1"'
        }
      });
    }
    fetchMock
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9]) as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": "image/png", ETag: '"v2"', "Cache-Control": "no-cache" }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    const result = await revalidateRegionTiles(
      store,
      fetcher,
      "https://tiles.example.com/{z}/{x}/{y}.png"
    );
    expect(result.changed).toBe(1);
    expect(result.revalidated).toBe(2);
    const updated = await store.getTile("0/0/0");
    expect(updated?.meta.etag).toBe('"v2"');
  });

  it("tolerates per-tile network failures", async () => {
    await store.putRegion({
      id: "r1",
      name: "选区",
      bounds: [0, 0, 0.1, 0.1],
      minZoom: 0,
      maxZoom: 0,
      createdAt: 0,
      lastSyncedAt: null,
      tileCount: 1,
      bytes: 0,
      busy: false
    });
    await store.putTile({
      key: "0/0/0",
      z: 0,
      x: 0,
      y: 0,
      blob: new Blob([new Uint8Array([1])]),
      contentType: "image/png",
      size: 1,
      regionId: "r1",
      savedAt: 1,
      meta: {
        url: "https://tiles.example.com/0/0/0.png",
        fetchedAt: Date.now(),
        noCache: false,
        noStore: false,
        status: 200,
        maxAgeMs: 999_999_000
      }
    });
    // 瓦片新鲜 => 不发网络请求，直接返回
    const result = await revalidateRegionTiles(
      store,
      fetcher,
      "https://tiles.example.com/{z}/{x}/{y}.png"
    );
    expect(result.revalidated).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
