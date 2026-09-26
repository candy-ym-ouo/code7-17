-- 离线缓存增量同步支撑索引。
-- 客户端按 updated_at 游标拉取变更，按 deleted_at 拉取删除集合。
CREATE INDEX map_features_updated_sync_idx ON map_features(updated_at) WHERE deleted_at IS NULL;
CREATE INDEX map_features_deleted_sync_idx ON map_features(deleted_at) WHERE deleted_at IS NOT NULL;
