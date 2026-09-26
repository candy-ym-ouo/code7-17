/**
 * 瓦片离线缓存与 MapLibre 协议集成。
 *
 * - 通过 maplibregl.addProtocol("offline", ...) 透明拦截瓦片请求：
 *   缓存未过期直接命中；过期或缺失走网络，成功后写回缓存；
 *   网络失败时回退到过期缓存（可用性优先，但绝不反向覆盖新版本）。
 * - 写入保护：并发响应乱序到达时，fetchedAt 更旧的响应不得覆盖较新的缓存。
 * - 过期时间优先采用服务端 Cache-Control/Expires，否则使用默认 TTL。
 */
import maplibregl from "maplibre-gl";
import { dbBulkDelete, dbBulkPut, dbGet, dbGetAll, dbReadModifyWrite, STORES } from "./db";
import { tileKey, type TileCoord } from "./tileMath";

export type CachedTile = {
  /** "z/x/y" */
  key: string;
  url: string;
  data: ArrayBuffer;
  contentType: string;
  etag: string | null;
  /** 本地写入时刻（epoch ms）。 */
  fetchedAt: number;
  /** 过期时刻（epoch ms），来自响应头或默认 TTL。 */
  expiresAt: number;
};

/** 瓦片默认缓存 7 天；响应头给出更明确的过期时间时以服务端为准。 */
export const DEFAULT_TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const OFFLINE_PROTOCOL = "offline";
const SUBDOMAINS = ["a", "b", "c"];

/** 模板注册表：offline:// URL 只携带模板 id，避免在 URL 中编码任意字符。 */
const templates = new Map<string, string>();
let protocolRegistered = false;

function templateIdFor(template: string): string {
  let hash = 0;
  for (let index = 0; index < template.length; index += 1) {
    hash = (hash * 31 + template.charCodeAt(index)) >>> 0;
  }
  return `t${hash.toString(36)}`;
}

/** 把 https 瓦片模板转换为 offline:// 协议 URL，供 MapLibre source 使用。 */
export function toOfflineTileUrl(template: string): string {
  const id = templateIdFor(template);
  templates.set(id, template);
  return `${OFFLINE_PROTOCOL}://${id}/{z}/{x}/{y}`;
}

export function expandTileUrl(template: string, coord: TileCoord): string {
  const subdomain = SUBDOMAINS[(coord.x + coord.y) % SUBDOMAINS.length];
  return template
    .replace("{z}", String(coord.z))
    .replace("{x}", String(coord.x))
    .replace("{y}", String(coord.y))
    .replace("{s}", subdomain ?? "a");
}

function parseOfflineUrl(url: string): { template: string; coord: TileCoord } | null {
  const match = /^offline:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!match) return null;
  const template = templates.get(match[1]!);
  if (!template) return null;
  return {
    template,
    coord: { z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) }
  };
}

/** 解析响应过期时间；no-store 返回 null（不持久化），no-cache 立即过期（下次需校验）。 */
export function parseCacheExpiry(headers: Headers, now: number, defaultTtlMs: number = DEFAULT_TILE_TTL_MS): number | null {
  const cacheControl = headers.get("cache-control")?.toLowerCase() ?? "";
  if (cacheControl.includes("no-store")) return null;
  if (cacheControl.includes("no-cache")) return now;
  const maxAge = /max-age=(\d+)/.exec(cacheControl);
  if (maxAge) return now + Number(maxAge[1]) * 1000;
  const expires = headers.get("expires");
  if (expires) {
    const time = Date.parse(expires);
    if (!Number.isNaN(time)) return Math.max(time, now);
  }
  return now + defaultTtlMs;
}

export async function getCachedTile(key: string): Promise<CachedTile | undefined> {
  return dbGet<CachedTile>(STORES.tiles, key);
}

export function isTileFresh(tile: CachedTile, now: number = Date.now()): boolean {
  return tile.expiresAt > now;
}

/**
 * 写入瓦片。若已存在 fetchedAt 更新的记录（并发下旧响应后到），拒绝覆盖，
 * 保证过期/陈旧数据不会覆盖服务端新版本。
 */
export async function putTile(tile: CachedTile): Promise<boolean> {
  const { written } = await dbReadModifyWrite<CachedTile, CachedTile>(
    STORES.tiles,
    [tile],
    (item) => item.key,
    (existing, incoming) => (existing && existing.fetchedAt > incoming.fetchedAt ? null : incoming)
  );
  return written === 1;
}

async function fetchTile(url: string, etag: string | null, signal: AbortSignal): Promise<{
  status: "ok" | "not-modified";
  data?: ArrayBuffer;
  contentType?: string;
  etag: string | null;
  expiresAt: number | null;
}> {
  const headers = new Headers();
  if (etag) headers.set("If-None-Match", etag);
  const response = await fetch(url, { signal, headers });
  if (response.status === 304) {
    return { status: "not-modified", etag, expiresAt: parseCacheExpiry(response.headers, Date.now()) };
  }
  if (!response.ok) throw new Error(`瓦片请求失败：HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  return {
    status: "ok",
    data,
    contentType: response.headers.get("content-type") ?? "image/png",
    etag: response.headers.get("etag"),
    expiresAt: parseCacheExpiry(response.headers, Date.now())
  };
}

/**
 * 获取瓦片：新鲜缓存直接返回；否则网络优先，失败回退过期缓存。
 * 供协议处理器与预取共用。
 */
export async function loadTile(
  template: string,
  coord: TileCoord,
  signal?: AbortSignal
): Promise<{ data: ArrayBuffer; contentType: string; etag: string | null; fromCache: boolean; stale: boolean }> {
  const key = tileKey(coord);
  const url = expandTileUrl(template, coord);
  const now = Date.now();
  const cached = await getCachedTile(key);
  if (cached && isTileFresh(cached, now)) {
    return { data: cached.data, contentType: cached.contentType, etag: cached.etag, fromCache: true, stale: false };
  }

  try {
    const result = await fetchTile(url, cached?.etag ?? null, signal ?? new AbortController().signal);
    if (result.status === "not-modified" && cached) {
      // 服务端确认未变化：仅延长过期时间，保留原数据。
      const renewed: CachedTile = { ...cached, expiresAt: result.expiresAt ?? now + DEFAULT_TILE_TTL_MS, fetchedAt: now };
      await putTile(renewed);
      return { data: renewed.data, contentType: renewed.contentType, etag: renewed.etag, fromCache: true, stale: false };
    }
    if (result.data !== undefined) {
      if (result.expiresAt !== null) {
        await putTile({
          key,
          url,
          data: result.data,
          contentType: result.contentType ?? "image/png",
          etag: result.etag,
          fetchedAt: now,
          expiresAt: result.expiresAt
        });
      }
      return { data: result.data, contentType: result.contentType ?? "image/png", etag: result.etag, fromCache: false, stale: false };
    }
  } catch (error) {
    if (cached) {
      // 离线或服务端故障：回退到过期缓存，保证地图可用。
      return { data: cached.data, contentType: cached.contentType, etag: cached.etag, fromCache: true, stale: true };
    }
    throw error;
  }

  if (cached) {
    return { data: cached.data, contentType: cached.contentType, etag: cached.etag, fromCache: true, stale: true };
  }
  throw new Error("瓦片不可用");
}

/** 注册 offline:// 协议（幂等）。必须在创建 MapLibre 地图之前调用。 */
export function ensureOfflineProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  maplibregl.addProtocol(OFFLINE_PROTOCOL, async (params, abortController) => {
    const parsed = parseOfflineUrl(params.url);
    if (!parsed) throw new Error(`无法解析的离线瓦片地址：${params.url}`);
    const tile = await loadTile(parsed.template, parsed.coord, abortController.signal);
    return {
      data: tile.data,
      ...(tile.etag ? { etag: tile.etag } : {}),
      cacheControl: tile.stale ? "no-cache" : "max-age=86400"
    };
  });
}

export type PrefetchProgress = {
  total: number;
  done: number;
  skipped: number;
  failed: number;
};

export type PrefetchOptions = {
  signal?: AbortSignal;
  concurrency?: number;
  /** 跳过未过期缓存，默认 true。 */
  skipFresh?: boolean;
  onProgress?: (progress: PrefetchProgress) => void;
};

/**
 * 并发受限的瓦片预取。单瓦片失败不中断整体任务，失败计数通过进度回调上报。
 */
export async function prefetchTiles(
  template: string,
  coords: TileCoord[],
  options: PrefetchOptions = {}
): Promise<PrefetchProgress> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const skipFresh = options.skipFresh ?? true;
  const progress: PrefetchProgress = { total: coords.length, done: 0, skipped: 0, failed: 0 };
  const report = () => options.onProgress?.({ ...progress });

  const pending = [...coords];
  async function worker(): Promise<void> {
    while (pending.length > 0) {
      if (options.signal?.aborted) return;
      const coord = pending.shift();
      if (!coord) return;
      const key = tileKey(coord);
      try {
        if (skipFresh) {
          const cached = await getCachedTile(key);
          if (cached && isTileFresh(cached)) {
            progress.skipped += 1;
            progress.done += 1;
            report();
            continue;
          }
        }
        await loadTile(template, coord, options.signal);
        progress.done += 1;
      } catch {
        progress.failed += 1;
        progress.done += 1;
      }
      report();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, coords.length) }, () => worker()));
  return progress;
}

/** 仅重新校验已过期的瓦片（增量同步时调用）。 */
export async function refreshStaleTiles(
  template: string,
  keys: string[],
  options: PrefetchOptions = {}
): Promise<PrefetchProgress> {
  const now = Date.now();
  const wanted = new Set(keys);
  const all = await dbGetAll<CachedTile>(STORES.tiles);
  const freshKeys = new Set(all.filter((tile) => tile.expiresAt > now).map((tile) => tile.key));
  const stale: TileCoord[] = [];
  for (const key of wanted) {
    // 缺失或已过期的瓦片都需要重新下载。
    if (freshKeys.has(key)) continue;
    const parts = key.split("/").map(Number);
    if (parts.length === 3 && parts.every((part) => Number.isInteger(part))) {
      stale.push({ z: parts[0]!, x: parts[1]!, y: parts[2]! });
    }
  }
  return prefetchTiles(template, stale, { ...options, skipFresh: false });
}

export async function deleteTiles(keys: string[]): Promise<void> {
  await dbBulkDelete(STORES.tiles, keys);
}

export async function listTileKeys(): Promise<string[]> {
  const tiles = await dbGetAll<CachedTile>(STORES.tiles);
  return tiles.map((tile) => tile.key);
}

/** 清理过期瓦片；onlyOrphanedIn 提供仍被区域引用的 key，避免误删。 */
export async function sweepExpiredTiles(now: number = Date.now(), keepKeys: ReadonlySet<string> = new Set()): Promise<number> {
  const tiles = await dbGetAll<CachedTile>(STORES.tiles);
  const doomed = tiles
    .filter((tile) => tile.expiresAt <= now && !keepKeys.has(tile.key))
    .map((tile) => tile.key);
  if (doomed.length) await dbBulkDelete(STORES.tiles, doomed);
  return doomed.length;
}

export async function putTilesBulk(tiles: CachedTile[]): Promise<void> {
  await dbBulkPut(STORES.tiles, tiles);
}
