/**
 * 离线增量同步的游标推进逻辑（无 I/O 依赖，可独立单测）。
 *
 * 查询时按 limit + 1 取出：超出则说明窗口被截断，游标只能推进到
 * 最后一条已返回记录的 updated_at；否则推进到数据库当前时间。
 * 客户端下一次以 serverTime 作为 since（比较使用 >=，重复记录幂等覆盖）。
 */
export function computeSyncWindow<T extends { updated_at: Date | string }>(
  rows: T[],
  limit: number,
  dbNow: Date
): { upserts: T[]; serverTime: Date; hasMore: boolean } {
  if (rows.length > limit) {
    const upserts = rows.slice(0, limit);
    const last = upserts[upserts.length - 1]!;
    return { upserts, serverTime: new Date(last.updated_at), hasMore: true };
  }
  return { upserts: rows, serverTime: dbNow, hasMore: false };
}
