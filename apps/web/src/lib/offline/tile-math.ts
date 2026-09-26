// 纯函数工具：Web 墨卡托瓦片行列号计算与区域枚举。
// 参考: https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames

export interface LngLat {
  lng: number;
  lat: number;
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const MAX_TILE_ZOOM = 22;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function wrapLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function lngToTileX(lng: number, z: number): number {
  return ((lng + 180) / 360) * Math.pow(2, z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

/** 经纬度所在瓦片（左闭右开网格），x 已对全球取模，y 钳制到有效范围。 */
export function pointToTile(point: LngLat, z: number): TileCoord {
  const max = Math.pow(2, z) - 1;
  return {
    z,
    x: clamp(Math.floor(lngToTileX(wrapLongitude(point.lng), z)), 0, max),
    y: clamp(Math.floor(latToTileY(point.lat, z)), 0, max)
  };
}

/**
 * bbox 在 z 级覆盖的瓦片范围。
 * bbox 约定 [west, south, east, north]，支持跨越 180° 经线（west > east）。
 * 跨越时 x 范围分两段返回，避免把整个地球错误圈入。
 */
export function tilesForBounds(
  bounds: [number, number, number, number],
  z: number
): TileRange[] {
  const [westRaw, south, eastRaw, north] = bounds;
  const west = wrapLongitude(westRaw);
  const east = wrapLongitude(eastRaw);
  const crossesAntimeridian = westRaw > eastRaw && Math.abs(westRaw - eastRaw) <= 360;
  const max = Math.pow(2, z) - 1;

  const yMin = clamp(Math.floor(latToTileY(clamp(north, -85.05112878, 85.05112878), z)), 0, max);
  const yMax = clamp(Math.floor(latToTileY(clamp(south, -85.05112878, 85.05112878), z)), 0, max);

  const xRangeFor = (w: number, e: number): TileRange => ({
    minX: clamp(Math.floor(lngToTileX(w, z)), 0, max),
    maxX: clamp(Math.floor(lngToTileX(e, z)), 0, max),
    minY: Math.min(yMin, yMax),
    maxY: Math.max(yMin, yMax)
  });

  if (crossesAntimeridian) {
    // [west, 180) + [-180, east]
    return [xRangeFor(west, 179.9999999), xRangeFor(-180, east)];
  }
  return [xRangeFor(Math.min(west, east), Math.max(west, east))];
}

/** 枚举 bbox 在单个缩放级别覆盖的全部瓦片坐标（去重）。 */
export function enumerateTiles(
  bounds: [number, number, number, number],
  z: number
): TileCoord[] {
  const ranges = tilesForBounds(bounds, z);
  const seen = new Set<number>();
  const tiles: TileCoord[] = [];
  for (const range of ranges) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = x * (MAX_TILE_ZOOM + 1) * 100000 + y;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

/** 枚举 bbox 在 zMin..zMax（含）全部级别覆盖的瓦片，低缩放级优先。 */
export function enumerateTilesForZooms(
  bounds: [number, number, number, number],
  zMin: number,
  zMax: number
): TileCoord[] {
  const lo = clamp(Math.floor(zMin), 0, MAX_TILE_ZOOM);
  const hi = clamp(Math.floor(zMax), lo, MAX_TILE_ZOOM);
  const result: TileCoord[] = [];
  for (let z = lo; z <= hi; z += 1) {
    const level = enumerateTiles(bounds, z);
    // 单级展开结果过大时停止（调用方应先用 estimateTileCount 预检配额）。
    if (result.length + level.length > MAX_ENUMERATION) break;
    for (const tile of level) result.push(tile);
  }
  return result;
}

/** 单次枚举的安全上限（约 100 万瓦片）。 */
export const MAX_ENUMERATION = 1_000_000;

/** 不实际枚举时估算瓦片总数，用于预取配额预检。 */
export function estimateTileCount(
  bounds: [number, number, number, number],
  zMin: number,
  zMax: number
): number {
  let total = 0;
  const lo = clamp(Math.floor(zMin), 0, MAX_TILE_ZOOM);
  const hi = clamp(Math.floor(zMax), lo, MAX_TILE_ZOOM);
  for (let z = lo; z <= hi; z += 1) {
    total += enumerateTiles(bounds, z).length;
  }
  return total;
}

export function tileKey(tile: TileCoord): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

export function parseTileKey(key: string): TileCoord | null {
  const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (!match) return null;
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}

/**
 * 把大 bbox 切成不大于 span 度的网格（用于地点增量同步分块，
 * 服务端单次查询限制 5°）。不处理跨 180°，调用前应先拆分。
 */
export function splitBounds(
  bounds: [number, number, number, number],
  span = 5
): Array<[number, number, number, number]> {
  const [west, south, east, north] = bounds;
  if (east - west <= span && north - south <= span) return [bounds];
  const chunks: Array<[number, number, number, number]> = [];
  for (let w = west; w < east; w += span) {
    const e = Math.min(w + span, east);
    for (let s = south; s < north; s += span) {
      const n = Math.min(s + span, north);
      chunks.push([w, s, e, n]);
    }
  }
  return chunks;
}
