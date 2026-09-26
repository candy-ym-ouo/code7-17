// 离线模块门面：统一持有存储、瓦片管线与同步任务，监听网络恢复事件。
import { createDefaultStore, type CacheStore } from "./cache-store";
import { TileFetcher } from "./tile-fetcher";
import { prefetchRegion, type PrefetchOptions } from "./prefetch";
import {
  buildSyncResult,
  revalidateRegionTiles,
  syncFeatures
} from "./sync";
import { queryCachedFeatures } from "./feature-api";
import type {
  CachedFeatureData,
  OfflineRegion,
  PrefetchProgress,
  SyncResult
} from "./types";

type Listener<T> = (payload: T) => void;

export interface OfflineStatus {
  online: boolean;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

/** 默认非选区浏览瓦片的容量上限（约 120MB，按平均 40KB/张估）。 */
const DEFAULT_NON_REGION_BYTES = 120 * 1024 * 1024;
/** online 事件去抖：弱网抖动时避免瞬间触发多次全量同步。 */
const ONLINE_DEBOUNCE_MS = 1500;

export class OfflineManager {
  readonly store: CacheStore;
  readonly fetcher: TileFetcher;
  private tileTemplate: string;
  private status: OfflineStatus = {
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    syncing: false,
    lastSyncAt: null,
    lastError: null
  };
  private syncController: AbortController | null = null;
  private existingSync: Promise<SyncResult> | null = null;
  private onlineTimer: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<Listener<OfflineStatus>>();
  private progressListeners = new Set<Listener<PrefetchProgress>>();

  constructor(store?: CacheStore, tileTemplate = "", pixelRatio?: number) {
    this.store = store ?? createDefaultStore();
    this.fetcher = new TileFetcher(this.store, pixelRatio);
    this.tileTemplate = tileTemplate;
  }

  setTileTemplate(template: string): void {
    this.tileTemplate = template;
  }

  getTileTemplate(): string {
    return this.tileTemplate;
  }

  isOnline(): boolean {
    return this.status.online;
  }

  getStatus(): OfflineStatus {
    return { ...this.status };
  }

  onStatusChange(listener: Listener<OfflineStatus>): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onPrefetchProgress(listener: Listener<PrefetchProgress>): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private emitStatus(): void {
    const snapshot = { ...this.status };
    for (const listener of this.statusListeners) listener(snapshot);
  }

  /** 挂载浏览器网络事件；返回卸载函数。 */
  bindNetworkEvents(): () => void {
    if (typeof window === "undefined") return () => undefined;
    const handleOnline = () => {
      this.status.online = true;
      this.emitStatus();
      if (this.onlineTimer) clearTimeout(this.onlineTimer);
      this.onlineTimer = setTimeout(() => {
        void this.syncNow();
      }, ONLINE_DEBOUNCE_MS);
    };
    const handleOffline = () => {
      this.status.online = false;
      this.emitStatus();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (this.onlineTimer) clearTimeout(this.onlineTimer);
    };
  }

  async listRegions(): Promise<OfflineRegion[]> {
    return await this.store.listRegions();
  }

  async deleteRegion(id: string): Promise<void> {
    // 选区瓦片随选区删除；地点保留（可能同时属于别的选区，同步墓碑才会真正删）。
    const keys = await this.store.listTileKeysForRegion(id);
    for (const key of keys) await this.store.deleteTile(key);
    await this.store.deleteRegion(id);
  }

  /** 创建/更新选区并立即预取。 */
  async prefetch(
    region: OfflineRegion,
    overrides: Partial<Pick<PrefetchOptions, "concurrency" | "maxTiles" | "signal">> = {}
  ): Promise<{ failedTiles: number; features: CachedFeatureData[] }> {
    const options: PrefetchOptions = {
      region,
      tileTemplate: this.tileTemplate,
      ...overrides,
      onProgress: (progress) => {
        for (const listener of this.progressListeners) listener(progress);
      }
    };
    return await prefetchRegion(this.store, this.fetcher, options);
  }

  /** 离线/在线统一入口：缓存空间查询地点。 */
  async queryFeatures(
    bounds: [number, number, number, number],
    categoryKey?: string
  ): Promise<CachedFeatureData[]> {
    return await queryCachedFeatures(this.store, bounds, categoryKey);
  }

  /**
   * 增量同步。并发调用会复用同一个任务（去重）。
   * 离线或网络错误返回 ok:false，绝不抛出给 UI。
   */
  syncNow(): Promise<SyncResult> {
    if (this.existingSync) return this.existingSync;
    this.syncController = new AbortController();
    this.status.syncing = true;
    this.emitStatus();
    this.existingSync = this.runSync(this.syncController.signal).finally(() => {
      this.status.syncing = false;
      this.syncController = null;
      this.existingSync = null;
      this.emitStatus();
    });
    return this.existingSync;
  }

  private failedResult(message: string): SyncResult {
    return {
      syncedAt: this.status.lastSyncAt ?? Date.now(),
      upserted: 0,
      deleted: 0,
      tilesRevalidated: 0,
      tilesChanged: 0,
      ok: false,
      message
    };
  }

  private async runSync(signal: AbortSignal): Promise<SyncResult> {
    if (!this.status.online) {
      this.status.lastError = "当前离线，恢复网络后自动同步";
      this.emitStatus();
      return this.failedResult(this.status.lastError);
    }
    try {
      const features = await syncFeatures(this.store, signal);
      const tiles = this.tileTemplate
        ? await revalidateRegionTiles(this.store, this.fetcher, this.tileTemplate, signal)
        : { revalidated: 0, changed: 0 };
      this.status.lastSyncAt = features.syncedAt;
      this.status.lastError = null;
      await this.store.evictNonRegionTiles(DEFAULT_NON_REGION_BYTES);
      return buildSyncResult(features, tiles, features.syncedAt);
    } catch (cause) {
      this.status.lastError = cause instanceof Error ? cause.message : "同步失败";
      return {
        syncedAt: this.status.lastSyncAt ?? Date.now(),
        upserted: 0,
        deleted: 0,
        tilesRevalidated: 0,
        tilesChanged: 0,
        ok: false,
        message: this.status.lastError
      };
    }
  }

  cancelSync(): void {
    this.syncController?.abort();
  }
}

let defaultManager: OfflineManager | null = null;

export function getOfflineManager(): OfflineManager {
  if (!defaultManager) defaultManager = new OfflineManager();
  return defaultManager;
}

/** 仅供测试重置单例。 */
export function resetOfflineManagerForTest(): void {
  defaultManager = null;
}
