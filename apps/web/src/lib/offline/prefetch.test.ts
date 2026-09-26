import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "./cache-store";
import { TileFetcher } from "./tile-fetcher";
import {
  DEFAULT_MAX_TILES,
  planRegion,
  PrefetchAbortedError,
  PrefetchQuotaError,
  prefetchRegion
} from "./prefetch";
import type { OfflineRegion } from "./types";

vi.mock("../api", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
  uploadFile: vi.fn()
}));

import { apiFetch } from "../api";
import type { CachedFeatureData } from "./types";

const TEMPLATE = "https://tiles.example.com/{z}/{x}/{y}.png";

function pngResponse(): Response {
  return new Response(new Uint8Array([1, 2]) as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "max-age=3600",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/** 每次调用都返回全新 Response（body 只能读一次，不能复用实例）。 */
function pngFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async () => pngResponse());
}

function makeRegion(overrides: Partial<OfflineRegion> = {}): OfflineRegion {
  return {
    id: "r1",
    name: "测试选区",
    bounds: [116.3, 39.8, 116.4, 39.9],
    minZoom: 0,
    maxZoom: 8,
    createdAt: 0,
    lastSyncedAt: null,
    tileCount: 0,
    bytes: 0,
    busy: false,
    ...overrides
  };
}

const feature: CachedFeatureData = {
  id: "00000000-0000-0000-0000-000000000001",
  categoryKey: "bench",
  categoryName: "长椅",
  title: "x",
  description: "",
  longitude: 116.35,
  latitude: 39.85,
  condition: "good",
  updatedAt: "2026-01-01T00:00:00Z",
  media: []
};

describe("planRegion", () => {
  it("enumerates tiles for the zoom range", () => {
    const plan = planRegion([116.3, 39.8, 116.4, 39.9], 10, 12);
    expect(plan.tileCount).toBeGreaterThan(0);
    expect(plan.tiles.length).toBe(plan.tileCount);
    expect(plan.tiles[0]!.z).toBe(10);
  });

  it("rejects selections exceeding the tile budget", () => {
    expect(() => planRegion([-180, -85, 180, 85], 0, 14, 100)).toThrow(PrefetchQuotaError);
    expect(DEFAULT_MAX_TILES).toBeGreaterThan(0);
  });
});

describe("prefetchRegion", () => {
  let store: MemoryCacheStore;
  let fetcher: TileFetcher;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = new MemoryCacheStore();
    fetcher = new TileFetcher(store, 1);
    fetchMock = pngFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue([feature] as never);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("downloads all tiles tagged with the region and stores features", async () => {
    const region = makeRegion({ minZoom: 0, maxZoom: 4 });
    const result = await prefetchRegion(store, fetcher, { region, tileTemplate: TEMPLATE, concurrency: 4 });
    expect(result.failedTiles).toBe(0);
    expect(result.features).toHaveLength(1);
    const keys = await store.listTileKeysForRegion("r1");
    expect(fetchMock.mock.calls.length).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
    const savedRegion = await store.getRegion("r1");
    expect(savedRegion?.busy).toBe(false);
    expect(savedRegion?.lastSyncedAt).not.toBeNull();
    expect(savedRegion?.tileCount).toBe(keys.length);
  });

  it("reports progress ending in done", async () => {
    const events: Array<{ phase: string; completed: number; total: number }> = [];
    await prefetchRegion(store, fetcher, {
      region: makeRegion(),
      tileTemplate: TEMPLATE,
      onProgress: (p) => events.push({ phase: p.phase, completed: p.completed, total: p.total })
    });
    expect(events[0]!.phase).toBe("tiles");
    expect(events[events.length - 1]!.phase).toBe("done");
    const last = events[events.length - 1]!;
    expect(last.completed).toBe(last.total);
  });

  it("keeps going when a tile download fails", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new TypeError("network down");
      return pngResponse();
    });
    const result = await prefetchRegion(store, fetcher, {
      region: makeRegion({ minZoom: 0, maxZoom: 4 }),
      tileTemplate: TEMPLATE
    });
    expect(result.failedTiles).toBe(1);
  });

  it("aborts mid-run when the signal triggers and clears busy flag", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(pngResponse());
    });
    await expect(
      prefetchRegion(store, fetcher, { region: makeRegion(), tileTemplate: TEMPLATE, signal: controller.signal })
    ).rejects.toThrow(PrefetchAbortedError);
    const savedRegion = await store.getRegion("r1");
    expect(savedRegion?.busy).toBe(false);
  });
});
