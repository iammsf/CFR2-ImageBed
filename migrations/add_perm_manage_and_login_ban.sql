-- 管理权限 + 登录防暴力（已有库执行一次）
ALTER TABLE users ADD COLUMN perm_manage INTEGER DEFAULT 0;
UPDATE users SET perm_manage = 1 WHERE role = 'admin';

CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    username TEXT,
    attempted_at INTEGER NOT NULL,
    success INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS login_bans (
    ip TEXT PRIMARY KEY,
    banned_until INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, attempted_at);

INSERT OR IGNORE INTO settings (key, value) VALUES ('login_ban_window_sec', '{"value":900}');
INSERT OR IGNORE INTO settings (key, value) VALUES ('login_ban_max_attempts', '{"value":5}');
INSERT OR IGNORE INTO settings (key, value) VALUES ('login_ban_duration_sec', '{"value":3600}');
