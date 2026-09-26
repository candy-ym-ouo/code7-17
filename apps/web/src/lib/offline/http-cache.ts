// HTTP 缓存新鲜度语义（RFC 9111 子集）。
// 纯函数，便于单测；输入为响应头，输出新鲜度判定与条件请求头。
// 瓦片按保守策略处理：不信任 `must-revalidate` 之外的可变内容，
// 且任何同步写入都必须再经过版本比较（见 sync.ts）。

export interface CacheMeta {
  url: string;
  /** 响应 ETag（含引号的原始形式） */
  etag?: string;
  /** Last-Modified 原始日期串 */
  lastModified?: string;
  /** Date 响应头时间戳（ms），缺省由调用方填 fetch 时刻 */
  fetchedAt: number;
  /** Date 头时间戳（ms） */
  dateAt?: number;
  maxAgeMs?: number;
  /** no-cache：可存但每次用前必须重验证 */
  noCache: boolean;
  /** no-store：根本不应落盘 */
  noStore: boolean;
  /** 资源的显式过期时间戳（ms），来自 Expires */
  expiresAt?: number;
  status: number;
}

export interface ParsedCacheControl {
  noStore: boolean;
  noCache: boolean;
  maxAgeMs?: number;
}

export function parseCacheControl(header: string | null | undefined): ParsedCacheControl {
  const result: ParsedCacheControl = { noStore: false, noCache: false };
  if (!header) return result;
  for (const directive of header.split(",")) {
    const [rawName, rawValue] = directive.split("=");
    const name = rawName?.trim().toLowerCase();
    const value = rawValue?.trim().replace(/^"|"$/g, "");
    if (name === "no-store") result.noStore = true;
    else if (name === "no-cache") result.noCache = true;
    else if (name === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) result.maxAgeMs = seconds * 1000;
    }
  }
  return result;
}

export function buildCacheMeta(url: string, response: Response, fetchedAt: number): CacheMeta {
  const cc = parseCacheControl(response.headers.get("cache-control"));
  const expiresHeader = response.headers.get("expires");
  const dateHeader = response.headers.get("date");
  let expiresAt: number | undefined;
  if (expiresHeader) {
    const t = Date.parse(expiresHeader);
    if (Number.isFinite(t)) expiresAt = t;
  }
  let dateAt: number | undefined;
  if (dateHeader) {
    const t = Date.parse(dateHeader);
    if (Number.isFinite(t)) dateAt = t;
  }
  const meta: CacheMeta = {
    url,
    fetchedAt,
    noCache: cc.noCache,
    noStore: cc.noStore,
    status: response.status
  };
  const etag = response.headers.get("etag");
  if (etag) meta.etag = etag;
  const lastModified = response.headers.get("last-modified");
  if (lastModified) meta.lastModified = lastModified;
  if (cc.maxAgeMs !== undefined) meta.maxAgeMs = cc.maxAgeMs;
  if (expiresAt !== undefined) meta.expiresAt = expiresAt;
  if (dateAt !== undefined) meta.dateAt = dateAt;
  return meta;
}

/**
 * 资源在 now 时刻是否新鲜（无需联网即可用）。
 * max-age 优先于 Expires；no-cache 总是视为需重验证。
 */
export function isFresh(meta: CacheMeta, now: number): boolean {
  if (meta.noCache || meta.noStore) return false;
  const ageBase = meta.dateAt ?? meta.fetchedAt;
  if (meta.maxAgeMs !== undefined) {
    return now < ageBase + meta.maxAgeMs;
  }
  if (meta.expiresAt !== undefined) return now < meta.expiresAt;
  // 无显式新鲜度提示：瓦片默认视为过期，必须走条件请求确认。
  return false;
}

/** 携带条件请求头，支持 304。 */
export function conditionalHeaders(meta: CacheMeta | undefined): Headers {
  const headers = new Headers();
  if (meta?.etag) headers.set("If-None-Match", meta.etag);
  if (meta?.lastModified) headers.set("If-Modified-Since", meta.lastModified);
  return headers;
}

/**
 * 判断刚取回的响应是否确实比缓存新。
 * 这是“过期缓存不能覆盖服务端新版”的第二道防线：
 * 即便本地逻辑误判，ETag 相同 / Last-Modified 回退也禁止降级写入。
 */
export function isResponseNewer(cached: CacheMeta | undefined, incoming: CacheMeta): boolean {
  if (!cached) return true;
  if (cached.etag && incoming.etag) {
    // ETag 相同 => 同一份内容，不需要写。
    if (cached.etag === incoming.etag) return false;
    // ETag 不同，以 Last-Modified/Date 裁决；缺失时信任新响应。
  }
  const cachedTime = Date.parse(cached.lastModified ?? "");
  const incomingTime = Date.parse(incoming.lastModified ?? "");
  if (Number.isFinite(cachedTime) && Number.isFinite(incomingTime)) {
    if (incomingTime < cachedTime) return false;
  }
  return true;
}
