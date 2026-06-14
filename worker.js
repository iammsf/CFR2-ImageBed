// ==================== worker.js ====================
// 绑定资源：R2_BUCKET / DB / ASSETS
// 性能优化：JWT 免 D1 验签、Settings/Install 边缘缓存、合并 API、并行 D1

const CACHE_SETTINGS = 'https://imgbed.internal/settings';
const CACHE_INSTALL = 'https://imgbed.internal/install-status';
const CACHE_FILES_GEN = 'https://imgbed.internal/files-gen';
const FILE_LIST_COLUMNS = 'path, name, parent, type, size, mime, uploaded_at';

let jwtVerifyKeyPromise = null;
let jwtVerifyKeySecret = null;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (path.startsWith('/api/')) {
            return handleApi(request, path.slice(5), env, ctx);
        }

        const objectKey = path.slice(1);
        if (objectKey && !objectKey.includes('..')) {
            const obj = await env.R2_BUCKET.get(objectKey);
            if (obj) {
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
                headers.set('Cache-Control', 'public, max-age=31536000, immutable');
                return new Response(obj.body, { headers });
            }
        }

        return new Response('Not Found', { status: 404 });
    }
};

// ------------------- API 处理 -------------------
async function handleApi(request, action, env, ctx) {
    try {
        return await handleApiInner(request, action, env, ctx);
    } catch (err) {
        console.error('handleApi error', action, err);
        return jsonResponse({ error: 'Internal error' }, 500);
    }
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
        await env.DB.prepare('INSERT INTO users (username, password_hash, nickname, role, perm_upload, perm_view) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(username, passwordHash, nickname || username, 'admin', 1, 1).run();
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .bind('r2_public_url', JSON.stringify({ value: r2PublicUrl })).run();
        await invalidateCache(CACHE_SETTINGS, CACHE_INSTALL);
        return jsonResponse({ success: true });
    }

    if (action === 'login') {
        if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
        const { username, password } = await parseJsonBody(request);
        if (!username || !password) return jsonResponse({ error: 'Invalid credentials' }, 401);
        const userRecord = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
        if (!userRecord || !(await verifyPassword(password, userRecord.password_hash))) {
            return jsonResponse({ error: 'Invalid credentials' }, 401);
        }
        const userPayload = buildUserFromRecord(userRecord);
        const jwt = await generateToken({
            userId: userPayload.id,
            username: userPayload.username,
            nickname: userPayload.nickname,
            role: userPayload.role,
            perm_upload: userPayload.perm_upload,
            perm_view: userPayload.perm_view
        }, env);
        return new Response(JSON.stringify({ success: true, user: userPayload }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': buildAuthCookie(jwt, request)
            }
        });
    }

    const token = getTokenFromCookie(request);
    const user = token ? await verifyToken(token, env) : null;
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    switch (action) {
        case 'bootstrap':
            if (method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            return handleBootstrap(url, user, env, ctx);
        case 'manage-panel':
            if (method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            if (user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
            return handleManagePanel(env, ctx);
        case 'logout':
            return new Response(null, { status: 204, headers: { 'Set-Cookie': 'token=; Path=/; Max-Age=0' } });
        case 'user/profile':
            if (method === 'GET') return jsonResponse(buildUserFromRecord(user));
            if (method === 'PUT') return handleProfileUpdate(request, user, env);
            break;
        case 'users':
            if (user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
            if (method === 'GET') {
                const users = await env.DB.prepare('SELECT id, username, nickname, role, perm_upload, perm_view, created_at FROM users').all();
                return jsonResponse(users.results.map(buildUserFromRecord));
            }
            if (method === 'POST') {
                const { username, password, nickname, role } = await request.json();
                const hash = await hashPassword(password);
                const roleVal = role || 'guest';
                const isAdmin = roleVal === 'admin';
                await env.DB.prepare('INSERT INTO users (username, password_hash, nickname, role, perm_upload, perm_view) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(username, hash, nickname || username, roleVal, isAdmin ? 1 : 0, 1).run();
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
            if (method === 'PUT' && user.role === 'admin') {
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
            return jsonResponse(await listFilesCached(parent, env, ctx));
        }
        case 'folders':
            if (method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
            if (!hasViewPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return jsonResponse(await listAllFoldersCached(env, ctx));
        case 'refresh-index':
            if (user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);
            await syncR2ToDB(env);
            await invalidateFilesIndexCache();
            return jsonResponse({ success: true });
        case 'upload':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleUpload(request, user, env, ctx);
        case 'mkdir': {
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            const { path: folderPath } = await parseJsonBody(request);
            if (!folderPath) return jsonResponse({ error: 'Invalid path' }, 400);
            await createFolder(folderPath, user.id, env);
            await invalidateFilesIndexCache();
            return jsonResponse({ success: true });
        }
        case 'move':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleMove(request, user, env);
        case 'copy':
            if (!hasUploadPermission(user)) return jsonResponse({ error: 'Forbidden' }, 403);
            return await handleCopy(request, user, env);
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
    const [settings, files] = await Promise.all([
        getSettings(env, ctx),
        listFilesCached(parent, env, ctx)
    ]);
    return jsonResponse({ user: buildUserFromRecord(user), settings, files });
}

async function handleManagePanel(env, ctx) {
    const [settings, stats, usersResult] = await Promise.all([
        getSettings(env, ctx),
        getStats(env),
        env.DB.prepare('SELECT id, username, nickname, role, perm_upload, perm_view, created_at FROM users').all()
    ]);
    return jsonResponse({ settings, stats, users: usersResult.results.map(buildUserFromRecord) });
}

async function handleUserPermissionsUpdate(request, env) {
    const { id, perm_upload, perm_view } = await request.json();
    if (!id) return jsonResponse({ error: 'Missing id' }, 400);
    const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
    if (!target) return jsonResponse({ error: 'Not found' }, 404);
    if (target.role === 'admin') return jsonResponse({ error: 'Cannot modify admin permissions' }, 400);
    const uploadVal = perm_upload ? 1 : 0;
    const viewVal = perm_view ? 1 : 0;
    await env.DB.prepare('UPDATE users SET perm_upload = ?, perm_view = ? WHERE id = ?')
        .bind(uploadVal, viewVal, id).run();
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
        perm_view: updatedUser.perm_view
    }, env);
    return new Response(JSON.stringify({ success: true, user: updatedUser }), {
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

async function getFilesCacheGeneration() {
    const res = await caches.default.match(CACHE_FILES_GEN);
    return res ? await res.text() : '0';
}

async function bumpFilesCacheGeneration() {
    await caches.default.put(CACHE_FILES_GEN, new Response(String(Date.now()), {
        headers: { 'Cache-Control': 'no-store' }
    }));
}

function filesCacheKey(parent, gen) {
    return `https://imgbed.internal/files/${gen}/${encodeURIComponent(parent)}`;
}

function foldersCacheKey(gen) {
    return `https://imgbed.internal/folders/${gen}`;
}

async function listFilesCached(parent, env, ctx) {
    const gen = await getFilesCacheGeneration();
    const key = filesCacheKey(parent, gen);
    const cached = await readCache(key);
    if (cached) return cached;

    const data = await listFiles(parent, env);
    if (ctx) ctx.waitUntil(writeCache(key, data, 120));
    return data;
}

async function listAllFoldersCached(env, ctx) {
    const gen = await getFilesCacheGeneration();
    const key = foldersCacheKey(gen);
    const cached = await readCache(key);
    if (cached) return cached;

    const data = await listAllFolders(env);
    if (ctx) ctx.waitUntil(writeCache(key, data, 120));
    return data;
}

async function invalidateFilesIndexCache() {
    await bumpFilesCacheGeneration();
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

        if (payload.username) {
            return buildUserFromRecord({
                id: payload.userId,
                username: payload.username,
                nickname: payload.nickname,
                role: payload.role,
                perm_upload: payload.perm_upload,
                perm_view: payload.perm_view
            });
        }
        // 兼容旧版 token（仅含 userId），命中后请重新登录以获取免 D1 新 token
        const userRecord = await env.DB.prepare('SELECT id, username, nickname, role, perm_upload, perm_view FROM users WHERE id = ?').bind(payload.userId).first();
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
        perm_view: isAdmin ? 1 : Number(userRecord.perm_view ?? 1)
    };
}

function hasUploadPermission(user) {
    return user.role === 'admin' || Number(user.perm_upload) === 1;
}

function hasViewPermission(user) {
    return user.role === 'admin' || Number(user.perm_view) === 1;
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
            r2_public_url: settings.r2_public_url || ''
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
            r2_public_url: ''
        };
    }
}

// ------------------- R2 同步 -------------------
async function syncR2ToDB(env) {
    let cursor;
    const allObjects = [];
    do {
        const list = await env.R2_BUCKET.list({ cursor });
        allObjects.push(...list.objects);
        cursor = list.cursor;
    } while (cursor);

    // 全量重建：旧版只删 file 不删 dir，会导致 R2 已删的文件夹仍残留在 D1
    await env.DB.prepare('DELETE FROM items').run();

    for (const obj of allObjects) {
        const key = obj.key;
        if (!key || key.endsWith('/.folder') || key === '.folder') {
            const dirPath = markerKeyToDirPath(key);
            if (dirPath && dirPath !== '/') await ensureDirPath(dirPath, env);
            continue;
        }

        const parts = key.split('/');
        const fileName = parts.pop();
        if (!fileName || fileName === '.folder') continue;

        const parent = parts.length ? normalizeParent('/' + parts.join('/')) : '/';
        await ensureDirPath(parent, env);
        const mime = obj.httpMetadata?.contentType || guessMimeFromName(fileName) || 'application/octet-stream';
        await env.DB.prepare('INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, etag, last_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(key, fileName, parent, 'file', obj.size, mime, obj.etag, obj.uploaded.getTime()).run();
    }
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
    for (let i = 0; i < parts.length; i++) {
        current += '/' + parts[i];
        const parent = current.substring(0, current.lastIndexOf('/')) || '/';
        const exists = await env.DB.prepare('SELECT 1 as x FROM items WHERE path = ? LIMIT 1').bind(current).first();
        if (!exists) {
            await env.DB.prepare('INSERT INTO items (path, name, parent, type, uploaded_by) VALUES (?, ?, ?, ?, ?)')
                .bind(current, parts[i], parent, 'dir', userId).run();
        }
    }
    await env.R2_BUCKET.put(buildFolderMarkerKey(normalized), '', { httpMetadata: { contentType: 'application/x-directory' } });
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
        const key = buildObjectKey(targetDir, file.name);
        const mime = file.type || guessMimeFromName(file.name) || 'application/octet-stream';
        try {
            await env.R2_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: mime } });
            await env.DB.prepare('INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(key, file.name, targetDir, 'file', file.size, mime, user.id, Date.now()).run();
            const publicUrl = settings.r2_public_url ? `${settings.r2_public_url}/${key}` : `${origin}/${key}`;
            results.push({ name: file.name, success: true, url: publicUrl });
        } catch (err) {
            results.push({ name: file.name, error: err.message });
        }
    }
    await invalidateFilesIndexCache();
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
        await env.DB.prepare('INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(newPath, item.name, destDir, 'file', item.size, item.mime, user.id, item.uploaded_at || Date.now()).run();
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
    await invalidateFilesIndexCache();
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
            await env.DB.prepare('INSERT OR REPLACE INTO items (path, name, parent, type, size, mime, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .bind(newPath, item.name, destDir, 'file', item.size, item.mime, user.id).run();
        }
    } else {
        const children = await env.DB.prepare(`SELECT ${FILE_LIST_COLUMNS} FROM items WHERE path LIKE ?`).bind(sourcePath + '%').all();
        for (const child of children.results) {
            const relative = child.path.slice(sourcePath.length).replace(/^\//, '');
            const newPath = buildObjectKey(destDir, relative);
            const obj = await env.R2_BUCKET.get(child.path);
            if (obj) {
                await env.R2_BUCKET.put(newPath, obj.body, { httpMetadata: obj.httpMetadata });
                await env.DB.prepare('INSERT INTO items (path, name, parent, type, size, mime, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .bind(newPath, child.name, normalizeParent(newPath.includes('/') ? '/' + newPath.split('/').slice(0, -1).join('/') : '/'), child.type, child.size, child.mime, user.id).run();
            }
        }
    }
    await invalidateFilesIndexCache();
    return jsonResponse({ success: true });
}

async function handleDelete(request, user, env) {
    const { path: targetPath } = await request.json();
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
    await invalidateFilesIndexCache();
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
