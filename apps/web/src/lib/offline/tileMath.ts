/**
 * Web Mercator XYZ 瓦片坐标计算。
 * 与 OSM/MapLibre 的 {z}/{x}/{y} 瓦片规范一致。
 */

/** [west, south, east, north]，单位为度。 */
export type BBox = [number, number, number, number];

export type TileCoord = { z: number; x: number; y: number };

export const MIN_ZOOM = 0;
export const MAX_ZOOM = 19;

export function lonToTileX(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  const clamped = Math.min(180, Math.max(-180, lon));
  return Math.min(n - 1, Math.max(0, Math.floor(((clamped + 180) / 360) * n)));
}

export function latToTileY(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)));
}

export function tileKey(coord: TileCoord): string {
  return `${coord.z}/${coord.x}/${coord.y}`;
}

export function parseTileKey(key: string): TileCoord | null {
  const parts = key.split("/").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  const [z, x, y] = parts as [number, number, number];
  if (x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y };
}

/** 瓦片覆盖的地理范围，用于按瓦片网格分块请求要素。 */
export function tileBBox(z: number, x: number, y: number): BBox {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return [west, (southRad * 180) / Math.PI, east, (northRad * 180) / Math.PI];
}

function zoomClamp(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
}

/**
 * 计算覆盖 bbox 在 [minZoom, maxZoom] 级别上的全部瓦片。
 * bbox 不允许跨越反经线（选区来自地图视野，跨度受 UI 限制）。
 */
export function tilesForBBox(bbox: BBox, minZoom: number, maxZoom: number): TileCoord[] {
  const [west, south, east, north] = bbox;
  const result: TileCoord[] = [];
  for (let z = zoomClamp(minZoom); z <= zoomClamp(maxZoom); z += 1) {
    const xMin = lonToTileX(west, z);
    const xMax = lonToTileX(east, z);
    const yMin = latToTileY(north, z);
    const yMax = latToTileY(south, z);
    for (let x = xMin; x <= xMax; x += 1) {
      for (let y = yMin; y <= yMax; y += 1) {
        result.push({ z, x, y });
      }
    }
  }
  return result;
}

export function countTiles(bbox: BBox, minZoom: number, maxZoom: number): number {
  const [west, south, east, north] = bbox;
  let total = 0;
  for (let z = zoomClamp(minZoom); z <= zoomClamp(maxZoom); z += 1) {
    const width = lonToTileX(east, z) - lonToTileX(west, z) + 1;
    const height = latToTileY(south, z) - latToTileY(north, z) + 1;
    total += width * height;
  }
  return total;
}

/**
 * 把 bbox 按 zoom 级别的瓦片网格切成若干子 bbox。
 * 服务端单次 bbox 查询限制 5 度跨度，离线选区可能更大，必须分块请求。
 */
export function splitBBox(bbox: BBox, gridZoom: number): BBox[] {
  const [west, south, east, north] = bbox;
  const xMin = lonToTileX(west, gridZoom);
  const xMax = lonToTileX(east, gridZoom);
  const yMin = latToTileY(north, gridZoom);
  const yMax = latToTileY(south, gridZoom);
  const chunks: BBox[] = [];
  for (let x = xMin; x <= xMax; x += 1) {
    for (let y = yMin; y <= yMax; y += 1) {
      const [tileWest, tileSouth, tileEast, tileNorth] = tileBBox(gridZoom, x, y);
      chunks.push([
        Math.max(west, tileWest),
        Math.max(south, tileSouth),
        Math.min(east, tileEast),
        Math.min(north, tileNorth)
      ]);
    }
  }
  return chunks;
}

export function bboxContains(bbox: BBox, lon: number, lat: number): boolean {
  const [west, south, east, north] = bbox;
  if (lat < south || lat > north) return false;
  if (west <= east) return lon >= west && lon <= east;
  // 跨反经线
  return lon >= west || lon <= east;
}

export function bboxToQuery(bbox: BBox): string {
  return bbox.map((value) => value.toFixed(6)).join(",");
}
