-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nickname TEXT,
    role TEXT DEFAULT 'guest',
    perm_upload INTEGER DEFAULT 0,
    perm_view INTEGER DEFAULT 1,
    perm_manage INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime ('%s', 'now'))
);

-- 文件/文件夹元数据表
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    parent TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    mime TEXT,
    etag TEXT,
    last_modified INTEGER,
    uploaded_by INTEGER,
    uploaded_at INTEGER DEFAULT (strftime ('%s', 'now')),
    hash TEXT
);

-- 已有数据库迁移（仅需执行一次）见 migrations/add_hash.sql

-- 系统设置表
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

-- 创建索引提升查询性能
CREATE INDEX IF NOT EXISTS idx_items_parent ON items (parent);

CREATE INDEX IF NOT EXISTS idx_items_parent_type_name ON items (parent, type DESC, name ASC);

CREATE INDEX IF NOT EXISTS idx_items_path ON items (path);

CREATE INDEX IF NOT EXISTS idx_items_hash ON items (hash);

CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- 插入默认设置（可选，安装时会自动初始化）
INSERT
OR IGNORE INTO settings (key, value)
VALUES
    ('site_title', '{"value":"我的图床"}');

INSERT
OR IGNORE INTO settings (key, value)
VALUES
    ('site_logo', '{"value":""}');

INSERT
OR IGNORE INTO settings (key, value)
VALUES
    ('site_bg', '{"value":""}');

INSERT
OR IGNORE INTO settings (key, value)
VALUES
    (
        'footer_html',
        '{"value":"<div style=\\"text-align:center; padding:16px;\\">Powered by Cloudflare</div>"}'
    );

INSERT
OR IGNORE INTO settings (key, value)
VALUES
    ('r2_public_url', '{"value":""}');

INSERT OR IGNORE INTO settings (key, value) VALUES ('login_ban_window_sec', '{"value":900}');
INSERT OR IGNORE INTO settings (key, value) VALUES ('login_ban_max_attempts', '{"value":5}');
INSERT OR IGNORE INTO settings (key, value) VALUES ('login_ban_duration_sec', '{"value":3600}');