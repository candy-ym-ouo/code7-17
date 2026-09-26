import { describe, expect, it } from "vitest";
import {
  enumerateTiles,
  enumerateTilesForZooms,
  estimateTileCount,
  pointToTile,
  splitBounds,
  tilesForBounds,
  tileKey,
  parseTileKey,
  wrapLongitude
} from "./tile-math";

describe("pointToTile", () => {
  it("maps the null island to the origin tile", () => {
    expect(pointToTile({ lng: 0, lat: 0 }, 0)).toEqual({ z: 0, x: 0, y: 0 });
  });

  it("matches known OSM tile for Beijing at z=12", () => {
    // 北京 (116.397, 39.908) 在 z=12：x=3372, y=1552
    const tile = pointToTile({ lng: 116.397, lat: 39.908 }, 12);
    expect(tile.z).toBe(12);
    expect(tile.x).toBe(3372);
    expect(tile.y).toBe(1552);
  });

  it("clamps y at the poles", () => {
    const tile = pointToTile({ lng: 10, lat: 89 }, 5);
    expect(tile.y).toBe(0);
  });

  it("maps both 180 edges to valid in-range tile indices", () => {
    // 180° 与 -180° 在网格上是同一条边，都必须落在 [0, 2^z-1] 内
    expect(pointToTile({ lng: -180, lat: 0 }, 1).x).toBe(0);
    const east = pointToTile({ lng: 180, lat: 0 }, 1).x;
    expect(east).toBeGreaterThanOrEqual(0);
    expect(east).toBeLessThanOrEqual(3);
  });
});

describe("tilesForBounds", () => {
  it("covers the whole world at z=0 with a single tile", () => {
    const ranges = tilesForBounds([-180, -85, 180, 85], 0);
    expect(ranges).toEqual([{ minX: 0, maxX: 0, minY: 0, maxY: 0 }]);
  });

  it("orders y so northern tiles come first regardless of input", () => {
    const ranges = tilesForBounds([0, 0, 10, 10], 2);
    expect(ranges[0]!.minY).toBeLessThan(ranges[0]!.maxY);
  });

  it("splits ranges that cross the antimeridian", () => {
    const ranges = tilesForBounds([170, -10, -170, 10], 2);
    expect(ranges).toHaveLength(2);
  });

  it("does not wrap a normal wide bbox across the antimeridian", () => {
    // west < east 的 0..20 不能被当成跨半球
    const ranges = tilesForBounds([0, 0, 20, 20], 2);
    expect(ranges).toHaveLength(1);
  });
});

describe("enumerateTiles", () => {
  it("produces a contiguous unique set", () => {
    const tiles = enumerateTiles([0, 0, 1, 1], 4);
    const keys = new Set(tiles.map(tileKey));
    expect(keys.size).toBe(tiles.length);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.z).toBe(4);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("deduplicates antimeridian-adjacent pieces at low zoom", () => {
    const tiles = enumerateTiles([179, -1, -179, 1], 0);
    expect(tiles).toEqual([{ z: 0, x: 0, y: 0 }]);
  });
});

describe("enumerateTilesForZooms / estimateTileCount", () => {
  it("emits low zoom first, clamps zoom arguments and counts tiles", () => {
    const tiles = enumerateTilesForZooms([116.0, 39.5, 116.2, 40.0], -2, 12);
    expect(tiles[0]!.z).toBe(0);
    expect(tiles[tiles.length - 1]!.z).toBe(12);
    expect(estimateTileCount([116.0, 39.5, 116.2, 40.0], 0, 12)).toBe(tiles.length);
  });
});

describe("tileKey", () => {
  it("round-trips", () => {
    const key = tileKey({ z: 3, x: 4, y: 5 });
    expect(key).toBe("3/4/5");
    expect(parseTileKey(key)).toEqual({ z: 3, x: 4, y: 5 });
    expect(parseTileKey("nope")).toBeNull();
  });
});

describe("splitBounds", () => {
  it("keeps small bboxes unchanged", () => {
    expect(splitBounds([0, 0, 4, 4], 5)).toEqual([[0, 0, 4, 4]]);
  });

  it("splits oversized bboxes into <=5 degree chunks", () => {
    const chunks = splitBounds([0, 0, 12, 7], 5);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [w, s, e, n] of chunks) {
      expect(e - w).toBeLessThanOrEqual(5);
      expect(n - s).toBeLessThanOrEqual(5);
    }
  });
});

describe("wrapLongitude", () => {
  it("normalizes out-of-range values", () => {
    expect(wrapLongitude(181)).toBeCloseTo(-179);
    expect(wrapLongitude(-181)).toBeCloseTo(179);
    expect(wrapLongitude(360)).toBeCloseTo(0);
  });
});
