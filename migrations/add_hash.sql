-- 为已有 items 表增加内容 hash 字段（可重复执行，列已存在时会报错可忽略）
ALTER TABLE items ADD COLUMN hash TEXT;

CREATE INDEX IF NOT EXISTS idx_items_hash ON items (hash);
