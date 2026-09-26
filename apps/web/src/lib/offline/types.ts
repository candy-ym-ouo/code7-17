// 离线缓存模块共享类型。
import type { CacheMeta } from "./http-cache";

/** 与 GET /features 返回结构一致的地点（只缓存已审核发布内容）。 */
export interface CachedFeatureData {
  id: string;
  categoryKey: string;
  categoryName: string;
  title: string;
  description: string;
  longitude: number;
  latitude: number;
  condition: string;
  updatedAt: string;
  media: Array<{ id: string; url: string | null; thumbnailUrl: string | null }>;
  [key: string]: unknown;
}

export interface OfflineRegion {
  id: string;
  name: string;
  /** [west, south, east, north]，不跨 180°（跨半球请建两个选区） */
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  createdAt: number;
  /** 最近一次成功增量同步结束时刻（epoch ms），也是下次 since 游标 */
  lastSyncedAt: number | null;
  tileCount: number;
  bytes: number;
  /** 预取/同步进行标记，防止重复任务 */
  busy: boolean;
}

export interface CachedTile {
  key: string;
  z: number;
  x: number;
  y: number;
  blob: Blob;
  contentType: string;
  meta: CacheMeta;
  size: number;
  /** 由哪个选区预取；浏览时顺带缓存的瓦片为 null（LRU 优先回收） */
  regionId: string | null;
  savedAt: number;
}

export interface CachedFeature {
  id: string;
  data: CachedFeatureData;
  /** 服务端 updatedAt 的 epoch ms，同步合并的版本依据 */
  updatedAt: number;
  regionIds: string[];
  savedAt: number;
}

export interface FeatureTombstone {
  id: string;
  /** 服务端记录的删除/下线时刻，用于与 updatedAt 比较裁决 */
  updatedAt: number;
}

export interface PrefetchProgress {
  regionId: string;
  phase: "tiles" | "features" | "done" | "error";
  completed: number;
  total: number;
  failed: number;
  message?: string;
}

export interface SyncResult {
  syncedAt: number;
  upserted: number;
  deleted: number;
  tilesRevalidated: number;
  tilesChanged: number;
  /** 同步是否真正跑通（联网且服务端响应成功）；离线时为 false */
  ok: boolean;
  /** ok 为 false 时的原因说明 */
  message?: string;
}
