// MapLibre GL JS 自定义协议：把 raster 源的瓦片请求接入离线瓦片管线。
//
// 用法：在 new Map() 之前调用 registerOfflineTileProtocol(fetcher)，
// 然后把 raster source 的 tiles 模板经 toOfflineTemplate 改写。
import type maplibregl from "maplibre-gl";
import {
  inferTileTemplate,
  OFFLINE_TILE_SCHEME,
  resolveOfflineUrl,
  TileFetcher
} from "./tile-fetcher";

let registered = false;

/**
 * 注册全局自定义协议。幂等；传入的 fetcher 会替换旧实例（便于热更新/测试）。
 */
export function registerOfflineTileProtocol(
  maplibre: typeof maplibregl,
  fetcher: TileFetcher
): void {
  // addProtocol 不允许重复注册同名协议；fetcher 通过全局引用替换。
  (globalThis as { __offlineTileFetcher?: TileFetcher }).__offlineTileFetcher = fetcher;
  if (registered) return;

  maplibre.addProtocol("mapoffline", async (request, abortController) => {
    const current = (globalThis as { __offlineTileFetcher?: TileFetcher }).__offlineTileFetcher;
    if (!current) throw new Error("离线瓦片协议未初始化");
    const realUrl = resolveOfflineUrl(request.url);
    if (!realUrl) throw new Error(`无法解析离线瓦片地址: ${request.url}`);
    const coord = extractTileCoord(realUrl);
    if (!coord) throw new Error(`无法识别瓦片坐标: ${realUrl}`);
    const template = inferTileTemplate(realUrl);
    const outcome = await current.fetchTile(template, coord, {
      signal: abortController.signal,
      regionId: null,
      backgroundRevalidate: true
    });
    const data = await outcome.blob.arrayBuffer();
    return { data };
  });
  registered = true;
}

/** 仅供测试：重置协议注册状态。 */
export function resetOfflineTileProtocolForTest(): void {
  registered = false;
  delete (globalThis as { __offlineTileFetcher?: TileFetcher }).__offlineTileFetcher;
}

/** 从形如 .../z/x/y.png 的真实瓦片 URL 中解析坐标。 */
export function extractTileCoord(url: string): { z: number; x: number; y: number } | null {
  const path = new URL(url).pathname;
  const match = /\/(\d+)\/(\d+)\/(\d+)(?:@2x)?\.[a-z0-9]+$/i.exec(path);
  if (!match) return null;
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}

export { OFFLINE_TILE_SCHEME };
