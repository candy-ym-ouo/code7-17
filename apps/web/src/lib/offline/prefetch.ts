// 选区预取：按 bbox + 缩放级别批量下载瓦片，并同步拉取范围内全部已发布地点。
import type { CacheStore } from "./cache-store";
import {
  enumerateTilesForZooms,
  estimateTileCount,
  splitBounds,
  type TileCoord
} from "./tile-math";
import { TileFetcher } from "./tile-fetcher";
import { fetchFeaturesInBounds, mergeFeaturesIntoStore } from "./feature-api";
import type { CachedFeatureData, OfflineRegion, PrefetchProgress } from "./types";

export interface PrefetchOptions {
  region: OfflineRegion;
  tileTemplate: string;
  /** 并发瓦片下载数，默认 6 */
  concurrency?: number;
  /** 预取瓦片数量硬上限，防止误选过大区域耗尽存储 */
  maxTiles?: number;
  onProgress?: (progress: PrefetchProgress) => void;
  signal?: AbortSignal;
}

export const DEFAULT_MAX_TILES = 6000;

export class PrefetchAbortedError extends Error {
  constructor() {
    super("预取已取消");
    this.name = "PrefetchAbortedError";
  }
}

export class PrefetchQuotaError extends Error {
  constructor(public readonly tileCount: number, public readonly limit: number) {
    super(`选区需要 ${tileCount} 张瓦片，超过上限 ${limit}`);
    this.name = "PrefetchQuotaError";
  }
}

/** 预检：估算瓦片数，不发起网络请求。 */
export function planRegion(
  bounds: [number, number, number, number],
  minZoom: number,
  maxZoom: number,
  maxTiles = DEFAULT_MAX_TILES
): { tiles: TileCoord[]; tileCount: number } {
  const tileCount = estimateTileCount(bounds, minZoom, maxZoom);
  if (tileCount > maxTiles) throw new PrefetchQuotaError(tileCount, maxTiles);
  return { tiles: enumerateTilesForZooms(bounds, minZoom, maxZoom), tileCount };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldAbort?: () => boolean
): Promise<{ results: R[]; failures: number }> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failures = 0;

  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      if (shouldAbort?.()) return;
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index]!, index);
      } catch {
        failures += 1;
      }
    }
  });
  await Promise.all(runners);
  return { results, failures };
}

/**
 * 执行选区预取。瓦片失败计入 failed 但不中断（个别瓦片失败不致命）；
 * 地点拉取失败会抛出，因为离线地点是核心能力。
 */
export async function prefetchRegion(
  store: CacheStore,
  fetcher: TileFetcher,
  options: PrefetchOptions
): Promise<{ failedTiles: number; features: CachedFeatureData[] }> {
  const { region, tileTemplate, signal, onProgress } = options;
  const concurrency = options.concurrency ?? 6;
  const maxTiles = options.maxTiles ?? DEFAULT_MAX_TILES;

  const { tiles } = planRegion(region.bounds, region.minZoom, region.maxZoom, maxTiles);

  const throwIfAborted = () => {
    if (signal?.aborted) throw new PrefetchAbortedError();
  };

  await store.putRegion({ ...region, busy: true, tileCount: tiles.length });

  let completed = 0;
  let failed = 0;
  throwIfAborted();
  const { failures } = await mapWithConcurrency(
    tiles,
    concurrency,
    async (coord) => {
      throwIfAborted();
      // 预取必须走网络验证，不允许 backgroundRevalidate 提前返回旧瓦片。
      await fetcher.fetchTile(tileTemplate, coord, {
        regionId: region.id,
        ...(signal ? { signal } : {})
      });
      completed += 1;
      onProgress?.({
        regionId: region.id,
        phase: "tiles",
        completed,
        total: tiles.length,
        failed
      });
    },
    () => signal?.aborted ?? false
  );
  failed = failures;
  if (signal?.aborted) {
    await store.putRegion({ ...region, busy: false });
    throw new PrefetchAbortedError();
  }

  // 地点：按 5° 切块（服务端单次 bbox 上限），逐块拉取并并入缓存。
  const chunks = splitBounds(region.bounds, 5);
  const allFeatures: CachedFeatureData[] = [];
  for (const chunk of chunks) {
    throwIfAborted();
    const batch = await fetchFeaturesInBounds(chunk, signal);
    await mergeFeaturesIntoStore(store, batch, region.id);
    allFeatures.push(...batch);
  }

  const totalBytes = await store.tilesTotalBytes();
  await store.putRegion({
    ...region,
    busy: false,
    tileCount: tiles.length,
    bytes: totalBytes,
    lastSyncedAt: Date.now()
  });
  onProgress?.({
    regionId: region.id,
    phase: "done",
    completed: tiles.length,
    total: tiles.length,
    failed,
    message: `已缓存 ${allFeatures.length} 个地点`
  });
  return { failedTiles: failed, features: allFeatures };
}
