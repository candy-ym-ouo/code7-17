// 地图离线缓存模块入口。
export * from "./types";
export * from "./tile-math";
export * from "./http-cache";
export * from "./cache-store";
export {
  TileFetcher,
  expandTileUrl,
  inferTileTemplate,
  toOfflineTemplate,
  resolveOfflineUrl,
  OFFLINE_TILE_SCHEME,
  type TileFetchOutcome
} from "./tile-fetcher";
export {
  registerOfflineTileProtocol,
  resetOfflineTileProtocolForTest,
  extractTileCoord
} from "./tile-protocol";
export {
  prefetchRegion,
  planRegion,
  PrefetchAbortedError,
  PrefetchQuotaError,
  DEFAULT_MAX_TILES,
  type PrefetchOptions
} from "./prefetch";
export {
  syncFeatures,
  revalidateRegionTiles,
  buildSyncResult
} from "./sync";
export {
  fetchFeaturesInBounds,
  fetchSyncPage,
  mergeFeaturesIntoStore,
  applySyncBatch,
  queryCachedFeatures,
  type SyncResponse
} from "./feature-api";
export {
  OfflineManager,
  getOfflineManager,
  resetOfflineManagerForTest,
  type OfflineStatus
} from "./offline-manager";
