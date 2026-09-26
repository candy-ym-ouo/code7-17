// 增量同步引擎：网络恢复后把服务端变化（含删除/下线）合并进本地缓存，
// 并对选区瓦片发起条件重验证。所有写入都走 feature-api 的版本裁决。
import { ApiError } from "../api";
import type { CacheStore } from "./cache-store";
import { TileFetcher } from "./tile-fetcher";
import { fetchFeaturesInBounds, fetchSyncPage, applySyncBatch, toEpochMs } from "./feature-api";
import { parseTileKey, splitBounds } from "./tile-math";
import type { SyncResult } from "./types";

const SYNC_CURSOR_KEY = "featureSyncCursor";
const FULL_FETCH_CHUNK_SPAN = 5;

async function getCursor(store: CacheStore): Promise<string | number | null> {
  return (await store.getMeta<string | number>(SYNC_CURSOR_KEY)) ?? null;
}

/**
 * 优先走服务端增量游标分页；旧后端没有 /features/sync（404）时，
 * 按全部选区 bbox 切块做真实全量拉取（项目不允许 mock 数据）。
 * 网络错误向上抛，调用方据此把结果标记为 ok:false。
 */
export async function syncFeatures(
  store: CacheStore,
  signal?: AbortSignal
): Promise<{ upserted: number; deleted: number; syncedAt: number; usedIncremental: boolean }> {
  let upserted = 0;
  let deleted = 0;
  let usedIncremental = true;
  let syncedAt = Date.now();

  try {
    let cursor = await getCursor(store);
    let pageCount = 0;
    for (;;) {
      if (signal?.aborted) throw new Error("同步已取消");
      const page = await fetchSyncPage(cursor, signal);
      syncedAt = toEpochMs(page.serverTime);
      const applied = await applySyncBatch(store, page);
      upserted += applied.upserted;
      deleted += applied.deleted;
      pageCount += 1;
      if (!page.hasMore || !page.nextCursor) break;
      // 服务端权威游标；同时间戳行会在下一页重复返回，merge 按版本去重，不漏不降级。
      cursor = page.nextCursor;
      if (pageCount > 200) break; // 安全上限，下次 online 事件继续
    }
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
    usedIncremental = false;
    const regions = await store.listRegions();
    for (const region of regions) {
      if (signal?.aborted) throw new Error("同步已取消");
      for (const chunk of splitBounds(region.bounds, FULL_FETCH_CHUNK_SPAN)) {
        const batch = await fetchFeaturesInBounds(chunk, signal);
        const merged = await applySyncBatch(store, {
          serverTime: new Date().toISOString(),
          hasMore: false,
          nextCursor: null,
          features: batch,
          removed: []
        });
        upserted += merged.upserted;
      }
    }
    syncedAt = Date.now();
  }

  // 游标只在整轮成功后推进，失败重试不会漏变更（服务端用严格大于比较）。
  await store.setMeta(SYNC_CURSOR_KEY, syncedAt);
  return { upserted, deleted, syncedAt, usedIncremental };
}

/**
 * 对选区瓦片做条件重验证（If-None-Match / If-Modified-Since）。
 * 离线静默跳过；只统计真正发生变化的瓦片；旧响应在 fetcher 层已被拒绝覆盖。
 */
export async function revalidateRegionTiles(
  store: CacheStore,
  fetcher: TileFetcher,
  tileTemplate: string,
  signal?: AbortSignal
): Promise<{ revalidated: number; changed: number }> {
  const regions = await store.listRegions();
  let revalidated = 0;
  let changed = 0;
  for (const region of regions) {
    if (signal?.aborted) break;
    const keys = await store.listTileKeysForRegion(region.id);
    for (const key of keys) {
      if (signal?.aborted) break;
      const coord = parseTileKey(key);
      if (!coord) continue;
      try {
        const outcome = await fetcher.fetchTile(tileTemplate, coord, {
          regionId: region.id,
          ...(signal ? { signal } : {})
        });
        if (outcome.fromNetwork) {
          revalidated += 1;
          if (outcome.status === 200 && outcome.changed) changed += 1;
        }
      } catch {
        // 单瓦片失败不影响整体同步结果。
      }
    }
    await store.putRegion({ ...region, lastSyncedAt: Date.now() });
  }
  return { revalidated, changed };
}

export function buildSyncResult(
  features: { upserted: number; deleted: number },
  tiles: { revalidated: number; changed: number },
  syncedAt: number
): SyncResult {
  return {
    syncedAt,
    upserted: features.upserted,
    deleted: features.deleted,
    tilesRevalidated: tiles.revalidated,
    tilesChanged: tiles.changed,
    ok: true
  };
}
