import { describe, expect, it } from "vitest";
import {
  bboxContains,
  countTiles,
  latToTileY,
  lonToTileX,
  parseTileKey,
  splitBBox,
  tileBBox,
  tileKey,
  tilesForBBox
} from "./tileMath";

describe("tileMath", () => {
  it("converts known lon/lat to tile coordinates", () => {
    // OSM 标准样例：柏林 (13.41, 52.52) 在 z=14 的瓦片
    expect(lonToTileX(13.41, 14)).toBe(8802);
    expect(latToTileY(52.52, 14)).toBe(5373);
    // 边界：z=0 全图一瓦片
    expect(lonToTileX(-179.9, 0)).toBe(0);
    expect(latToTileY(85, 0)).toBe(0);
    expect(lonToTileX(179.9, 0)).toBe(0);
  });

  it("clamps coordinates at the tile grid edges", () => {
    const max = 2 ** 10 - 1;
    expect(lonToTileX(180, 10)).toBe(max);
    expect(lonToTileX(-180, 10)).toBe(0);
    expect(latToTileY(85.05112878, 10)).toBe(0);
    expect(latToTileY(-85.05112878, 10)).toBe(max);
  });

  it("round-trips tile keys", () => {
    const coord = { z: 14, x: 8804, y: 5370 };
    expect(parseTileKey(tileKey(coord))).toEqual(coord);
    expect(parseTileKey("bad")).toBeNull();
    expect(parseTileKey("1/2/9")).toBeNull(); // y 超出 z=1 网格
  });

  it("enumerates exactly the tiles covering a bbox", () => {
    const bbox: [number, number, number, number] = [116.3, 39.8, 116.5, 40.0];
    const tiles = tilesForBBox(bbox, 12, 12);
    expect(tiles.length).toBe(countTiles(bbox, 12, 12));
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.z).toBe(12);
      const [west, south, east, north] = tileBBox(tile.z, tile.x, tile.y);
      // 每个瓦片都必须与 bbox 相交
      expect(east).toBeGreaterThan(bbox[0]);
      expect(west).toBeLessThan(bbox[2]);
      expect(north).toBeGreaterThan(bbox[1]);
      expect(south).toBeLessThan(bbox[3]);
    }
  });

  it("counts tiles across zoom levels", () => {
    const bbox: [number, number, number, number] = [116.3, 39.8, 116.5, 40.0];
    const total = countTiles(bbox, 10, 12);
    const perLevel = countTiles(bbox, 10, 10) + countTiles(bbox, 11, 11) + countTiles(bbox, 12, 12);
    expect(total).toBe(perLevel);
    // 每升一级瓦片数约变为 4 倍
    expect(countTiles(bbox, 12, 12)).toBeGreaterThan(countTiles(bbox, 11, 11));
  });

  it("splits bbox into chunks that each stay within the 5° API limit", () => {
    const bbox: [number, number, number, number] = [100, 20, 130, 45];
    const chunks = splitBBox(bbox, 7);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [west, south, east, north] of chunks) {
      expect(east - west).toBeLessThanOrEqual(5);
      expect(north - south).toBeLessThanOrEqual(5);
      // 子块不超出原 bbox
      expect(west).toBeGreaterThanOrEqual(bbox[0] - 1e-9);
      expect(east).toBeLessThanOrEqual(bbox[2] + 1e-9);
      expect(south).toBeGreaterThanOrEqual(bbox[1] - 1e-9);
      expect(north).toBeLessThanOrEqual(bbox[3] + 1e-9);
    }
    // 覆盖完整性：中心点必须落在某个子块内
    const samples = 20;
    for (let i = 0; i < samples; i += 1) {
      const lon = bbox[0] + ((bbox[2] - bbox[0]) * i) / (samples - 1);
      const lat = bbox[1] + ((bbox[3] - bbox[1]) * i) / (samples - 1);
      expect(chunks.some((chunk) => bboxContains(chunk, lon, lat))).toBe(true);
    }
  });

  it("bboxContains handles antimeridian spans", () => {
    expect(bboxContains([170, -10, -170, 10], 175, 0)).toBe(true);
    expect(bboxContains([170, -10, -170, 10], -175, 0)).toBe(true);
    expect(bboxContains([170, -10, -170, 10], 0, 0)).toBe(false);
    expect(bboxContains([116, 39, 117, 40], 116.5, 39.5)).toBe(true);
    expect(bboxContains([116, 39, 117, 40], 118, 39.5)).toBe(false);
  });
});
