/**
 * 离线选区管理：按 bbox 与缩放级别范围预取瓦片和地点。
 *
 * - 选区的瓦片集合在创建时计算并持久化，供增量同步刷新；
 * - 地点通过 /features/sync 分块拉取（服务端 bbox 跨度限制 5°，
 *   按 z=7 瓦片网格切分后每块约 2.8°，满足限制）；
 * - 删除选区时仅清理不被其他选区引用的瓦片。
 */
import { apiFetch } from "../api";
import { dbDelete, dbGet, dbGetAll, dbPut, STORES } from "./db";
import { applySyncChanges, type OfflineFeaturePayload } from "./featureCache";
import { prefetchTiles, deleteTiles, type PrefetchProgress } from "./tileCache";
import { countTiles, splitBBox, tilesForBBox, tileKey, type BBox } from "./tileMath";

export type OfflineRegion = {
  id: string;
  name: string;
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
  createdAt: number;
  /** 增量同步游标（服务端时间，ISO）。null 表示尚未完成首次预取。 */
  lastSyncedAt: string | null;
  tileKeys: string[];
  status: "downloading" | "ready" | "error";
  tileCount: number;
  featureCount: number;
  error: string | null;
};

/** 单选区瓦片数上限，防止误选过大范围拖垮存储与流量。 */
export const MAX_TILES_PER_REGION = 2000;
/** 地点分块拉取时的网格级别：z=7 瓦片约 2.8°，小于服务端 5° 限制。 */
const CHUNK_GRID_ZOOM = 7;
const SYNC_PAGE_LIMIT = 500;

export type SyncBatchResponse = {
  serverTime: string;
  hasMore: boolean;
  upserts: OfflineFeaturePayload[];
  deletedIds: string[];
};

export function estimateTileCount(bbox: BBox, minZoom: number, maxZoom: number): number {
  return countTiles(bbox, minZoom, maxZoom);
}

export async function listRegions(): Promise<OfflineRegion[]> {
  const regions = await dbGetAll<OfflineRegion>(STORES.regions);
  return regions.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRegion(id: string): Promise<OfflineRegion | undefined> {
  return dbGet<OfflineRegion>(STORES.regions, id);
}

export async function saveRegion(region: OfflineRegion): Promise<void> {
  await dbPut(STORES.regions, region);
}

export function validateRegionSpec(bbox: BBox, minZoom: number, maxZoom: number): string | null {
  const [west, south, east, north] = bbox;
  if (!(west < east) || !(south < north)) return "选区范围无效";
  if (east - west > 20 || north - south > 20) return "选区过大，请缩小到 20° 范围内";
  if (minZoom < 0 || maxZoom > 19 || minZoom > maxZoom) return "缩放级别范围无效";
  const tiles = countTiles(bbox, minZoom, maxZoom);
  if (tiles > MAX_TILES_PER_REGION) return `瓦片数量 ${tiles} 超出上限 ${MAX_TILES_PER_REGION}，请缩小范围或降低缩放级别`;
  return null;
}

export async function createRegion(spec: {
  name: string;
  bbox: BBox;
  minZoom: number;
  maxZoom: number;
}): Promise<OfflineRegion> {
  const invalid = validateRegionSpec(spec.bbox, spec.minZoom, spec.maxZoom);
  if (invalid) throw new Error(invalid);
  const tiles = tilesForBBox(spec.bbox, spec.minZoom, spec.maxZoom);
  const region: OfflineRegion = {
    id: crypto.randomUUID(),
    name: spec.name.trim() || "未命名区域",
    bbox: spec.bbox,
    minZoom: spec.minZoom,
    maxZoom: spec.maxZoom,
    createdAt: Date.now(),
    lastSyncedAt: null,
    tileKeys: tiles.map(tileKey),
    status: "downloading",
    tileCount: 0,
    featureCount: 0,
    error: null
  };
  await saveRegion(region);
  return region;
}

/**
 * 分页拉取一个 bbox 块的全部增量（或全量，当 since 缺省时）。
 * 返回合并后的 upserts/deletedIds 与该块的同步游标。
 */
export async function fetchSyncChunk(
  bbox: BBox,
  since: string | null,
  signal?: AbortSignal
): Promise<{ upserts: OfflineFeaturePayload[]; deletedIds: string[]; cursor: string }> {
  const upserts: OfflineFeaturePayload[] = [];
  const deletedIds: string[] = [];
  let cursor = since;
  // hasMore 分页：游标推进到本页最后一条的 updatedAt，继续拉直到取完。
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({
      bbox: bbox.map((value) => value.toFixed(6)).join(","),
      limit: String(SYNC_PAGE_LIMIT)
    });
    if (cursor) query.set("since", cursor);
    const batch = await apiFetch<SyncBatchResponse>(`/features/sync?${query}`, signal ? { signal } : {});
    upserts.push(...batch.upserts);
    deletedIds.push(...batch.deletedIds);
    cursor = batch.serverTime;
    if (!batch.hasMore) break;
  }
  if (!cursor) throw new Error("同步响应缺少 serverTime");
  return { upserts, deletedIds, cursor };
}

export type RegionPrefetchProgress = {
  phase: "tiles" | "features";
  tiles: PrefetchProgress;
  featureCount: number;
};

/**
 * 执行选区预取：先瓦片后地点。失败时选区标记 error，可重试。
 */
export async function prefetchRegion(
  regionId: string,
  tileTemplate: string,
  options: { signal?: AbortSignal; onProgress?: (progress: RegionPrefetchProgress) => void } = {}
): Promise<OfflineRegion> {
  const region = await getRegion(regionId);
  if (!region) throw new Error("离线区域不存在");

  const coords = region.tileKeys.map((key) => {
    const [z, x, y] = key.split("/").map(Number);
    return { z: z!, x: x!, y: y! };
  });

  const progress: RegionPrefetchProgress = {
    phase: "tiles",
    tiles: { total: coords.length, done: 0, skipped: 0, failed: 0 },
    featureCount: 0
  };
  const report = () => options.onProgress?.({ ...progress, tiles: { ...progress.tiles } });

  try {
    progress.tiles = await prefetchTiles(tileTemplate, coords, {
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (tiles) => {
        progress.tiles = tiles;
        report();
      }
    });
    if (options.signal?.aborted) return region;

    progress.phase = "features";
    report();

    // 分块全量拉取地点；游标取各块 serverTime 的最小值，保证不丢窗口。
    const chunks = splitBBox(region.bbox, CHUNK_GRID_ZOOM);
    const cursors: string[] = [];
    let featureCount = 0;
    for (const chunk of chunks) {
      if (options.signal?.aborted) return region;
      const batch = await fetchSyncChunk(chunk, null, options.signal);
      const { written } = await applySyncChanges(batch.upserts, batch.deletedIds);
      featureCount += written;
      cursors.push(batch.cursor);
      progress.featureCount = featureCount;
      report();
    }
    const cursor = cursors.length ? cursors.reduce((min, value) => (value < min ? value : min)) : null;

    const finished: OfflineRegion = {
      ...region,
      status: "ready",
      lastSyncedAt: cursor,
      tileCount: progress.tiles.done - progress.tiles.failed,
      featureCount,
      error: progress.tiles.failed > 0 ? `${progress.tiles.failed} 个瓦片下载失败` : null
    };
    await saveRegion(finished);
    return finished;
  } catch (error) {
    const failed: OfflineRegion = {
      ...region,
      status: "error",
      error: error instanceof Error ? error.message : "预取失败"
    };
    await saveRegion(failed);
    throw error;
  }
}

/**
 * 启动时恢复：页面关闭后留在 "downloading" 的选区不可能仍在运行，
 * 标记为可重试（已下载的瓦片在下一次预取时会被跳过，不浪费流量）。
 */
export async function resetInterruptedDownloads(): Promise<number> {
  const regions = await listRegions();
  const stuck = regions.filter((region) => region.status === "downloading");
  for (const region of stuck) {
    await saveRegion({ ...region, status: "error", error: "下载被中断，请重试" });
  }
  return stuck.length;
}

/** 删除选区，并清理不再被其他选区引用的瓦片。 */
export async function deleteRegion(regionId: string): Promise<void> {
  const region = await getRegion(regionId);
  if (!region) return;
  const others = (await listRegions()).filter((item) => item.id !== regionId);
  const referenced = new Set(others.flatMap((item) => item.tileKeys));
  const orphaned = region.tileKeys.filter((key) => !referenced.has(key));
  await deleteTiles(orphaned);
  await dbDelete(STORES.regions, regionId);
}
