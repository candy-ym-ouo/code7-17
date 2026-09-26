import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  createRegion,
  deleteRegion,
  estimateTileCount,
  listRegions,
  prefetchRegion,
  resetInterruptedDownloads,
  startAutoSync,
  syncAllRegions,
  validateRegionSpec,
  MAX_TILES_PER_REGION,
  type OfflineRegion,
  type RegionPrefetchProgress,
  type RegionSyncResult,
  type BBox
} from "../lib/offline";

/** 与 MapPage 保持一致的瓦片模板解析。 */
function resolveTileTemplate(): string {
  return import.meta.env.VITE_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
}

export const useOfflineStore = defineStore("offline", () => {
  const regions = ref<OfflineRegion[]>([]);
  const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);
  const syncing = ref(false);
  const downloadingRegionId = ref<string | null>(null);
  const progress = ref<RegionPrefetchProgress | null>(null);
  const lastSyncResults = ref<RegionSyncResult[]>([]);
  const error = ref("");

  const readyRegions = computed(() => regions.value.filter((region) => region.status === "ready"));

  async function refresh() {
    regions.value = await listRegions();
  }

  /** 应用启动时调用一次：恢复中断下载，再加载列表。 */
  async function init() {
    await resetInterruptedDownloads();
    await refresh();
  }

  async function download(regionId: string) {
    error.value = "";
    downloadingRegionId.value = regionId;
    progress.value = null;
    try {
      await prefetchRegion(regionId, resolveTileTemplate(), {
        onProgress: (value) => {
          progress.value = value;
        }
      });
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "离线数据下载失败";
    } finally {
      downloadingRegionId.value = null;
      progress.value = null;
      await refresh();
    }
  }

  async function saveRegion(name: string, bbox: BBox, minZoom: number, maxZoom: number) {
    error.value = "";
    const region = await createRegion({ name, bbox, minZoom, maxZoom });
    await refresh();
    await download(region.id);
  }

  function estimate(bbox: BBox, minZoom: number, maxZoom: number) {
    return {
      tiles: estimateTileCount(bbox, minZoom, maxZoom),
      validationError: validateRegionSpec(bbox, minZoom, maxZoom),
      maxTiles: MAX_TILES_PER_REGION
    };
  }

  async function removeRegion(id: string) {
    await deleteRegion(id);
    await refresh();
  }

  async function syncNow() {
    if (syncing.value) return;
    syncing.value = true;
    error.value = "";
    try {
      lastSyncResults.value = await syncAllRegions(resolveTileTemplate());
      const failed = lastSyncResults.value.find((result) => !result.ok);
      if (failed) error.value = failed.error ?? "部分区域同步失败";
    } finally {
      syncing.value = false;
      await refresh();
    }
  }

  function startAutoSyncLoop() {
    const updateOnline = () => {
      online.value = navigator.onLine;
    };
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    const stopSync = startAutoSync(resolveTileTemplate(), (event) => {
      if (event.type === "region-start") syncing.value = true;
      if (event.type === "done") {
        syncing.value = false;
        void refresh();
      }
    });
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      stopSync();
    };
  }

  return {
    regions,
    readyRegions,
    online,
    syncing,
    downloadingRegionId,
    progress,
    lastSyncResults,
    error,
    init,
    refresh,
    download,
    estimate,
    saveRegion,
    removeRegion,
    syncNow,
    startAutoSyncLoop
  };
});
