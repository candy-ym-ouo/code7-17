/**
 * 增量同步管理器。
 *
 * 网络恢复（online 事件）、页面重新可见或定时器触发时，逐选区执行：
 * 1. 以选区游标调用 /features/sync 拉取增量（upserts + deletedIds）；
 * 2. 合并写入本地缓存——版本裁决保证过期缓存不覆盖服务端新版；
 * 3. 重新校验过期瓦片（携带 ETag 条件请求）；
 * 4. 全部成功后推进选区游标（取各分块 serverTime 最小值）。
 *
 * 同步全程串行，重复触发会被合并，避免竞态写。
 */
import { dbPut, STORES } from "./db";
import { applySyncChanges, queryCachedFeatures } from "./featureCache";
import { fetchSyncChunk, listRegions, type OfflineRegion } from "./regions";
import { refreshStaleTiles, sweepExpiredTiles } from "./tileCache";
import { splitBBox } from "./tileMath";

const CHUNK_GRID_ZOOM = 7;
const MIN_SYNC_INTERVAL_MS = 60 * 1000;

export type RegionSyncResult = {
  regionId: string;
  ok: boolean;
  upserts: number;
  deleted: number;
  rejectedStale: number;
  tilesRefreshed: number;
  error: string | null;
};

export type SyncListener = (event: { type: "region-start" | "region-done" | "done"; result?: RegionSyncResult }) => void;

let syncInFlight: Promise<RegionSyncResult[]> | null = null;
let lastSyncFinishedAt = 0;

/** 同步单个选区；region.lastSyncedAt 为 null 时应走 prefetchRegion 全量预取。 */
export async function syncRegion(
  region: OfflineRegion,
  tileTemplate: string,
  signal?: AbortSignal
): Promise<RegionSyncResult> {
  const result: RegionSyncResult = {
    regionId: region.id,
    ok: false,
    upserts: 0,
    deleted: 0,
    rejectedStale: 0,
    tilesRefreshed: 0,
    error: null
  };
  if (!region.lastSyncedAt) {
    result.error = "选区尚未完成首次预取";
    return result;
  }

  try {
    const chunks = splitBBox(region.bbox, CHUNK_GRID_ZOOM);
    let cursor = region.lastSyncedAt;
    for (const chunk of chunks) {
      if (signal?.aborted) return { ...result, error: "已取消" };
      const batch = await fetchSyncChunk(chunk, region.lastSyncedAt, signal);
      const applied = await applySyncChanges(batch.upserts, batch.deletedIds);
      result.upserts += applied.written;
      result.deleted += applied.deleted;
      result.rejectedStale += applied.rejectedStale;
      // 各分块游标取最小值，保证任何一块的变更窗口都不被跳过。
      if (batch.cursor < cursor) cursor = batch.cursor;
    }

    const tileProgress = await refreshStaleTiles(tileTemplate, region.tileKeys, {
      ...(signal ? { signal } : {})
    });
    result.tilesRefreshed = tileProgress.done - tileProgress.failed - tileProgress.skipped;

    // 同步后按缓存实际数量校准展示值（upserts 含更新，deleted 含未缓存 id）。
    const cachedInRegion = await queryCachedFeatures(region.bbox);
    const updated: OfflineRegion = {
      ...region,
      status: "ready",
      lastSyncedAt: cursor,
      featureCount: cachedInRegion.length,
      error: null
    };
    await dbPut(STORES.regions, updated);
    result.ok = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : "同步失败";
    return result;
  }
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/**
 * 同步所有就绪选区。并发调用共享同一个进行中的同步任务。
 */
export function syncAllRegions(
  tileTemplate: string,
  listener?: SyncListener
): Promise<RegionSyncResult[]> {
  if (syncInFlight) return syncInFlight;
  if (!isOnline()) return Promise.resolve([]);

  syncInFlight = (async () => {
    const results: RegionSyncResult[] = [];
    try {
      const regions = await listRegions();
      for (const region of regions) {
        if (!isOnline()) break;
        if (region.status !== "ready" || !region.lastSyncedAt) continue;
        listener?.({ type: "region-start" });
        const result = await syncRegion(region, tileTemplate);
        results.push(result);
        listener?.({ type: "region-done", result });
      }
      // 清理不再被任何选区引用的过期瓦片，控制存储体积。
      const referenced = new Set(regions.flatMap((region) => region.tileKeys));
      await sweepExpiredTiles(Date.now(), referenced).catch(() => 0);
      lastSyncFinishedAt = Date.now();
      listener?.({ type: "done" });
      return results;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

/**
 * 启动自动同步：网络恢复、页面重新可见时触发；返回停止函数。
 * 两次自动同步之间至少间隔 MIN_SYNC_INTERVAL_MS，避免频繁打满配额。
 */
export function startAutoSync(tileTemplate: string, listener?: SyncListener): () => void {
  const trigger = () => {
    if (!isOnline()) return;
    if (Date.now() - lastSyncFinishedAt < MIN_SYNC_INTERVAL_MS) return;
    void syncAllRegions(tileTemplate, listener);
  };
  const onOnline = () => trigger();
  const onVisibility = () => {
    if (document.visibilityState === "visible") trigger();
  };

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);
  const interval = window.setInterval(trigger, 5 * 60 * 1000);

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(interval);
  };
}
