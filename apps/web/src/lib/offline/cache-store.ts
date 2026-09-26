// 离线缓存存储层：接口 + IndexedDB 实现 + 内存实现（测试用）。
import type {
  CachedFeature,
  CachedTile,
  FeatureTombstone,
  OfflineRegion
} from "./types";

export interface CacheStore {
  // 选区
  putRegion(region: OfflineRegion): Promise<void>;
  getRegion(id: string): Promise<OfflineRegion | undefined>;
  listRegions(): Promise<OfflineRegion[]>;
  deleteRegion(id: string): Promise<void>;

  // 瓦片
  putTile(tile: CachedTile): Promise<void>;
  getTile(key: string): Promise<CachedTile | undefined>;
  countTiles(): Promise<number>;
  tilesTotalBytes(): Promise<number>;
  listTileKeys(): Promise<string[]>;
  listTileKeysForRegion(regionId: string): Promise<string[]>;
  deleteTile(key: string): Promise<void>;
  /** 删除最久未使用、且不属于任何选区的瓦片，直到字节数低于 limit。 */
  evictNonRegionTiles(limitBytes: number): Promise<number>;

  // 地点
  putFeature(feature: CachedFeature): Promise<void>;
  getFeature(id: string): Promise<CachedFeature | undefined>;
  listFeatures(): Promise<CachedFeature[]>;
  deleteFeature(id: string): Promise<void>;

  // 墓碑（删除/下线记录，参与版本裁决，防止“复活”）
  putTombstone(tombstone: FeatureTombstone): Promise<void>;
  getTombstone(id: string): Promise<FeatureTombstone | undefined>;
  listTombstones(): Promise<FeatureTombstone[]>;

  // 键值元数据
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;

  close(): Promise<void>;
}

// ---------------- 内存实现（Node 测试环境没有 indexedDB） ----------------

export class MemoryCacheStore implements CacheStore {
  private regions = new Map<string, OfflineRegion>();
  private tiles = new Map<string, CachedTile>();
  private features = new Map<string, CachedFeature>();
  private tombstones = new Map<string, FeatureTombstone>();
  private meta = new Map<string, unknown>();

  async putRegion(region: OfflineRegion): Promise<void> {
    this.regions.set(region.id, structuredClone(region));
  }
  async getRegion(id: string): Promise<OfflineRegion | undefined> {
    const value = this.regions.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async listRegions(): Promise<OfflineRegion[]> {
    return [...this.regions.values()].map((v) => structuredClone(v));
  }
  async deleteRegion(id: string): Promise<void> {
    this.regions.delete(id);
  }

  async putTile(tile: CachedTile): Promise<void> {
    this.tiles.set(tile.key, tile);
  }
  async getTile(key: string): Promise<CachedTile | undefined> {
    return this.tiles.get(key);
  }
  async countTiles(): Promise<number> {
    return this.tiles.size;
  }
  async tilesTotalBytes(): Promise<number> {
    let total = 0;
    for (const tile of this.tiles.values()) total += tile.size;
    return total;
  }
  async listTileKeys(): Promise<string[]> {
    return [...this.tiles.keys()];
  }
  async listTileKeysForRegion(regionId: string): Promise<string[]> {
    return [...this.tiles.values()].filter((t) => t.regionId === regionId).map((t) => t.key);
  }
  async deleteTile(key: string): Promise<void> {
    this.tiles.delete(key);
  }
  async evictNonRegionTiles(limitBytes: number): Promise<number> {
    let bytes = 0;
    for (const tile of this.tiles.values()) bytes += tile.size;
    if (bytes <= limitBytes) return 0;
    const removable = [...this.tiles.values()]
      .filter((t) => t.regionId === null)
      .sort((a, b) => a.savedAt - b.savedAt);
    let freed = 0;
    for (const tile of removable) {
      if (bytes - freed <= limitBytes) break;
      this.tiles.delete(tile.key);
      freed += tile.size;
    }
    return freed;
  }

  async putFeature(feature: CachedFeature): Promise<void> {
    this.features.set(feature.id, structuredClone(feature));
  }
  async getFeature(id: string): Promise<CachedFeature | undefined> {
    const value = this.features.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async listFeatures(): Promise<CachedFeature[]> {
    return [...this.features.values()].map((v) => structuredClone(v));
  }
  async deleteFeature(id: string): Promise<void> {
    this.features.delete(id);
  }

  async putTombstone(tombstone: FeatureTombstone): Promise<void> {
    const existing = this.tombstones.get(tombstone.id);
    if (!existing || tombstone.updatedAt > existing.updatedAt) {
      this.tombstones.set(tombstone.id, { ...tombstone });
    }
  }
  async getTombstone(id: string): Promise<FeatureTombstone | undefined> {
    return this.tombstones.get(id);
  }
  async listTombstones(): Promise<FeatureTombstone[]> {
    return [...this.tombstones.values()].map((v) => ({ ...v }));
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return this.meta.get(key) as T | undefined;
  }
  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, structuredClone(value));
  }

  async close(): Promise<void> {
    this.regions.clear();
    this.tiles.clear();
    this.features.clear();
    this.tombstones.clear();
    this.meta.clear();
  }
}

// ---------------- IndexedDB 实现（浏览器） ----------------

const DB_NAME = "map-offline-cache";
const DB_VERSION = 1;
const STORE = {
  regions: "regions",
  tiles: "tiles",
  features: "features",
  tombstones: "tombstones",
  meta: "meta"
} as const;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE.regions)) db.createObjectStore(STORE.regions, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE.tiles)) {
        const tiles = db.createObjectStore(STORE.tiles, { keyPath: "key" });
        tiles.createIndex("savedAt", "savedAt");
        tiles.createIndex("regionId", "regionId");
      }
      if (!db.objectStoreNames.contains(STORE.features)) {
        const features = db.createObjectStore(STORE.features, { keyPath: "id" });
        features.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(STORE.tombstones)) {
        db.createObjectStore(STORE.tombstones, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE.meta)) db.createObjectStore(STORE.meta, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, stores: Record<string, IDBObjectStore>) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const transaction = db.transaction(names, mode);
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of names) stores[name] = transaction.objectStore(name);
    const request = run(transaction.objectStore(names[0]!), stores);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDBCacheStore implements CacheStore {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = openDatabase();
  }

  private async db(): Promise<IDBDatabase> {
    return await this.dbPromise;
  }

  async putRegion(region: OfflineRegion): Promise<void> {
    const db = await this.db();
    await tx(db, STORE.regions, "readwrite", (store) => store.put(region));
  }
  async getRegion(id: string): Promise<OfflineRegion | undefined> {
    const db = await this.db();
    return (await tx(db, STORE.regions, "readonly", (store) => store.get(id))) ?? undefined;
  }
  async listRegions(): Promise<OfflineRegion[]> {
    const db = await this.db();
    return await tx(db, STORE.regions, "readonly", (store) => store.getAll());
  }
  async deleteRegion(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, STORE.regions, "readwrite", (store) => store.delete(id));
  }

  async putTile(tile: CachedTile): Promise<void> {
    const db = await this.db();
    await tx(db, STORE.tiles, "readwrite", (store) => store.put(tile));
  }
  async getTile(key: string): Promise<CachedTile | undefined> {
    const db = await this.db();
    return (await tx(db, STORE.tiles, "readonly", (store) => store.get(key))) ?? undefined;
  }
  async countTiles(): Promise<number> {
    const db = await this.db();
    return await tx(db, STORE.tiles, "readonly", (store) => store.count());
  }
  async tilesTotalBytes(): Promise<number> {
    const tiles = await tx<CachedTile[]>(await this.db(), STORE.tiles, "readonly", (store) => store.getAll());
    return tiles.reduce((sum, tile) => sum + tile.size, 0);
  }
  async listTileKeys(): Promise<string[]> {
    const db = await this.db();
    const keys = await tx(db, STORE.tiles, "readonly", (store) => store.getAllKeys());
    return keys as string[];
  }
  async listTileKeysForRegion(regionId: string): Promise<string[]> {
    const db = await this.db();
    const keys = await tx<IDBValidKey[]>(db, STORE.tiles, "readonly", (_s, stores) =>
      stores[STORE.tiles]!.index("regionId").getAllKeys(regionId)
    );
    return keys as string[];
  }
  async deleteTile(key: string): Promise<void> {
    const db = await this.db();
    await tx(db, STORE.tiles, "readwrite", (store) => store.delete(key));
  }
  async evictNonRegionTiles(limitBytes: number): Promise<number> {
    const db = await this.db();
    const all = await tx<CachedTile[]>(db, STORE.tiles, "readonly", (store) =>
      store.index("savedAt").getAll()
    );
    let bytes = all.reduce((sum, tile) => sum + tile.size, 0);
    if (bytes <= limitBytes) return 0;
    const removable = all.filter((tile) => tile.regionId === null);
    let freed = 0;
    for (const tile of removable) {
      if (bytes - freed <= limitBytes) break;
      await this.deleteTile(tile.key);
      freed += tile.size;
    }
    return freed;
  }

  async putFeature(feature: CachedFeature): Promise<void> {
    const db = await this.db();
    await tx(db, STORE.features, "readwrite", (store) => store.put(feature));
  }
  async getFeature(id: string): Promise<CachedFeature | undefined> {
    const db = await this.db();
    return (await tx(db, STORE.features, "readonly", (store) => store.get(id))) ?? undefined;
  }
  async listFeatures(): Promise<CachedFeature[]> {
    const db = await this.db();
    return await tx(db, STORE.features, "readonly", (store) => store.getAll());
  }
  async deleteFeature(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, STORE.features, "readwrite", (store) => store.delete(id));
  }

  async putTombstone(tombstone: FeatureTombstone): Promise<void> {
    const db = await this.db();
    const existing = (await tx<FeatureTombstone>(db, STORE.tombstones, "readonly", (store) =>
      store.get(tombstone.id)
    ));
    if (!existing || tombstone.updatedAt > existing.updatedAt) {
      await tx(db, STORE.tombstones, "readwrite", (store) => store.put(tombstone));
    }
  }
  async getTombstone(id: string): Promise<FeatureTombstone | undefined> {
    const db = await this.db();
    return (await tx(db, STORE.tombstones, "readonly", (store) => store.get(id))) ?? undefined;
  }
  async listTombstones(): Promise<FeatureTombstone[]> {
    const db = await this.db();
    return await tx(db, STORE.tombstones, "readonly", (store) => store.getAll());
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.db();
    const row = await tx<{ key: string; value: unknown } | undefined>(
      db,
      STORE.meta,
      "readonly",
      (store) => store.get(key)
    );
    return row?.value as T | undefined;
  }
  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.db();
    await tx(db, STORE.meta, "readwrite", (store) => store.put({ key, value }));
  }

  async close(): Promise<void> {
    const db = await this.dbPromise;
    db.close();
  }
}

/** 浏览器用 IndexedDB；没有该全局对象时（测试/SSR）退化为内存存储。 */
export function createDefaultStore(): CacheStore {
  if (typeof indexedDB !== "undefined") return new IndexedDBCacheStore();
  return new MemoryCacheStore();
}
