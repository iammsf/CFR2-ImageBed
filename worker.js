// ==================== worker.js ====================
// 绑定资源：R2_BUCKET / DB / ASSETS
// 性能优化：JWT 免 D1 验签、Settings/Install 边缘缓存、合并 API、并行 D1

const CACHE_SETTINGS = 'https://imgbed.internal/settings';
const CACHE_INSTALL = 'https://imgbed.internal/install-status';
const FILE_LIST_COLUMNS = 'path, name, parent, type, size, mime, uploaded_at, hash, uploaded_by';

let jwtVerifyKeyPromise = null;
let jwtVerifyKeySecret = null;
let dbSchemaReadyPromise = null;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (path.startsWith('/api/')) {
            return handleApi(request, path.slice(5), env, ctx);
        }

        const objectKey = path.slice(1);
        if (objectKey && !objectKey.includes('..')) {
            const obj = await getR2Object(objectKey, env);
            if (obj) {
                return buildR2Response(obj, objectKey);
            }
        }

        return new Response('Not Found', { status: 404 });
    }
};

// ------------------- API 处理 -------------------
async function ensureDbSchema(env) {
    if (!dbSchemaReadyPromise) {
        dbSchemaReadyPromise = migrateDbSchema(env).catch((err) => {
            dbSchemaReadyPromise = null;
            throw err;
        });
    }
    return dbSchemaReadyPromise;
}

async function migrateDbSchema(env) {
    const itemCols = await env.DB.prepare('PRAGMA table_info(items)').all();
    const itemNames = new Set((itemCols.results || []).map((col) => col.name));
    if (itemNames.has('path') && !itemNames.has('hash')) {
        await env.DB.prepare('ALTER TABLE items ADD COLUMN hash TEXT').run();
        await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_items_hash ON items (hash)').run();
    }

    const userCols = await env.DB.prepare('PRAGMA table_info(users)').all();
    const userNames = new Set((userCols.results || []).map((col) => col.name));
    if (userNames.has('username') && !userNames.has('perm_manage')) {
        await env.DB.prepare('ALTER TABLE users ADD COLUMN perm_manage INTEGER DEFAULT 0').run();
        await env.DB.prepare('UPDATE users SET perm_manage = 1 WHERE role = "admin"').run();
    }

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        username TEXT,
        attempted_at INTEGER NOT NULL,
        success INTEGER DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_bans (
        ip TEXT PRIMARY KEY,
        banned_until INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    )`).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip, attempted_at)').run();

    const defaultSettings = [
        ['login_ban_window_sec', 900],
        ['login_ban_max_attempts', 5],
        ['login_ban_duration_sec', 3600]
    ];
    for (const [key, val] of defaultSettings) {
        await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
            .bind(key, JSON.stringify({ value: val })).run();
    }
}

async function handleApi(request, action, env, ctx) {
    try {
        await ensureDbSchema(env);
        return await handleApiInner(request, action, env, ctx);
    } catch (err) {
        console.error('handleApi error', action, err);
        return jsonResponse({ error: 'Internal error' }, 500);
    }
}

async function resolveAuthenticatedUser(request, env) {
    const authHeader = request.headers.get('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const cookieToken = getTokenFromCookie(request) || '';

    if (bearerToken) {
        const user = await verifyToken(bearerToken, env);
        if (user) return user;
    }
    if (cookieToken && cookieToken !== bearerToken) {
        return await verifyToken(cookieToken, env);
    }
    return null;
}

async function handleApiInner(request, action, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (action === 'install-check') {
        return jsonResponse(await checkNeedInstall(env, ctx));
    }

    if (action === 'install') {
        if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
        const { username, password, nickname, r2PublicUrl } = await parseJsonBody(request);
        const adminCount = await env.DB.prepare('SELECT 1 as x FROM users WHERE role="admin" LIMIT 1').first();
        if (adminCount) return jsonResponse({ error: 'Already installed' }, 403);
        const passwordHash = await hashPassword(password);
        await env.DB.prepare('INSERT INTO users (username, password_hash, nickname, role, perm_upload, perm_view, perm_manage) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(username, passwordHash, nickname || username, 'admin', 1, 1, 1).run();
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .bind('r2_public_url', JSON.stringify({ value: r2PublicUrl })).run();
        await invalidateCache(CACHE_SETTINGS, CACHE_INSTALL);
        return jsonResponse({ success: true });
    }

    if (action === 'login') {
        if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
        const clientIp = getClientIp(request);
        const banInfo = await getActiveBanInfo(clientIp, env);
        if (banInfo) {
            return jsonResponse({ error: banInfo.message, banned: true, bannedUntil: banInfo.bannedUntil }, 429);
        }
        const { username, password } = await parseJsonBody(request);
        if (!username || !password) {
            await recordFailedLogin(clientIp, username, env, ctx);
            return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        const userRecord = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
        if (!userRecord || !(await verifyPassword(password, userRecord.password_hash))) {
            const banned = await recordFailedLogin(clientIp, username, env, ctx);
            if (banned) {
                const info = await getActiveBanInfo(clientIp, env);
                return jsonResponse({ error: info?.message || '登录失败次数过多，IP 已被封禁', banned: true, bannedUntil: info?.bannedUntil ?? 0 }, 429);
            }
            return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        await clearLoginAttempts(clientIp, env);
        const userPayload = buildUserFromRecord(userRecord);
        const jwt = await generateToken({
            userId: userPayload.id,
            username: userPayload.username,
            nickname: userPayload.nickname,
            role: userPayload.role,
            perm_upload: userPayload.perm_upload,
            perm_view: userPayload.perm_view,
            perm_manage: userPayload.perm_manage
        }, env);
        return new Response(JSON.stringify({ success: true, user: userPayload, token: jwt }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': buildAuthCookie(jwt, request)
            }
        });
    }

    const user = await resolveAuthenticatedUser(request, env);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    switch (action) {
        case 'bootstrap':
            if (method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            return handleBootstrap(url, user, env, ctx);
        case 'manage-panel':
            if (method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            if (!hasManagePermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return handleManagePanel(user, env, ctx);
        case 'logout':
            return new Response(null, { status: 204, headers: { 'Set-Cookie': 'token=; Path=/; Max-Age=0' } });
        case 'user/profile':
            if (method === 'GET') {
                const profileRecord = await env.DB.prepare(
                    'SELECT id, username, nickname, role, perm_upload, perm_view, perm_manage FROM users WHERE id = ?'
                ).bind(user.id).first();
                return profileRecord
                    ? jsonResponse(buildUserFromRecord(profileRecord))
                    : jsonResponse({ error: 'Not found' }, 404);
            }
            if (method === 'PUT') return handleProfileUpdate(request, user, env);
            break;
        case 'users':
            if (user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
            if (method === 'GET') {
                const users = await env.DB.prepare('SELECT id, username, nickname, role, perm_upload, perm_view, perm_manage, created_at FROM users').all();
                return jsonResponse(users.results.map(buildUserFromRecord));
            }
            if (method === 'POST') {
                const { username, password, nickname, role } = await request.json();
                const hash = await hashPassword(password);
                const roleVal = role || 'guest';
                const isAdmin = roleVal === 'admin';
                await env.DB.prepare('INSERT INTO users (username, password_hash, nickname, role, perm_upload, perm_view, perm_manage) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .bind(username, hash, nickname || username, roleVal, isAdmin ? 1 : 0, 1, isAdmin ? 1 : 0).run();
                return jsonResponse({ success: true });
            }
            break;
        case 'user':
            if (user.role === 'admin') {
                if (method === 'DELETE') {
                    const { id } = await request.json();
                    if (id === user.id) return jsonResponse({ error: 'Cannot delete yourself' }, 400);
                    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
                    return jsonResponse({ success: true });
                }
                if (method === 'PUT') {
                    return handleUserPermissionsUpdate(request, env);
                }
            }
            break;
        case 'settings':
            if (method === 'GET') return jsonResponse(await getSettings(env, ctx));
            if (method === 'PUT' && hasManagePermission(user)) {
                const newSettings = await request.json();
                for (const [key, val] of Object.entries(newSettings)) {
                    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
                        .bind(key, JSON.stringify({ value: val })).run();
                }
                await invalidateCache(CACHE_SETTINGS);
                return jsonResponse({ success: true });
            }
            break;
        case 'settings/export':
            if (user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
            if (method === 'GET') {
                const settings = await getSettings(env, ctx);
                return new Response(JSON.stringify(settings, null, 2), {
                    headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="settings.json"' }
                });
            }
            break;
        case 'settings/import':
            if (user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
            if (method === 'POST') {
                const importData = await request.json();
                for (const [key, val] of Object.entries(importData)) {
                    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
                        .bind(key, JSON.stringify({ value: val })).run();
                }
                await invalidateCache(CACHE_SETTINGS);
                return jsonResponse({ success: true });
            }
            break;
        case 'files': {
            if (!hasViewPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            const parent = normalizeParent(url.searchParams.get('parent') || '/');
            return jsonResponse(await listFiles(parent, env));
        }
        case 'file/raw': {
            if (method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            if (!hasViewPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return serveR2File(url.searchParams.get('path'), env);
        }
        case 'folders':
            if (method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            if (!hasViewPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return jsonResponse(await listAllFolders(env));
        case 'refresh-index':
            if (!hasManagePermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            {
                const full = url.searchParams.get('mode') === 'full';
                const stats = await syncR2ToDB(env, { full });
                return jsonResponse({ success: true, ...stats });
            }
        case 'upload':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleUpload(request, user, env, ctx);
        case 'mkdir': {
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            const { path: folderPath } = await parseJsonBody(request);
            if (!folderPath) return jsonResponse({ error: 'Invalid path' }, 400);
            const folder = await createFolder(folderPath, user.id, env);
            const normalized = normalizeDbDirPath(folderPath);
            const slash = normalized.lastIndexOf('/');
            const parent = slash <= 0 ? '/' : normalized.slice(0, slash);
            return jsonResponse({ success: true, folder, parent });
        }
        case 'move':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleMove(request, user, env);
        case 'copy':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleCopy(request, user, env);
        case 'rename':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleRename(request, user, env);
        case 'delete':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleDelete(request, user, env);
        case 'stats':
            return jsonResponse(await getStats(env));
        default:
            return jsonResponse({ error: 'Not found' }, 404);
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
}

async function handleBootstrap(url, user, env, ctx) {
    if (!hasViewPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
    const parent = normalizeParent(url.searchParams.get('parent') || '/');
    const [settings, files, userRecord] = await Promise.all([
        getSettings(env, ctx),
        listFiles(parent, env),
        env.DB.prepare(
            'SELECT id, username, nickname, role, perm_upload, perm_view, perm_manage FROM users WHERE id = ?'
        ).bind(user.id).first()
    ]);
    return jsonResponse({
        user: userRecord ? buildUserFromRecord(userRecord) : buildUserFromRecord(user),
        settings,
        files
    });
}

async function handleManagePanel(user, env, ctx) {
    const [settings, stats, usersResult] = await Promise.all([
        getSettings(env, ctx),
        getStats(env),
        user.role === 'admin'
            ? env.DB.prepare('SELECT id, username, nickname, role, perm_upload, perm_view, perm_manage, created_at FROM users').all()
            : Promise.resolve({ results: [] })
    ]);
    return jsonResponse({
        settings,
        stats,
        users: usersResult.results.map(buildUserFromRecord),
        canManageUsers: user.role === 'admin'
    });
}

async function handleUserPermissionsUpdate(request, env) {
    const { id, perm_upload, perm_view, perm_manage } = await request.json();
    if (!id) return jsonResponse({ error: 'Missing id' }, 400);
    const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
    if (!target) return jsonResponse({ error: 'Not found' }, 404);
    if (target.role === 'admin') return jsonResponse({ error: 'Cannot modify admin permissions' }, 400);
    const uploadVal = perm_upload ? 1 : 0;
    const viewVal = perm_view ? 1 : 0;
    const manageVal = perm_manage ? 1 : 0;
    await env.DB.prepare('UPDATE users SET perm_upload = ?, perm_view = ?, perm_manage = ? WHERE id = ?')
        .bind(uploadVal, viewVal, manageVal, id).run();
    return jsonResponse({ success: true });
}

async function handleProfileUpdate(request, user, env) {
    const { nickname, password } = await request.json();
    const updatedUser = { ...user };
    if (nickname) {
        await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(nickname, user.id).run();
        updatedUser.nickname = nickname;
    }
    if (password) {
        const newHash = await hashPassword(password);
        await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user.id).run();
    }
    const jwt = await generateToken({
        userId: updatedUser.id,
        username: updatedUser.username,
        nickname: updatedUser.nickname,
        role: updatedUser.role,
        perm_upload: updatedUser.perm_upload,
        perm_view: updatedUser.perm_view,
        perm_manage: updatedUser.perm_manage
    }, env);
    return new Response(JSON.stringify({ success: true, user: updatedUser, token: jwt }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': buildAuthCookie(jwt, request)
        }
    });
}

async function checkNeedInstall(env, ctx) {
    const cached = await readCache(CACHE_INSTALL);
    if (cached) return cached;
    try {
        const admin = await env.DB.prepare('SELECT 1 as x FROM users WHERE role="admin" LIMIT 1').first();
        const result = { needInstall: !admin };
        if (!result.needInstall && ctx) {
            ctx.waitUntil(writeCache(CACHE_INSTALL, result, 3600));
        }
        return result;
    } catch {
        return { needInstall: true, error: 'DB not initialized' };
    }
}

async function listFiles(parent, env) {
    const items = await env.DB.prepare(
        `SELECT ${FILE_LIST_COLUMNS} FROM items WHERE parent = ? ORDER BY type DESC, name ASC`
    ).bind(parent).all();
    return items.results;
}

async function listAllFolders(env) {
    const items = await env.DB.prepare(
        'SELECT path, name, parent FROM items WHERE type = "dir" ORDER BY path ASC'
    ).all();
    return items.results;
}

async function getR2Object(key, env) {
    if (!key) return null;
    let obj = await env.R2_BUCKET.get(key);
    if (obj) return obj;
    try {
        const decoded = decodeURIComponent(key);
        if (decoded !== key) obj = await env.R2_BUCKET.get(decoded);
    } catch { /* ignore */ }
    return obj;
}

function buildR2Response(obj, objectKey, options = {}) {
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    const contentType = headers.get('Content-Type') || '';
    if (/\.svg$/i.test(objectKey)) {
        headers.set('Content-Type', 'image/svg+xml');
    } else if (!contentType || contentType === 'application/octet-stream') {
        const guessed = guessMimeFromName(objectKey);
        if (guessed) headers.set('Content-Type', guessed);
    }
    headers.set('etag', obj.httpEtag);
    headers.set(
        'Cache-Control',
        options.private ? 'private, max-age=3600' : 'public, max-age=31536000, immutable'
    );
    return new Response(obj.body, { headers });
}

async function serveR2File(pathParam, env) {
    if (!pathParam || pathParam.includes('..')) return jsonResponse({ error: 'Invalid path' }, 400);
    const key = String(pathParam).replace(/^\/+/, '');
    const obj = await getR2Object(key, env);
    if (!obj) return jsonResponse({ error: 'Not found' }, 404);
    return buildR2Response(obj, key, { private: true });
}

// ------------------- 缓存 -------------------
async function readCache(key) {
    const res = await caches.default.match(key);
    if (!res) return null;
    return res.json();
}

async function writeCache(key, data, maxAge) {
    await caches.default.put(key, new Response(JSON.stringify(data), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${maxAge}`
        }
    }));
}

async function invalidateCache(...keys) {
    await Promise.all(keys.map((key) => caches.default.delete(key)));
}

// ------------------- 认证 -------------------
async function hashPassword(pw) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', encoder.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits({
        name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256'
    }, key, 256);
    const hashHex = Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, '0')).join('');
    const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${saltHex}:${hashHex}`;
}

async function verifyPassword(pw, stored) {
    try {
        if (!pw || !stored || !stored.includes(':')) return false;
        const [saltHex, hashHex] = stored.split(':');
        if (!saltHex || !hashHex) return false;
        const pairs = saltHex.match(/.{2}/g);
        if (!pairs) return false;
        const salt = new Uint8Array(pairs.map((b) => parseInt(b, 16)));
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey('raw', encoder.encode(pw), 'PBKDF2', false, ['deriveBits']);
        const derived = await crypto.subtle.deriveBits({
            name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256'
        }, key, 256);
        const newHash = Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, '0')).join('');
        return newHash === hashHex;
    } catch {
        return false;
    }
}

async function generateToken(payload, env) {
    const secret = env.JWT_SECRET || 'default-secret-change-me';
    const encoder = new TextEncoder();
    const data = JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 3600 * 1000 });
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    return encodeBase64(data) + '.' + encodeBase64Bytes(new Uint8Array(signature));
}

async function getJwtVerifyKey(secret) {
    if (jwtVerifyKeyPromise && jwtVerifyKeySecret === secret) return jwtVerifyKeyPromise;
    jwtVerifyKeySecret = secret;
    jwtVerifyKeyPromise = crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );
    return jwtVerifyKeyPromise;
}

async function verifyToken(token, env) {
    try {
        const dot = token.indexOf('.');
        if (dot <= 0) return null;
        const payloadB64 = token.slice(0, dot);
        const sigB64 = token.slice(dot + 1);
        const data = decodeBase64(payloadB64);
        const payload = JSON.parse(data);
        if (!payload.userId || payload.exp < Date.now()) return null;

        const secret = env.JWT_SECRET || 'default-secret-change-me';
        const sig = decodeBase64Bytes(sigB64);
        const key = await getJwtVerifyKey(secret);
        const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
        if (!valid) return null;

        // 始终从 D1 读取最新权限，避免 JWT 内嵌权限过期（管理员改权限后无需强制重新登录）
        const userRecord = await env.DB.prepare(
            'SELECT id, username, nickname, role, perm_upload, perm_view, perm_manage FROM users WHERE id = ?'
        ).bind(payload.userId).first();
        return userRecord ? buildUserFromRecord(userRecord) : null;
    } catch {
        return null;
    }
}

function encodeBase64(str) {
    const bytes = new TextEncoder().encode(str);
    return encodeBase64Bytes(bytes);
}

function encodeBase64Bytes(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function decodeBase64(b64) {
    return new TextDecoder().decode(decodeBase64Bytes(b64));
}

function decodeBase64Bytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function getTokenFromCookie(request) {
    const cookie = request.headers.get('Cookie');
    if (!cookie) return null;
    const match = cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

function getAuthToken(request) {
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Bearer ')) {
        const bearer = auth.slice(7).trim();
        if (bearer) return bearer;
    }
    return getTokenFromCookie(request);
}

function buildAuthCookie(token, request) {
    const url = new URL(request.url);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const secure = url.protocol === 'https:' && !isLocalhost ? '; Secure' : '';
    return `token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${7 * 24 * 3600}`;
}

async function parseJsonBody(request) {
    try {
        return await request.json();
    } catch {
        throw new Error('Invalid JSON body');
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

/** 目录 parent：根为 `/`，其余为 `/a/b`（无前导以外的斜杠，无尾部斜杠） */
function normalizeParent(parent) {
    if (parent == null || parent === '' || parent === 'undefined' || parent === 'null') return '/';
    let p = String(parent).trim().replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/').replace(/\/$/, '');
    return p || '/';
}

/** 目录在 items 表中的 path：与 parent 同规则 */
function normalizeDbDirPath(path) {
    if (path == null || path === '' || String(path).includes('undefined')) {
        throw new Error('Invalid folder path');
    }
    return normalizeParent(path);
}

/** 由 parent + 文件名生成 R2 对象 key（无开头斜杠） */
function buildObjectKey(parent, fileName) {
    const dir = normalizeParent(parent);
    const name = String(fileName || '').replace(/^\/+/, '');
    if (!name) throw new Error('Invalid file name');
    if (dir === '/') return name;
    return dir.slice(1) + '/' + name;
}

/** 目录占位符在 R2 中的 key */
function buildFolderMarkerKey(dbDirPath) {
    const dir = normalizeDbDirPath(dbDirPath);
    if (dir === '/') return '.folder';
    return dir.slice(1) + '/.folder';
}

function buildUserFromRecord(userRecord) {
    const isAdmin = userRecord.role === 'admin';
    return {
        id: userRecord.id,
        username: userRecord.username,
        nickname: userRecord.nickname || userRecord.username,
        role: userRecord.role,
        perm_upload: isAdmin ? 1 : Number(userRecord.perm_upload ?? 0),
        perm_view: isAdmin ? 1 : Number(userRecord.perm_view ?? 1),
        perm_manage: isAdmin ? 1 : Number(userRecord.perm_manage ?? 0)
    };
}

function hasManagePermission(user) {
    return user.role === 'admin' || Number(user.perm_manage) === 1;
}

function hasUploadPermission(user) {
    return user.role === 'admin' || Number(user.perm_upload) === 1;
}

function hasViewPermission(user) {
    return user.role === 'admin' || Number(user.perm_view) === 1;
}

function getClientIp(request) {
    return request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
        || 'unknown';
}

async function getLoginBanSettings(env, ctx) {
    const settings = await getSettings(env, ctx);
    const windowSec = Math.max(60, Number(settings.login_ban_window_sec) || 900);
    const maxAttempts = Math.max(1, Number(settings.login_ban_max_attempts) || 5);
    const rawDuration = settings.login_ban_duration_sec;
    const banDurationSec = rawDuration === 0 || rawDuration === '0' ? 0 : Math.max(60, Number(rawDuration) || 3600);
    return { windowSec, maxAttempts, banDurationSec };
}

async function getActiveBanInfo(ip, env) {
    const ban = await env.DB.prepare('SELECT banned_until FROM login_bans WHERE ip = ?').bind(ip).first();
    if (!ban) return null;
    const bannedUntil = Number(ban.banned_until);
    if (bannedUntil === 0) {
        return { message: '登录已被永久封禁，请稍后再试或联系管理员', bannedUntil: 0 };
    }
    if (Date.now() < bannedUntil) {
        return {
            message: `登录失败次数过多，请于 ${new Date(bannedUntil).toLocaleString('zh-CN', { hour12: false })} 后再试`,
            bannedUntil
        };
    }
    await env.DB.prepare('DELETE FROM login_bans WHERE ip = ?').bind(ip).run();
    return null;
}

async function clearLoginAttempts(ip, env) {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

async function recordFailedLogin(ip, username, env, ctx) {
    const cfg = await getLoginBanSettings(env, ctx);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO login_attempts (ip, username, attempted_at, success) VALUES (?, ?, ?, 0)')
        .bind(ip, username || '', now).run();
    await env.DB.prepare('DELETE FROM login_attempts WHERE attempted_at < ?')
        .bind(now - cfg.windowSec * 1000).run();
    const countRow = await env.DB.prepare(
        'SELECT COUNT(*) as cnt FROM login_attempts WHERE ip = ? AND success = 0 AND attempted_at >= ?'
    ).bind(ip, now - cfg.windowSec * 1000).first();
    if ((countRow?.cnt || 0) < cfg.maxAttempts) return false;
    const bannedUntil = cfg.banDurationSec === 0 ? 0 : now + cfg.banDurationSec * 1000;
    await env.DB.prepare('INSERT OR REPLACE INTO login_bans (ip, banned_until, created_at) VALUES (?, ?, ?)')
        .bind(ip, bannedUntil, now).run();
    return true;
}

async function canUserDeletePath(user, targetPath, env) {
    if (!hasUploadPermission(user)) return { ok: false, error: 'Forbidden' };
    if (hasManagePermission(user)) return { ok: true };

    const item = await env.DB.prepare('SELECT type, uploaded_by FROM items WHERE path = ?').bind(targetPath).first();
    if (!item) return { ok: false, error: 'Not found' };

    if (item.type === 'file') {
        if (item.uploaded_by == null || Number(item.uploaded_by) !== Number(user.id)) {
            return { ok: false, error: '只能删除自己上传的文件' };
        }
        return { ok: true };
    }

    const dirPath = normalizeDbDirPath(targetPath);
    const prefix = dirPath === '/' ? '' : dirPath.slice(1);
    const files = prefix
        ? await env.DB.prepare('SELECT uploaded_by FROM items WHERE type = "file" AND path LIKE ?').bind(`${prefix}/%`).all()
        : await env.DB.prepare('SELECT uploaded_by FROM items WHERE type = "file"').all();

    for (const row of files.results) {
        if (row.uploaded_by == null || Number(row.uploaded_by) !== Number(user.id)) {
            return { ok: false, error: '文件夹中含有他人上传或无归属的文件，无法删除' };
        }
    }
    return { ok: true };
}

function guessMimeFromName(filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    const map = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
        avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tiff: 'image/tiff', tif: 'image/tiff'
    };
    return map[ext] || null;
}

async function getSettings(env, ctx) {
    const cached = await readCache(CACHE_SETTINGS);
    if (cached) return cached;

    try {
        const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
        const settings = {};
        for (const row of rows.results) {
            try {
                settings[row.key] = JSON.parse(row.value).value;
            } catch {
                settings[row.key] = row.value;
            }
        }
        const result = {
            site_title: settings.site_title || '我的图床',
            site_logo: settings.site_logo || '',
            site_bg: settings.site_bg || '',
            footer_html: settings.footer_html || '',
            r2_public_url: settings.r2_public_url || '',
            login_ban_window_sec: Number(settings.login_ban_window_sec ?? 900),
            login_ban_max_attempts: Number(settings.login_ban_max_attempts ?? 5),
            login_ban_duration_sec: settings.login_ban_duration_sec === 0 || settings.login_ban_duration_sec === '0'
                ? 0
                : Number(settings.login_ban_duration_sec ?? 3600)
        };
        if (ctx) ctx.waitUntil(writeCache(CACHE_SETTINGS, result, 600));
        return result;
    } catch (err) {
        console.error('getSettings error', err);
        return {
            site_title: '我的图床',
            site_logo: '',
            site_bg: '',
            footer_html: '',
            r2_public_url: '',
            login_ban_window_sec: 900,
            login_ban_max_attempts: 5,
            login_ban_duration_sec: 3600
        };
    }
}

// ------------------- 文件 Hash -------------------
async function sha256Hex(data) {
    let buffer;
    if (data instanceof ArrayBuffer) {
        buffer = data;
    } else if (ArrayBuffer.isView(data)) {
        buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else if (data && typeof data.arrayBuffer === 'function') {
        buffer = await data.arrayBuffer();
    } else {
        buffer = data;
    }
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashFromR2Key(key, env) {
    const obj = await env.R2_BUCKET.get(key);
    if (!obj) return null;
    return sha256Hex(await obj.arrayBuffer());
}

async function backfillFileHashes(env, limit = 40) {
    const rows = await env.DB.prepare(
        'SELECT path FROM items WHERE type = "file" AND (hash IS NULL OR hash = "") LIMIT ?'
    ).bind(limit).all();
    let count = 0;
    for (const row of rows.results) {
        try {
            const hash = await hashFromR2Key(row.path, env);
            if (hash) {
                await env.DB.prepare('UPDATE items SET hash = ? WHERE path = ?').bind(hash, row.path).run();
                count++;
            }
        } catch (err) {
            console.error('backfill hash failed', row.path, err);
        }
    }
    const pending = await env.DB.prepare(
        'SELECT COUNT(*) as cnt FROM items WHERE type = "file" AND (hash IS NULL OR hash = "")'
    ).first();
    return { count, pending: pending?.cnt || 0 };
}

function buildPublicUrl(key, settings, origin) {
    const base = settings.r2_public_url ? settings.r2_public_url.replace(/\/$/, '') : origin;
    return `${base}/${key}`;
}

async function findFileByHash(hash, env) {
    if (!hash) return null;
    return env.DB.prepare('SELECT path, name FROM items WHERE type = "file" AND hash = ? LIMIT 1').bind(hash).first();
}

// ------------------- R2 同步 -------------------
function collectAncestorDirs(dirPath) {
    const dirs = [];
    if (!dirPath || dirPath === '/') return dirs;
    let current = dirPath;
    while (current && current !== '/') {
        dirs.push(current);
        const slash = current.lastIndexOf('/');
        current = slash <= 0 ? '/' : current.slice(0, slash);
    }
    return dirs;
}

async function runDbBatch(env, stmts, chunkSize = 50) {
    for (let i = 0; i < stmts.length; i += chunkSize) {
        await env.DB.batch(stmts.slice(i, i + chunkSize));
    }
}

async function listAllR2Objects(env) {
    const allObjects = [];
    let cursor;
    do {
        const list = await env.R2_BUCKET.list({ cursor });
        allObjects.push(...list.objects);
        cursor = list.cursor;
    } while (cursor);
    return allObjects;
}

function parseR2Listing(allObjects) {
    const r2Files = new Map();
    const r2Keys = new Set();
    const neededDirs = new Set();

    for (const obj of allObjects) {
        const key = obj.key;
        if (!key) continue;
        r2Keys.add(key);

        if (key.endsWith('/.folder') || key === '.folder') {
            const dirPath = markerKeyToDirPath(key);
            if (dirPath && dirPath !== '/') {
                for (const d of collectAncestorDirs(dirPath)) neededDirs.add(d);
            }
            continue;
        }

        const parts = key.split('/');
        const fileName = parts.pop();
        if (!fileName || fileName === '.folder') continue;

        const parent = parts.length ? normalizeParent('/' + parts.join('/')) : '/';
        for (const d of collectAncestorDirs(parent)) neededDirs.add(d);

        r2Files.set(key, {
            fileName,
            parent,
            size: obj.size,
            etag: obj.etag ?? '',
            lastModified: obj.uploaded instanceof Date ? obj.uploaded.getTime() : Number(obj.uploaded) || Date.now(),
            mime: obj.httpMetadata?.contentType || guessMimeFromName(fileName) || 'application/octet-stream'
        });
    }

    return { r2Files, r2Keys, neededDirs };
}

async function syncR2ToDB(env, options = {}) {
    if (options.full) return syncR2ToDBFull(env);
    return syncR2ToDBIncremental(env);
}

/** 全量重建：清空 D1 后按 R2 列表重建，仅用于严重不一致时的兜底 */
async function syncR2ToDBFull(env) {
    const allObjects = await listAllR2Objects(env);
    await env.DB.prepare('DELETE FROM items').run();

    let filesIndexed = 0;
    const { r2Files, neededDirs } = parseR2Listing(allObjects);

    for (const dir of neededDirs) await ensureDirPath(dir, env);

    const stmts = [];
    for (const [key, meta] of r2Files) {
        stmts.push(
            env.DB.prepare(
                'INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, etag, last_modified, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(key, meta.fileName, meta.parent, 'file', meta.size, meta.mime, meta.etag, meta.lastModified, null)
        );
        filesIndexed++;
    }
    await runDbBatch(env, stmts);

    const { count: hashBackfilled, pending: hashPending } = await backfillFileHashes(env);
    return { mode: 'full', filesIndexed, hashBackfilled, hashPending };
}

/** 增量同步：对比 R2 与 D1，仅写入差异项 */
async function syncR2ToDBIncremental(env) {
    const allObjects = await listAllR2Objects(env);
    const { r2Files, r2Keys, neededDirs } = parseR2Listing(allObjects);

    for (const dir of neededDirs) await ensureDirPath(dir, env);

    const dbRows = await env.DB.prepare(
        'SELECT path, size, etag, last_modified, hash FROM items WHERE type = "file"'
    ).all();
    const dbFiles = new Map(dbRows.results.map((row) => [row.path, row]));

    const stats = { mode: 'incremental', added: 0, updated: 0, removed: 0, removedDirs: 0, unchanged: 0 };
    const stmts = [];

    for (const [key, meta] of r2Files) {
        const existing = dbFiles.get(key);
        if (!existing) {
            stmts.push(
                env.DB.prepare(
                    'INSERT INTO items (path, name, parent, type, size, mime, etag, last_modified, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(key, meta.fileName, meta.parent, 'file', meta.size, meta.mime, meta.etag, meta.lastModified, null)
            );
            stats.added++;
        } else {
            const etagSame = (existing.etag ?? '') === meta.etag;
            const sizeSame = Number(existing.size) === Number(meta.size);
            const mtimeSame = Number(existing.last_modified) === Number(meta.lastModified);
            if (etagSame && sizeSame && mtimeSame) {
                stats.unchanged++;
            } else {
                const hash = etagSame ? existing.hash : null;
                stmts.push(
                    env.DB.prepare(
                        'UPDATE items SET name = ?, parent = ?, size = ?, mime = ?, etag = ?, last_modified = ?, hash = ? WHERE path = ?'
                    ).bind(meta.fileName, meta.parent, meta.size, meta.mime, meta.etag, meta.lastModified, hash, key)
                );
                stats.updated++;
            }
            dbFiles.delete(key);
        }
    }

    for (const [path] of dbFiles) {
        stmts.push(env.DB.prepare('DELETE FROM items WHERE path = ?').bind(path));
        stats.removed++;
    }

    await runDbBatch(env, stmts);

    const validDirs = new Set(['/', ...neededDirs]);
    stats.removedDirs = await cleanupOrphanDirs(env, validDirs);

    const { count: hashBackfilled, pending: hashPending } = await backfillFileHashes(env);
    return { ...stats, hashBackfilled, hashPending };
}

async function cleanupOrphanDirs(env, validDirs) {
    const dbDirs = await env.DB.prepare('SELECT path FROM items WHERE type = "dir" AND path != "/"').all();
    const toRemove = dbDirs.results
        .filter((row) => !validDirs.has(row.path))
        .sort((a, b) => b.path.length - a.path.length);
    if (toRemove.length === 0) return 0;

    await runDbBatch(
        env,
        toRemove.map((row) => env.DB.prepare('DELETE FROM items WHERE path = ?').bind(row.path))
    );
    return toRemove.length;
}

/** R2 目录占位符 key → D1 目录 path */
function markerKeyToDirPath(key) {
    if (!key) return null;
    if (key === '.folder') return '/';
    if (!key.endsWith('/.folder')) return null;
    const dirKey = key.slice(0, -'.folder'.length).replace(/\/$/, '');
    if (!dirKey) return '/';
    return normalizeParent('/' + dirKey);
}

async function ensureDirPath(dirPath, env) {
    if (dirPath === '/' || dirPath === '') return;
    const parts = dirPath.split('/').filter((p) => p);
    let current = '';
    for (const part of parts) {
        current += '/' + part;
        const exists = await env.DB.prepare('SELECT 1 as x FROM items WHERE path = ? LIMIT 1').bind(current).first();
        if (!exists) {
            await env.DB.prepare('INSERT INTO items (path, name, parent, type) VALUES (?, ?, ?, ?)')
                .bind(current, part, current.substring(0, current.lastIndexOf('/')) || '/', 'dir').run();
        }
    }
}

async function createFolder(folderPath, userId, env) {
    const normalized = normalizeDbDirPath(folderPath);
    const parts = normalized.split('/').filter(Boolean);
    let current = '';
    let folderRecord = null;
    for (let i = 0; i < parts.length; i++) {
        current += '/' + parts[i];
        const parent = current.substring(0, current.lastIndexOf('/')) || '/';
        const exists = await env.DB.prepare('SELECT 1 as x FROM items WHERE path = ? LIMIT 1').bind(current).first();
        if (!exists) {
            await env.DB.prepare('INSERT INTO items (path, name, parent, type, uploaded_by) VALUES (?, ?, ?, ?, ?)')
                .bind(current, parts[i], parent, 'dir', userId).run();
        }
        if (current === normalized) {
            folderRecord = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path = ?`).bind(current).first();
        }
    }
    if (!folderRecord) {
        folderRecord = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path = ?`).bind(normalized).first();
    }
    if (!folderRecord) throw new Error('Failed to persist folder metadata');

    await env.R2_BUCKET.put(buildFolderMarkerKey(normalized), '', { httpMetadata: { contentType: 'application/x-directory' } });
    return folderRecord;
}

async function handleUpload(request, user, env, ctx) {
    const formData = await request.formData();
    const files = formData.getAll('files');
    const targetDir = normalizeParent(formData.get('targetDir') || '/');
    const settings = await getSettings(env, ctx);
    const origin = new URL(request.url).origin;
    const results = [];

    for (const file of files) {
        if (!file.name) continue;
        if (file.size > 20 * 1024 * 1024) {
            results.push({ name: file.name, error: 'File too large (max 20MB)' });
            continue;
        }
        try {
            const buffer = await file.arrayBuffer();
            const hash = await sha256Hex(buffer);
            const duplicate = await findFileByHash(hash, env);
            if (duplicate) {
                results.push({
                    name: file.name,
                    success: true,
                    duplicate: true,
                    message: '文件已存在',
                    url: buildPublicUrl(duplicate.path, settings, origin),
                    existingPath: duplicate.path,
                    existingName: duplicate.name
                });
                continue;
            }

            const key = buildObjectKey(targetDir, file.name);
            const mime = file.type || guessMimeFromName(file.name) || 'application/octet-stream';
            await env.R2_BUCKET.put(key, buffer, { httpMetadata: { contentType: mime } });
            await env.DB.prepare(
                'INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, uploaded_by, uploaded_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(key, file.name, targetDir, 'file', file.size, mime, user.id, Date.now(), hash).run();
            results.push({ name: file.name, success: true, url: buildPublicUrl(key, settings, origin) });
        } catch (err) {
            results.push({ name: file.name, error: err.message });
        }
    }
    return jsonResponse({ results });
}

async function handleMove(request, user, env) {
    const { sourcePath, targetDir, overwrite = false } = await request.json();
    const destDir = normalizeParent(targetDir);
    const item = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path = ?`).bind(sourcePath).first();
    if (!item) return jsonResponse({ error: 'Not found' }, 404);
    if (item.type === 'file') {
        const newPath = buildObjectKey(destDir, item.name);
        const existing = await env.DB.prepare('SELECT 1 as x FROM items WHERE path = ? LIMIT 1').bind(newPath).first();
        if (existing && !overwrite) return jsonResponse({ error: '目标位置已存在同名文件' }, 409);
        const obj = await env.R2_BUCKET.get(sourcePath);
        if (obj) {
            await env.R2_BUCKET.put(newPath, obj.body, { httpMetadata: obj.httpMetadata });
            await env.R2_BUCKET.delete(sourcePath);
        }
        if (existing && overwrite) {
            await env.DB.prepare('DELETE FROM items WHERE path = ?').bind(newPath).run();
        }
        await env.DB.prepare('INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, uploaded_by, uploaded_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(newPath, item.name, destDir, 'file', item.size, item.mime, user.id, item.uploaded_at || Date.now(), item.hash || null).run();
        await env.DB.prepare('DELETE FROM items WHERE path = ?').bind(sourcePath).run();
    } else {
        const children = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path LIKE ?`).bind(sourcePath + '%').all();
        for (const child of children.results) {
            const relative = child.path.slice(sourcePath.length).replace(/^\//, '');
            const newPath = buildObjectKey(destDir, relative);
            const obj = await env.R2_BUCKET.get(child.path);
            if (obj) {
                await env.R2_BUCKET.put(newPath, obj.body, { httpMetadata: obj.httpMetadata });
                await env.R2_BUCKET.delete(child.path);
            }
            const newParent = normalizeParent(newPath.includes('/') ? '/' + newPath.split('/').slice(0, -1).join('/') : '/');
            await env.DB.prepare('UPDATE items SET path = ?, parent = ? WHERE path = ?')
                .bind(newPath, newParent, child.path).run();
        }
    }
    return jsonResponse({ success: true });
}

async function handleCopy(request, user, env) {
    const { sourcePath, targetDir, overwrite = false } = await request.json();
    const destDir = normalizeParent(targetDir);
    const item = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path = ?`).bind(sourcePath).first();
    if (!item) return jsonResponse({ error: 'Not found' }, 404);
    if (item.type === 'file') {
        const newPath = buildObjectKey(destDir, item.name);
        const existing = await env.DB.prepare('SELECT 1 as x FROM items WHERE path = ? LIMIT 1').bind(newPath).first();
        if (existing && !overwrite) return jsonResponse({ error: '目标位置已存在同名文件' }, 409);
        const obj = await env.R2_BUCKET.get(sourcePath);
        if (obj) {
            await env.R2_BUCKET.put(newPath, obj.body, { httpMetadata: obj.httpMetadata });
            if (existing && overwrite) {
                await env.DB.prepare('DELETE FROM items WHERE path = ?').bind(newPath).run();
            }
            await env.DB.prepare('INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, uploaded_by, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(newPath, item.name, destDir, 'file', item.size, item.mime, user.id, item.hash || null).run();
        }
    } else {
        const children = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path LIKE ?`).bind(sourcePath + '%').all();
        for (const child of children.results) {
            const relative = child.path.slice(sourcePath.length).replace(/^\//, '');
            const newPath = buildObjectKey(destDir, relative);
            const obj = await env.R2_BUCKET.get(child.path);
            if (obj) {
                await env.R2_BUCKET.put(newPath, obj.body, { httpMetadata: obj.httpMetadata });
                await env.DB.prepare('INSERT INTO items (path, name, parent, type, size, mime, uploaded_by, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .bind(newPath, child.name, normalizeParent(newPath.includes('/') ? '/' + newPath.split('/').slice(0, -1).join('/') : '/'), child.type, child.size, child.mime, user.id, child.hash || null).run();
            }
        }
    }
    return jsonResponse({ success: true });
}

function validateItemName(name) {
    const n = String(name || '').trim();
    if (!n || n === '.' || n === '..') return null;
    if (/[/\\]/.test(n)) return null;
    return n;
}

async function handleRename(request, user, env) {
    const { path: sourcePath, newName } = await request.json();
    const name = validateItemName(newName);
    if (!sourcePath || !name) return jsonResponse({ error: 'Invalid name' }, 400);

    const item = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path = ?`).bind(sourcePath).first();
    if (!item) return jsonResponse({ error: 'Not found' }, 404);

    if (item.type === 'file') {
        const newPath = buildObjectKey(item.parent, name);
        if (newPath === sourcePath) return jsonResponse({ success: true, path: newPath, type: 'file' });
        const existing = await env.DB.prepare('SELECT 1 as x FROM items WHERE path = ? LIMIT 1').bind(newPath).first();
        if (existing) return jsonResponse({ error: '同名文件已存在' }, 409);
        const obj = await env.R2_BUCKET.get(sourcePath);
        if (!obj) return jsonResponse({ error: 'File missing in storage' }, 404);
        await env.R2_BUCKET.put(newPath, obj.body, { httpMetadata: obj.httpMetadata });
        await env.R2_BUCKET.delete(sourcePath);
        await env.DB.prepare('UPDATE items SET path = ?, name = ? WHERE path = ?').bind(newPath, name, sourcePath).run();
        return jsonResponse({ success: true, path: newPath, type: 'file' });
    }

    const oldDir = normalizeDbDirPath(sourcePath);
    const parent = normalizeParent(item.parent);
    const newDir = parent === '/' ? `/${name}` : `${parent}/${name}`;
    if (oldDir === newDir) return jsonResponse({ success: true, path: newDir, type: 'dir' });
    const existing = await env.DB.prepare('SELECT 1 as x FROM items WHERE path = ? LIMIT 1').bind(newDir).first();
    if (existing) return jsonResponse({ error: '同名文件夹已存在' }, 409);

    const oldPrefix = oldDir === '/' ? '' : oldDir.slice(1);
    const newPrefix = newDir === '/' ? '' : newDir.slice(1);

    const dirRows = await env.DB.prepare(
        `SELECT path FROM items WHERE type = 'dir' AND (path = ? OR path LIKE ?)`
    ).bind(oldDir, `${oldDir}/%`).all();
    const fileRows = oldPrefix
        ? await env.DB.prepare(`SELECT path FROM items WHERE type = 'file' AND path LIKE ?`).bind(`${oldPrefix}/%`).all()
        : { results: [] };

    for (const row of fileRows.results) {
        const relative = row.path.slice(oldPrefix.length + 1);
        const newPath = `${newPrefix}/${relative}`;
        const obj = await env.R2_BUCKET.get(row.path);
        if (obj) {
            await env.R2_BUCKET.put(newPath, obj.body, { httpMetadata: obj.httpMetadata });
            await env.R2_BUCKET.delete(row.path);
        }
        const fileParent = normalizeParent('/' + newPath.split('/').slice(0, -1).join('/'));
        await env.DB.prepare('UPDATE items SET path = ?, parent = ? WHERE path = ?')
            .bind(newPath, fileParent, row.path).run();
    }

    const sortedDirs = dirRows.results.sort((a, b) => b.path.length - a.path.length);
    for (const row of sortedDirs) {
        const newPath = row.path === oldDir ? newDir : `${newDir}${row.path.slice(oldDir.length)}`;
        const dirName = newPath.split('/').pop();
        const dirParent = normalizeParent(newPath.substring(0, newPath.lastIndexOf('/')) || '/');
        await env.DB.prepare('UPDATE items SET path = ?, name = ?, parent = ? WHERE path = ?')
            .bind(newPath, dirName, dirParent, row.path).run();
        try {
            const oldMarker = buildFolderMarkerKey(row.path);
            const newMarker = buildFolderMarkerKey(newPath);
            const marker = await env.R2_BUCKET.get(oldMarker);
            if (marker) {
                await env.R2_BUCKET.put(newMarker, marker.body, { httpMetadata: marker.httpMetadata });
                await env.R2_BUCKET.delete(oldMarker);
            }
        } catch { /* marker may not exist */ }
    }

    return jsonResponse({ success: true, path: newDir, type: 'dir' });
}

async function handleDelete(request, user, env) {
    const { path: targetPath } = await request.json();
    const allowed = await canUserDeletePath(user, targetPath, env);
    if (!allowed.ok) return jsonResponse({ error: allowed.error }, allowed.error === 'Not found' ? 404 : 403);
    const item = await env.DB.prepare('SELECT type FROM items WHERE path = ?').bind(targetPath).first();
    if (!item) return jsonResponse({ error: 'Not found' }, 404);
    if (item.type === 'file') {
        await env.R2_BUCKET.delete(targetPath);
        await env.DB.prepare('DELETE FROM items WHERE path = ?').bind(targetPath).run();
    } else {
        const children = await env.DB.prepare('SELECT path, type FROM items WHERE path LIKE ?').bind(targetPath + '%').all();
        for (const child of children.results) {
            if (child.type === 'file') await env.R2_BUCKET.delete(child.path);
            await env.DB.prepare('DELETE FROM items WHERE path = ?').bind(child.path).run();
        }
        try {
            await env.R2_BUCKET.delete(buildFolderMarkerKey(targetPath));
        } catch { /* marker may not exist */ }
    }
    return jsonResponse({ success: true });
}

async function getStats(env) {
    const [folderCount, fileCount, totalSize] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as cnt FROM items WHERE type="dir"').first(),
        env.DB.prepare('SELECT COUNT(*) as cnt FROM items WHERE type="file"').first(),
        env.DB.prepare('SELECT SUM(size) as total FROM items WHERE type="file"').first()
    ]);
    return { folderCount: folderCount.cnt, fileCount: fileCount.cnt, totalSize: totalSize.total || 0 };
}
