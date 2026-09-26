import { describe, expect, it } from "vitest";
import { computeSyncWindow } from "./sync-cursor";

describe("computeSyncWindow（增量同步游标推进）", () => {
  const dbNow = new Date("2026-09-25T12:00:00Z");

  function rows(count: number, startMinute = 0) {
    return Array.from({ length: count }, (_, index) => ({
      id: `f${index}`,
      updated_at: new Date(Date.UTC(2026, 8, 25, 10, startMinute + index))
    }));
  }

  it("advances to database time when the window is fully consumed", () => {
    const window = computeSyncWindow(rows(3), 500, dbNow);
    expect(window.hasMore).toBe(false);
    expect(window.upserts).toHaveLength(3);
    expect(window.serverTime).toEqual(dbNow);
  });

  it("stops the cursor at the last returned row when truncated", () => {
    // limit=2，查询取 limit+1=3 行 → 截断，游标停在第 2 行的 updated_at
    const window = computeSyncWindow(rows(3), 2, dbNow);
    expect(window.hasMore).toBe(true);
    expect(window.upserts).toHaveLength(2);
    expect(window.serverTime).toEqual(new Date(Date.UTC(2026, 8, 25, 10, 1)));
    // 截断时游标必须早于数据库当前时间，否则剩余记录会被跳过
    expect(window.serverTime.getTime()).toBeLessThan(dbNow.getTime());
  });

  it("keeps every row reachable across paginated rounds", () => {
    // 模拟客户端翻页：第一轮截断后，用 serverTime 作为 since（>= 比较）继续拉。
    const all = rows(5);
    const first = computeSyncWindow(all.slice(0, 3), 2, dbNow);
    expect(first.hasMore).toBe(true);
    const remaining = all.filter((row) => row.updated_at >= first.serverTime);
    const second = computeSyncWindow(remaining, 500, dbNow);
    expect(second.hasMore).toBe(false);
    const seen = new Set([...first.upserts, ...second.upserts].map((row) => row.id));
    expect(seen.size).toBe(5);
  });

  it("accepts string timestamps from the query layer", () => {
    const window = computeSyncWindow(
      [{ id: "a", updated_at: "2026-09-25T10:00:00.000Z" }, { id: "b", updated_at: "2026-09-25T10:01:00.000Z" }],
      1,
      dbNow
    );
    expect(window.hasMore).toBe(true);
    expect(window.serverTime).toEqual(new Date("2026-09-25T10:00:00.000Z"));
  });
});
