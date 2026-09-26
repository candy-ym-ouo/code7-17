/**
 * 地点（地图要素）离线缓存。
 *
 * 核心不变式：过期缓存不能覆盖服务端新版。
 * - 写入时逐条比较 updatedAt，只有不旧于已存版本的数据才允许落盘；
 * - 版本比较在单个 IndexedDB 事务内完成（读-比较-写），避免并发回退；
 * - 读取时按 TTL 与业务时效标记 stale，网络可用时由同步管理器刷新。
 */
import { dbBulkDelete, dbGet, dbGetAll, dbReadModifyWrite, STORES } from "./db";
import { bboxContains, type BBox } from "./tileMath";

/** 与 GET /features 响应元素结构一致。 */
export type OfflineFeaturePayload = {
  id: string;
  categoryKey: string;
  categoryName: string;
  categoryIcon?: string | null;
  title: string;
  description: string;
  condition: string;
  longitude: number;
  latitude: number;
  updatedAt: string;
  freshnessExpiresAt?: string | null;
  details?: unknown;
  tags?: unknown;
  media?: Array<{ id: string; url: string | null; thumbnailUrl: string | null }>;
};

export type CachedFeature = {
  id: string;
  /** 服务端版本时间戳（ISO），版本比较的唯一依据。 */
  updatedAt: string;
  /** 业务时效（可能过期关闭/失效），仅用于 stale 标记。 */
  freshnessExpiresAt: string | null;
  /** 本地写入时刻（epoch ms）。 */
  fetchedAt: number;
  /** 本地缓存过期时刻（epoch ms），过期后网络可用时必须刷新。 */
  expiresAt: number;
  longitude: number;
  latitude: number;
  categoryKey: string;
  payload: OfflineFeaturePayload;
};

/** 地点缓存默认 TTL：7 天。 */
export const FEATURE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 版本裁决：仅当写入版本不旧于已存版本时允许覆盖。
 * 相等也覆盖（同一服务端版本的重复拉取，幂等）。
 */
export function shouldReplaceCached(
  existing: { updatedAt: string } | undefined,
  incoming: { updatedAt: string }
): boolean {
  if (!existing) return true;
  const existingTime = Date.parse(existing.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  if (Number.isNaN(incomingTime)) return false;
  if (Number.isNaN(existingTime)) return true;
  return incomingTime >= existingTime;
}

export type CacheWritePlan = {
  toWrite: CachedFeature[];
  toDelete: string[];
  /** 因版本过旧被拒绝的 id（过期缓存不能覆盖新版）。 */
  rejectedStale: string[];
};

/**
 * 纯函数：根据已存记录、增量 upserts 与删除集合计算写计划。
 * deletedIds 优先于 upserts（同一 id 同时出现时按删除处理）。
 */
export function planCacheWrites(
  existingById: ReadonlyMap<string, CachedFeature>,
  upserts: OfflineFeaturePayload[],
  deletedIds: string[],
  now: number,
  ttlMs: number = FEATURE_CACHE_TTL_MS
): CacheWritePlan {
  const deleted = new Set(deletedIds);
  const toWrite: CachedFeature[] = [];
  const rejectedStale: string[] = [];

  for (const feature of upserts) {
    if (deleted.has(feature.id)) continue;
    const existing = existingById.get(feature.id);
    if (!shouldReplaceCached(existing, feature)) {
      rejectedStale.push(feature.id);
      continue;
    }
    toWrite.push({
      id: feature.id,
      updatedAt: feature.updatedAt,
      freshnessExpiresAt: feature.freshnessExpiresAt ?? null,
      fetchedAt: now,
      expiresAt: now + ttlMs,
      longitude: feature.longitude,
      latitude: feature.latitude,
      categoryKey: feature.categoryKey,
      payload: feature
    });
  }

  // 只删除确实存在的记录，避免无意义的事务操作。
  const toDelete = deletedIds.filter((id) => existingById.has(id));
  return { toWrite, toDelete, rejectedStale };
}

function toCachedFeature(feature: OfflineFeaturePayload, now: number, ttlMs: number): CachedFeature {
  return {
    id: feature.id,
    updatedAt: feature.updatedAt,
    freshnessExpiresAt: feature.freshnessExpiresAt ?? null,
    fetchedAt: now,
    expiresAt: now + ttlMs,
    longitude: feature.longitude,
    latitude: feature.latitude,
    categoryKey: feature.categoryKey,
    payload: feature
  };
}

/**
 * 批量写入（预取/同步共用）。版本比较与写入在同一事务中完成。
 * 返回被拒绝的过期数据条数。
 */
export async function upsertFeatures(
  features: OfflineFeaturePayload[],
  options: { now?: number; ttlMs?: number } = {}
): Promise<{ written: number; rejectedStale: number }> {
  if (features.length === 0) return { written: 0, rejectedStale: 0 };
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? FEATURE_CACHE_TTL_MS;
  let rejectedStale = 0;
  const { written } = await dbReadModifyWrite<CachedFeature, OfflineFeaturePayload>(
    STORES.features,
    features,
    (feature) => feature.id,
    (existing, feature) => {
      if (!shouldReplaceCached(existing, feature)) {
        rejectedStale += 1;
        return null;
      }
      return toCachedFeature(feature, now, ttlMs);
    }
  );
  return { written, rejectedStale };
}

/** 应用一次增量同步：先删后写，写走版本裁决。 */
export async function applySyncChanges(
  upserts: OfflineFeaturePayload[],
  deletedIds: string[],
  options: { now?: number; ttlMs?: number } = {}
): Promise<{ written: number; deleted: number; rejectedStale: number }> {
  const deletedSet = new Set(deletedIds);
  const effectiveUpserts = deletedSet.size
    ? upserts.filter((feature) => !deletedSet.has(feature.id))
    : upserts;
  if (deletedIds.length) await dbBulkDelete(STORES.features, deletedIds);
  const { written, rejectedStale } = await upsertFeatures(effectiveUpserts, options);
  return { written, deleted: deletedIds.length, rejectedStale };
}

export async function getCachedFeature(id: string): Promise<CachedFeature | undefined> {
  return dbGet<CachedFeature>(STORES.features, id);
}

/** 视野查询：离线回退时按 bbox 与分类过滤。 */
export async function queryCachedFeatures(bbox: BBox, categoryKey?: string): Promise<OfflineFeaturePayload[]> {
  const all = await dbGetAll<CachedFeature>(STORES.features);
  return all
    .filter((item) => bboxContains(bbox, item.longitude, item.latitude))
    .filter((item) => !categoryKey || item.categoryKey === categoryKey)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((item) => item.payload);
}

export type StaleReason = "ttl" | "freshness";

export function staleReason(cached: CachedFeature, now: number = Date.now()): StaleReason | null {
  if (cached.expiresAt <= now) return "ttl";
  if (cached.freshnessExpiresAt && Date.parse(cached.freshnessExpiresAt) <= now) return "freshness";
  return null;
}

/** 统计缓存中已过期的记录 id，供同步管理器决定刷新范围。 */
export async function findStaleFeatureIds(now: number = Date.now()): Promise<string[]> {
  const all = await dbGetAll<CachedFeature>(STORES.features);
  return all.filter((item) => staleReason(item, now) !== null).map((item) => item.id);
}

/** 清理长期未访问且已过期的缓存记录，返回清理条数。 */
export async function sweepExpiredFeatures(now: number = Date.now()): Promise<number> {
  const all = await dbGetAll<CachedFeature>(STORES.features);
  const doomed = all.filter((item) => item.expiresAt <= now).map((item) => item.id);
  if (doomed.length) await dbBulkDelete(STORES.features, doomed);
  return doomed.length;
}
