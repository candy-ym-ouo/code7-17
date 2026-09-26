/**
 * IndexedDB 轻量封装。离线缓存的存储层：
 * - tiles：瓦片二进制（key = "z/x/y"）
 * - features：地点要素（key = feature id）
 * - regions：离线选区元数据
 * - meta：全局元数据（同步游标等）
 */

const DB_NAME = "map-offline";
const DB_VERSION = 1;

export const STORES = {
  tiles: "tiles",
  features: "features",
  regions: "regions",
  meta: "meta"
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openOfflineDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.tiles)) {
          db.createObjectStore(STORES.tiles, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.features)) {
          const store = db.createObjectStore(STORES.features, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.regions)) {
          db.createObjectStore(STORES.regions, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORES.meta)) {
          db.createObjectStore(STORES.meta, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("无法打开离线数据库"));
      request.onblocked = () => reject(new Error("离线数据库被其他页面占用，请关闭其他标签页"));
    });
  }
  return dbPromise;
}

/** 测试或清理时重置连接。 */
export function closeOfflineDb(): void {
  if (dbPromise) {
    void dbPromise.then((db) => db.close()).catch(() => undefined);
    dbPromise = null;
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("离线数据库操作失败"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("离线数据库事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("离线数据库事务中止"));
  });
}

export async function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readonly");
  return requestToPromise<T | undefined>(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export async function dbGetMany<T>(store: StoreName, keys: string[]): Promise<(T | undefined)[]> {
  if (keys.length === 0) return [];
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readonly");
  const objectStore = tx.objectStore(store);
  const results = await Promise.all(
    keys.map((key) => requestToPromise<T | undefined>(objectStore.get(key) as IDBRequest<T | undefined>))
  );
  return results;
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readonly");
  return requestToPromise<T[]>(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

export async function dbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await transactionDone(tx);
}

export async function dbBulkPut<T>(store: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  for (const value of values) objectStore.put(value);
  await transactionDone(tx);
}

export async function dbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await transactionDone(tx);
}

export async function dbBulkDelete(store: StoreName, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  for (const key of keys) objectStore.delete(key);
  await transactionDone(tx);
}

export async function dbCount(store: StoreName): Promise<number> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readonly");
  return requestToPromise<number>(tx.objectStore(store).count());
}

export async function dbClear(store: StoreName): Promise<void> {
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await transactionDone(tx);
}

/**
 * 单事务内读取-修改-写入，保证比较-替换的原子性：
 * 过期缓存不能覆盖并发写入的新版本。
 */
export async function dbReadModifyWrite<Stored, Incoming>(
  store: StoreName,
  incoming: Incoming[],
  keyOf: (value: Incoming) => string,
  decide: (existing: Stored | undefined, value: Incoming) => Stored | null
): Promise<{ written: number; skipped: number }> {
  if (incoming.length === 0) return { written: 0, skipped: 0 };
  const db = await openOfflineDb();
  const tx = db.transaction(store, "readwrite");
  const objectStore = tx.objectStore(store);
  let written = 0;
  let skipped = 0;
  const reads = incoming.map(
    (value) => requestToPromise<Stored | undefined>(objectStore.get(keyOf(value)) as IDBRequest<Stored | undefined>)
  );
  const existingValues = await Promise.all(reads);
  for (const [index, value] of incoming.entries()) {
    const replacement = decide(existingValues[index], value);
    if (replacement === null) {
      skipped += 1;
    } else {
      objectStore.put(replacement);
      written += 1;
    }
  }
  await transactionDone(tx);
  return { written, skipped };
}
