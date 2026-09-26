import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "./cache-store";
import { buildCacheMeta } from "./http-cache";
import { TileFetcher } from "./tile-fetcher";

const TEMPLATE = "https://tiles.example.com/{z}/{x}/{y}.png";
const COORD = { z: 1, x: 0, y: 0 };

function pngResponse(init: ResponseInit & { body?: ArrayBuffer } = {}): Response {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // 模拟 CORS 允许跨域读取瓦片（真实瓦片服务必须返回该头）
      "Access-Control-Allow-Origin": "*",
      ...init.headers
    },
    ...init
  });
}

describe("TileFetcher", () => {
  let store: MemoryCacheStore;
  let fetcher: TileFetcher;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = new MemoryCacheStore();
    fetcher = new TileFetcher(store, 1);
    // 工厂模式：每次调用返回新 Response（body 只能消费一次）
    fetchMock = vi.fn().mockImplementation(async () => pngResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("downloads a tile and stores blob + cache metadata", async () => {
    fetchMock.mockResolvedValue(pngResponse({ headers: { "Cache-Control": "max-age=3600" } }));
    const outcome = await fetcher.fetchTile(TEMPLATE, COORD, { regionId: "r1" });
    expect(outcome.fromNetwork).toBe(true);
    expect(outcome.status).toBe(200);
    const cached = await store.getTile("1/0/0");
    expect(cached).toBeDefined();
    expect(cached?.regionId).toBe("r1");
    expect(cached?.contentType).toBe("image/png");
    expect(cached?.size).toBe(4);
  });

  it("serves fresh tiles without touching the network", async () => {
    fetchMock.mockResolvedValue(pngResponse({ headers: { "Cache-Control": "max-age=3600" } }));
    await fetcher.fetchTile(TEMPLATE, COORD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const outcome = await fetcher.fetchTile(TEMPLATE, COORD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.fromNetwork).toBe(false);
  });

  it("sends conditional headers for stale tiles and accepts 304", async () => {
    fetchMock
      .mockResolvedValueOnce(
        pngResponse({ headers: { ETag: '"v1"', "Cache-Control": "no-cache" } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    await fetcher.fetchTile(TEMPLATE, COORD);
    const outcome = await fetcher.fetchTile(TEMPLATE, COORD);
    expect(outcome.status).toBe(304);
    const secondCallHeaders = fetchMock.mock.calls[1]![1].headers as Headers;
    expect(secondCallHeaders.get("If-None-Match")).toBe('"v1"');
    const cached = await store.getTile("1/0/0");
    expect(cached?.blob).toBeDefined();
  });

  it("never overwrites a newer cached tile when the response is older", async () => {
    fetchMock
      .mockResolvedValueOnce(
        pngResponse({
          headers: {
            ETag: '"new"',
            "Last-Modified": "Wed, 21 Oct 2020 07:28:00 GMT",
            "Cache-Control": "no-cache"
          }
        })
      )
      .mockResolvedValueOnce(
        pngResponse({
          headers: {
            ETag: '"old"',
            "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
            "Cache-Control": "no-cache"
          }
        })
      );
    await fetcher.fetchTile(TEMPLATE, COORD);
    const firstCached = await store.getTile("1/0/0");
    const outcome = await fetcher.fetchTile(TEMPLATE, COORD);
    const stillCached = await store.getTile("1/0/0");
    expect(stillCached?.meta.etag).toBe('"new"');
    expect(stillCached?.savedAt).toBe(firstCached?.savedAt);
    // 渲染仍得到（旧响应的）字节，但库未被降级覆盖。
    expect(outcome.blob).toBeDefined();
  });

  it("falls back to stale cache when the network fails", async () => {
    fetchMock
      .mockResolvedValueOnce(pngResponse({ headers: { "Cache-Control": "no-cache" } }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await fetcher.fetchTile(TEMPLATE, COORD);
    const outcome = await fetcher.fetchTile(TEMPLATE, COORD);
    expect(outcome.fromNetwork).toBe(false);
    expect(outcome.blob).toBeDefined();
  });

  it("throws when neither network nor cache can satisfy a tile", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetcher.fetchTile(TEMPLATE, COORD)).rejects.toThrow();
  });

  it("returns stale cache immediately and revalidates in the background", async () => {
    fetchMock
      .mockResolvedValueOnce(pngResponse({ headers: { "Cache-Control": "no-cache" } }))
      .mockImplementationOnce(
        async () =>
          new Response(new Uint8Array([9]) as unknown as BodyInit, {
            status: 200,
            headers: {
              ETag: '"v2"',
              "Cache-Control": "no-cache",
              "Content-Type": "image/png",
              "Access-Control-Allow-Origin": "*"
            }
          })
      );
    await fetcher.fetchTile(TEMPLATE, COORD);
    const outcome = await fetcher.fetchTile(TEMPLATE, COORD, { backgroundRevalidate: true });
    expect(outcome.fromNetwork).toBe(false); // 立即返回缓存
    // 轮询等待后台任务真正完成写库，而不是依赖固定时序
    await vi.waitFor(async () => {
      const cached = await store.getTile("1/0/0");
      expect(cached?.meta.etag).toBe('"v2"');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not persist no-store responses", async () => {
    fetchMock.mockResolvedValue(pngResponse({ headers: { "Cache-Control": "no-store" } }));
    await fetcher.fetchTile(TEMPLATE, COORD);
    expect(await store.getTile("1/0/0")).toBeUndefined();
  });

  it("builds metadata through buildCacheMeta", () => {
    const meta = buildCacheMeta(
      "u",
      new Response(null, { headers: { "Cache-Control": "max-age=10", ETag: '"x"' } }),
      0
    );
    expect(meta.noStore).toBe(false);
    expect(meta.maxAgeMs).toBe(10_000);
  });
});
