// 地点数据：在线拉取、版本化合并、离线空间查询。
//
// 合并不变量（“过期缓存不能覆盖服务端新版”）：
// - 只有当传入记录的 updatedAt 严格新于本地记录时才覆盖；
// - 本地存在更新墓碑且墓碑不旧时，任何记录都不能让该地点“复活”；
// - 旧时间戳的删除也不能删掉较新的地点（墓碑本身同样按时间裁决）。
import type { CacheStore } from "./cache-store";
import { apiFetch } from "../api";
import type { CachedFeatureData } from "./types";

export interface SyncRemovedEntry {
  id: string;
  updatedAt: string;
}

export interface SyncResponse {
  serverTime: string;
  hasMore: boolean;
  /** 服务端给的下一页游标（ISO 字符串）；hasMore 为 false 时为 null */
  nextCursor: string | null;
  features: CachedFeatureData[];
  removed: SyncRemovedEntry[];
}

export function toEpochMs(value: string | Date): number {
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(t)) throw new Error(`非法时间戳: ${String(value)}`);
  return t;
}

/** 在线：拉取某个 bbox 内全部已发布地点（与 MapPage 使用同一端点）。 */
export async function fetchFeaturesInBounds(
  bounds: [number, number, number, number],
  signal?: AbortSignal
): Promise<CachedFeatureData[]> {
  const bbox = bounds.map((v) => v.toFixed(6)).join(",");
  const query = new URLSearchParams({ bbox, limit: "500" });
  return await apiFetch<CachedFeatureData[]>(
    `/features?${query}`,
    signal ? { signal } : {}
  );
}

/** 在线：增量同步端点。失败（含 404 旧后端）向上抛，由 sync 引擎决定降级策略。 */
export async function fetchSyncPage(
  cursor: string | number | null,
  signal?: AbortSignal
): Promise<SyncResponse> {
  const query = new URLSearchParams({ limit: "1000" });
  if (cursor !== null) query.set("since", typeof cursor === "number" ? new Date(cursor).toISOString() : cursor);
  return await apiFetch<SyncResponse>(
    `/features/sync?${query}`,
    signal ? { signal } : {}
  );
}

/**
 * 版本安全地写入一批地点（用于预取后的全量落库和增量合并）。
 * 返回实际新增/更新的条数。
 */
export async function mergeFeaturesIntoStore(
  store: CacheStore,
  incoming: CachedFeatureData[],
  regionId: string | null
): Promise<{ upserted: number; skipped: number }> {
  let upserted = 0;
  let skipped = 0;
  for (const data of incoming) {
    const incomingTime = toEpochMs(data.updatedAt);
    const existing = await store.getFeature(data.id);
    if (existing && existing.updatedAt >= incomingTime) {
      // 本地相同或更新：不降级。仍要把新选区关联上（预取新区域时）。
      if (regionId && !existing.regionIds.includes(regionId)) {
        existing.regionIds.push(regionId);
        await store.putFeature(existing);
      }
      skipped += 1;
      continue;
    }
    const tombstone = await store.getTombstone(data.id);
    if (tombstone && tombstone.updatedAt >= incomingTime) {
      // 本地有更新或同时间的删除/下线记录：拒绝“复活”。
      skipped += 1;
      continue;
    }
    const regionIds = new Set(existing?.regionIds ?? []);
    if (regionId) regionIds.add(regionId);
    await store.putFeature({
      id: data.id,
      data,
      updatedAt: incomingTime,
      regionIds: [...regionIds],
      savedAt: Date.now()
    });
    upserted += 1;
  }
  return { upserted, skipped };
}

/** 应用服务端同步结果（增量 upsert + 墓碑删除）。 */
export async function applySyncBatch(
  store: CacheStore,
  batch: SyncResponse
): Promise<{ upserted: number; deleted: number }> {
  const { upserted } = await mergeFeaturesIntoStore(store, batch.features, null);

  let deleted = 0;
  for (const entry of batch.removed) {
    const removedAt = toEpochMs(entry.updatedAt);
    const existing = await store.getFeature(entry.id);
    // 只有删除时刻比本地内容新才真正删除，防止乱序/旧消息删掉新版本。
    if (existing && existing.updatedAt < removedAt) {
      await store.deleteFeature(entry.id);
      deleted += 1;
    }
    await store.putTombstone({ id: entry.id, updatedAt: removedAt });
  }
  return { upserted, deleted };
}

/** 离线/在线通用：读取缓存中落在 bbox 内的地点。 */
export async function queryCachedFeatures(
  store: CacheStore,
  bounds: [number, number, number, number],
  categoryKey?: string
): Promise<CachedFeatureData[]> {
  const [west, south, east, north] = bounds;
  const crosses = west > east;
  const inLng = (lng: number): boolean =>
    crosses ? lng >= west || lng <= east : lng >= west && lng <= east;
  const all = await store.listFeatures();
  return all
    .map((f) => f.data)
    .filter((d) => {
      if (!inLng(d.longitude)) return false;
      if (d.latitude < south || d.latitude > north) return false;
      if (categoryKey && d.categoryKey !== categoryKey) return false;
      return true;
    })
    .sort((a, b) => toEpochMs(b.updatedAt) - toEpochMs(a.updatedAt));
}
