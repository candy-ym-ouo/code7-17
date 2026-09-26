# 地图离线缓存模块

前端位置：`apps/web/src/lib/offline/`。支持按选区与缩放级别预取地图瓦片和已审核地点，
断网时浏览缓存内容，网络恢复后增量同步，并保证陈旧缓存永远不会覆盖服务端新版本。

## 架构

| 模块 | 职责 |
|---|---|
| `tile-math.ts` | Web 墨卡托行列号、bbox 瓦片枚举（含跨 180°）、5° 切块 |
| `http-cache.ts` | Cache-Control / Expires / ETag / Last-Modified 新鲜度与版本裁决（纯函数） |
| `cache-store.ts` | IndexedDB 存储（选区、瓦片 Blob、地点、墓碑、KV 元数据）；含内存实现用于测试 |
| `tile-fetcher.ts` | 瓦片缓存优先 + 条件请求重验证，304 刷新新鲜度窗口，离线回退过期缓存 |
| `tile-protocol.ts` | MapLibre `addProtocol("mapoffline", …)` 适配，渲染层零改动接入 |
| `prefetch.ts` | 选区预取：配额预检、并发下载（默认 6）、可取消、进度回调 |
| `feature-api.ts` | 地点在线拉取、**版本安全合并**、bbox 缓存查询（含跨 180°） |
| `sync.ts` | 游标分页增量同步、404 时按选区全量兜底、选区瓦片条件重验证 |
| `offline-manager.ts` | 门面单例：`online/offline` 事件（去抖 1.5s）、同步去重、LRU 容量回收 |

## 缓存一致性（过期缓存不能覆盖新版）

写入前经过多层裁决，任一层不通过都不覆盖：

1. **瓦片新鲜度**：`max-age`/`Expires` 内直接用缓存；过期走 `If-None-Match` /
   `If-Modified-Since`，服务端 304 则只刷新新鲜度窗口、内容不动。
2. **瓦片版本**：200 响应还要比对 ETag / Last-Modified（`isResponseNewer`），
   旧或降级响应禁止写入；`no-store` 响应不落盘。
3. **地点合并**（`mergeFeaturesIntoStore`）：仅当 `incoming.updatedAt > local.updatedAt`
   才覆盖；本地存在更新或同时间墓碑时拒绝“复活”。
4. **墓碑删除**（`applySyncBatch`）：只有 `removed.updatedAt > local.updatedAt`
   才真正删除；乱序重放的旧增量页不会删掉较新地点。
5. **游标**：只在整轮同步成功后持久化；网络失败时不推进，重试不漏变更。

## 选区预取

- 用户在地图页“离线地图”面板把当前视野存为选区，指定最小/最大缩放级。
- `planRegion` 先估算瓦片总数，超过 `DEFAULT_MAX_TILES`（6000）直接拒绝。
- 瓦片按选区标记；浏览时顺带缓存的瓦片 `regionId=null`，按 LRU 回收到
   ~120MB（`evictNonRegionTiles`），选区瓦片不受影响。
- 地点按 5° 切块调 `GET /features?bbox=`（服务端单次查询上限）。

## 同步

- 浏览器 `online` 事件去抖后自动同步，也可面板手动触发。
- `GET /features/sync?since=<ISO-8601>`：已发布 upsert + 删除/隐藏墓碑，
  按 `nextCursor` 分页，见 [api.md](../docs/api.md)。
- 旧后端没有该端点（404）时，降级为按全部已保存选区做真实 bbox 全量拉取，
  不使用任何 mock 数据。
- 同步后对选区瓦片做条件重验证，仅统计真正变化的瓦片。

## 离线使用

- 瓦片：raster 源模板经 `toOfflineTemplate` 改写为 `mapoffline://` 协议；
  无缓存且断网的瓦片不碎图（协议层回退过期缓存，最终失败只影响单张瓦片）。
- 地点：`GET /features` 失败时自动查本地缓存并显示离线横幅；空间过滤在本地完成。
