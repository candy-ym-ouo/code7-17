// 瓦片网络层：缓存优先 + 条件请求重验证，预取与运行时渲染共用同一套规则。
//
// 关键不变量：
// 1. 离线或网络错误时，任何已缓存瓦片（哪怕过期）都可以用，地图不碎。
// 2. 在线且成功响应时，只有“确实更新”的内容才允许写库（ETag/Last-Modified
//    双重裁决），陈旧或降级的响应永远不能覆盖较新的缓存。
// 3. no-store 响应不落盘。
import {
  buildCacheMeta,
  conditionalHeaders,
  isFresh,
  isResponseNewer,
  type CacheMeta
} from "./http-cache";
import type { CacheStore } from "./cache-store";
import { tileKey, type TileCoord } from "./tile-math";

export const OFFLINE_TILE_SCHEME = "mapoffline://tile";

export interface TileFetchOutcome {
  blob: Blob;
  contentType: string;
  /** 本次调用是否产生了网络请求 */
  fromNetwork: boolean;
  /** 网络响应是否改变了缓存内容 */
  changed: boolean;
  status: number;
}

export interface TileFetchOptions {
  signal?: AbortSignal;
  /** 标记瓦片由哪个选区预取；浏览顺带缓存传 null */
  regionId?: string | null;
  /** 过期缓存时是否后台静默重验证（运行时 true；预取时应在线等待结果） */
  backgroundRevalidate?: boolean;
}

/** 生成预取使用的瓦片地址（应用瓦片模板替换 {z}/{x}/{y}）。 */
export function expandTileUrl(
  template: string,
  coord: TileCoord,
  pixelRatio: number
): string {
  return template
    .replace("{z}", String(coord.z))
    .replace("{x}", String(coord.x))
    .replace("{y}", String(coord.y))
    .replace("{ratio}", pixelRatio >= 2 ? "2" : "1")
    .replace("{r}", pixelRatio >= 2 ? "@2x" : "");
}

/**
 * 从具体瓦片 URL 反推 {z}/{x}/{y} 模板。
 * 坐标段形如 /z/x/y（可选 @2x 后缀），替换为占位符即可，查询串保持不动。
 * 高 DPI：把 @2x 归并为 {r}；标准 DPI 模板里不插入 {r}，保持 {y}.ext 原样。
 */
export function inferTileTemplate(url: string): string {
  return url.replace(
    /\/(\d+)\/(\d+)\/(\d+)(@2x)?(\.[a-z0-9]+)(?=$|[?#])/i,
    (_all, z: string, x: string, y: string, retina: string, ext: string) => {
      void z;
      void x;
      void y;
      return retina ? "/{z}/{x}/{y}{r}" + ext : "/{z}/{x}/{y}" + ext;
    }
  );
}

/** 运行时模板改写成自定义协议地址，交给 MapLibre addProtocol 接管。 */
export function toOfflineTemplate(template: string): string {
  // 原模板作为查询参数携带，形如 mapoffline://tile?u=https%3A%2F%2F...%2F{z}%2F{x}%2F{y}.png
  return `${OFFLINE_TILE_SCHEME}?u=${encodeURIComponent(template)}`;
}

/**
 * 从自定义协议请求中还原真实瓦片 URL。
 * MapLibre 请求前已把模板里的 {z}/{x}/{y}（及 {r}/{ratio}）替换成数字，
 * 所以这里只需解码参数 u。
 */
export function resolveOfflineUrl(requestUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "mapoffline:") return null;
  const encoded = parsed.searchParams.get("u");
  if (!encoded) return null;
  return encoded;
}

function blobBytes(blob: Blob): number {
  // 浏览器环境有 blob.size；测试环境的 polyfill 同样提供。
  return blob.size;
}

export class TileFetcher {
  constructor(
    private readonly store: CacheStore,
    private readonly pixelRatio: number = typeof window !== "undefined" ? window.devicePixelRatio : 1
  ) {}

  /**
   * 取单个瓦片。coord 用于计算存储键；template 是 {z}/{x}/{y} 形式的原始模板。
   */
  async fetchTile(
    template: string,
    coord: TileCoord,
    options: TileFetchOptions = {}
  ): Promise<TileFetchOutcome> {
    const key = tileKey(coord);
    const url = expandTileUrl(template, coord, this.pixelRatio);
    const cached = await this.store.getTile(key);
    const now = Date.now();

    if (cached && isFresh(cached.meta, now)) {
      return {
        blob: cached.blob,
        contentType: cached.contentType,
        fromNetwork: false,
        changed: false,
        status: 200
      };
    }

    if (cached && options.backgroundRevalidate) {
      // 过期但有缓存：立即返回旧瓦片，后台条件请求；失败不影响渲染。
      void this.revalidate(url, key, coord, options.regionId ?? null, options.signal)
        .catch(() => undefined);
      return {
        blob: cached.blob,
        contentType: cached.contentType,
        fromNetwork: false,
        changed: false,
        status: 200
      };
    }

    try {
      const outcome = await this.revalidate(
        url,
        key,
        coord,
        options.regionId ?? (cached?.regionId ?? null),
        options.signal
      );
      if (outcome) {
        return {
          blob: outcome.blob,
          contentType: outcome.contentType,
          fromNetwork: true,
          changed: outcome.changed,
          status: 200
        };
      }
      // 304：服务端确认缓存仍有效（HTTP 语义上资源未变）。
      if (cached) {
        return {
          blob: cached.blob,
          contentType: cached.contentType,
          fromNetwork: true,
          changed: false,
          status: 304
        };
      }
      throw new Error("瓦片下载失败且无缓存");
    } catch (cause) {
      // 离线 / 超时 / 中止：只要有缓存就继续用，不向上抛碎图。
      if (cached) {
        return {
          blob: cached.blob,
          contentType: cached.contentType,
          fromNetwork: false,
          changed: false,
          status: 200
        };
      }
      throw cause;
    }
  }

  /**
   * 条件请求单个瓦片并按版本裁决写库。
   * 返回 undefined 表示 304（内容未变）。
   */
  private async revalidate(
    url: string,
    key: string,
    coord: TileCoord,
    regionId: string | null,
    externalSignal?: AbortSignal
  ): Promise<{ blob: Blob; contentType: string; changed: boolean } | undefined> {
    const cached = await this.store.getTile(key);
    const headers = conditionalHeaders(cached?.meta);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", abortFromCaller, { once: true });
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
        mode: "cors",
        credentials: "omit"
      });
    } finally {
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }

    if (response.status === 304) {
      if (cached) {
        // 刷新本地新鲜度窗口（重新计算 max-age），内容不动。
        const newDate = parseDate(response.headers.get("date"));
        const refreshedMeta: CacheMeta = { ...cached.meta, fetchedAt: Date.now() };
        if (newDate !== undefined) refreshedMeta.dateAt = newDate;
        await this.store.putTile({ ...cached, meta: refreshedMeta });
      }
      return undefined;
    }
    if (!response.ok) throw new Error(`瓦片服务响应 ${response.status}`);

    const incomingMeta = buildCacheMeta(url, response, Date.now());
    if (incomingMeta.noStore) {
      return {
        blob: await response.blob(),
        contentType: response.headers.get("content-type") ?? "image/png",
        changed: false
      };
    }
    // 版本裁决：旧/降级响应禁止覆盖较新缓存。
    if (cached && !isResponseNewer(cached.meta, incomingMeta)) {
      return { blob: cached.blob, contentType: cached.contentType, changed: false };
    }
    const blob = await response.blob();
    await this.store.putTile({
      key,
      z: coord.z,
      x: coord.x,
      y: coord.y,
      blob,
      contentType: response.headers.get("content-type") ?? cached?.contentType ?? "image/png",
      meta: incomingMeta,
      size: blobBytes(blob),
      regionId: cached?.regionId ?? regionId,
      savedAt: Date.now()
    });
    return {
      blob,
      contentType: response.headers.get("content-type") ?? "image/png",
      changed: true
    };
  }
}

function parseDate(value: string | null): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}
