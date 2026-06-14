-- 线上已有数据库迁移：为用户表添加权限字段
ALTER TABLE users ADD COLUMN perm_upload INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN perm_view INTEGER DEFAULT 1;
UPDATE users SET perm_upload = 1, perm_view = 1 WHERE role = 'admin';
UPDATE users SET perm_upload = 0, perm_view = 1 WHERE role != 'admin';
