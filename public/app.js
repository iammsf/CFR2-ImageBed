// app.js - 完整前端逻辑（含所有上传方式）
const API_BASE = '/api';
const AUTH_TOKEN_KEY = 'imgbed_auth_token';
let authToken = null;
let currentUser = null;
let currentPath = '/';
let fileList = [];
let galleryListPath = null;
let selectedItem = null;
let contextMenuVisible = false;
let currentSettings = {};
let sortField = 'name';
let sortDirection = 'asc';
let batchMode = false;
const batchSelected = new Map();
const filesListCache = new Map();
const filesListInflight = new Map();
const filesListSeq = new Map();
let previewImageObserver = null;
const FILES_CACHE_TTL = 60_000;
let uploadInProgress = false;

// ------------------- UI 弹窗组件 -------------------
const UI_ICON = { info: 'info', success: 'check_circle', error: 'error', warning: 'warning' };

function ensureToastStack() {
    let stack = document.getElementById('ui-toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'ui-toast-stack';
        stack.className = 'ui-toast-stack';
        document.body.appendChild(stack);
    }
    return stack;
}

function uiToast(message, type = 'info', duration = 2800) {
    const stack = ensureToastStack();
    const toast = document.createElement('div');
    toast.className = `ui-toast ui-toast--${type}`;
    toast.innerHTML = `<span class="icon ui-toast__icon">${UI_ICON[type] || UI_ICON.info}</span><span class="ui-toast__text">${escapeHtml(String(message))}</span>`;
    stack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    setTimeout(() => {
        toast.classList.remove('is-visible');
        toast.classList.add('is-leaving');
        setTimeout(() => toast.remove(), 280);
    }, duration);
}

function uiDialog(options = {}) {
    const {
        title = '提示',
        message = '',
        type = 'info',
        confirmText = '确定',
        cancelText = null,
        input = false,
        inputType = 'text',
        defaultValue = '',
        placeholder = '',
        danger = false,
        selectOnFocus = true
    } = options;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'ui-dialog-overlay';
        const inputBlock = input
            ? `<div class="form-group"><input type="${inputType === 'password' ? 'password' : 'text'}" class="ui-dialog-input" placeholder="${escapeHtml(placeholder)}"></div>`
            : '';

        overlay.innerHTML = `
            <div class="ui-dialog" role="dialog" aria-modal="true">
                <div class="ui-dialog__header">
                    <span class="icon ui-dialog__icon ui-dialog__icon--${type}">${UI_ICON[type] || UI_ICON.info}</span>
                    <div class="ui-dialog__title">${escapeHtml(title)}</div>
                </div>
                <div class="ui-dialog__body">${message ? `<p>${escapeHtml(String(message))}</p>` : ''}${inputBlock}</div>
                <div class="ui-dialog__footer">
                    ${cancelText ? `<button type="button" class="btn btn-outlined ui-dialog-cancel">${escapeHtml(cancelText)}</button>` : ''}
                    <button type="button" class="btn btn-filled ui-dialog-confirm${danger ? ' ui-dialog-confirm--danger' : ''}">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('is-active'));

        const inputEl = overlay.querySelector('.ui-dialog-input');
        if (inputEl) {
            inputEl.value = defaultValue != null ? String(defaultValue) : '';
            inputEl.focus();
            if (selectOnFocus) inputEl.select();
        } else {
            overlay.querySelector('.ui-dialog-confirm')?.focus();
        }

        let settled = false;
        const close = (value) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKeydown);
            overlay.classList.remove('is-active');
            setTimeout(() => overlay.remove(), 250);
            resolve(value);
        };

        overlay.querySelector('.ui-dialog-confirm').onclick = () => {
            close(inputEl ? inputEl.value.trim() : true);
        };
        overlay.querySelector('.ui-dialog-cancel')?.addEventListener('click', () => {
            close(inputEl ? null : false);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(inputEl ? null : false);
        });

        const onKeydown = (e) => {
            if (e.key === 'Escape') close(inputEl ? null : false);
            if (e.key === 'Enter' && document.activeElement === inputEl) {
                e.preventDefault();
                close(inputEl.value.trim());
            }
        };
        document.addEventListener('keydown', onKeydown);
    });
}

function uiAlert(message, type = 'info') {
    if (type === 'error') {
        return uiDialog({ title: '出错了', message, type: 'error', confirmText: '知道了' });
    }
    uiToast(message, type === 'success' ? 'success' : 'info');
    return Promise.resolve();
}

function uiConfirm(message, options = {}) {
    return uiDialog({
        title: options.title || '确认操作',
        message,
        type: options.danger ? 'warning' : 'info',
        confirmText: options.confirmText || '确定',
        cancelText: options.cancelText || '取消',
        danger: !!options.danger
    }).then((v) => v === true);
}

function uiPrompt(title, options = {}) {
    return uiDialog({
        title,
        message: options.message || '',
        type: 'info',
        input: true,
        inputType: options.inputType || 'text',
        defaultValue: options.defaultValue || '',
        placeholder: options.placeholder || '',
        confirmText: options.confirmText || '确定',
        cancelText: options.cancelText || '取消',
        selectOnFocus: options.selectOnFocus !== false
    });
}

let loadingDepth = 0;
let loadingOverlay = null;

function onLoadingBlockEvent(e) {
    e.preventDefault();
    e.stopPropagation();
}

function uiLoadingShow(message = '更新中，请稍候') {
    loadingDepth++;
    if (!loadingOverlay) {
        loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'ui-loading-overlay';
        loadingOverlay.setAttribute('role', 'alert');
        loadingOverlay.setAttribute('aria-live', 'polite');
        loadingOverlay.innerHTML = `
            <div class="ui-loading-panel">
                <div class="ui-loading-spinner" aria-hidden="true"></div>
                <div class="ui-loading-text"></div>
            </div>
        `;
        ['wheel', 'touchmove', 'click', 'contextmenu'].forEach((evt) => {
            loadingOverlay.addEventListener(evt, onLoadingBlockEvent, { passive: false });
        });
        document.addEventListener('keydown', onLoadingBlockEvent, true);
        document.body.appendChild(loadingOverlay);
        document.body.classList.add('ui-loading-active');
        requestAnimationFrame(() => loadingOverlay.classList.add('is-active'));
    }
    loadingOverlay.querySelector('.ui-loading-text').textContent = message;
}

function uiLoadingHide() {
    if (loadingDepth <= 0) return;
    loadingDepth--;
    if (loadingDepth > 0 || !loadingOverlay) return;
    loadingOverlay.classList.remove('is-active');
    const el = loadingOverlay;
    loadingOverlay = null;
    document.removeEventListener('keydown', onLoadingBlockEvent, true);
    setTimeout(() => {
        el.remove();
        if (loadingDepth === 0) document.body.classList.remove('ui-loading-active');
    }, 250);
}

async function runWithLoading(message, fn) {
    uiLoadingShow(message);
    try {
        return await fn();
    } finally {
        uiLoadingHide();
    }
}

function loadStoredAuthToken() {
    try {
        authToken = sessionStorage.getItem(AUTH_TOKEN_KEY) || null;
    } catch {
        authToken = null;
    }
}

function setAuthToken(token) {
    authToken = token || null;
    try {
        if (authToken) sessionStorage.setItem(AUTH_TOKEN_KEY, authToken);
        else sessionStorage.removeItem(AUTH_TOKEN_KEY);
    } catch { /* ignore */ }
}

function clearAuthToken() {
    setAuthToken(null);
}

function applyAuthHeaders(headers = {}) {
    const h = headers instanceof Headers ? headers : new Headers(headers);
    if (authToken && !h.has('Authorization')) {
        h.set('Authorization', `Bearer ${authToken}`);
    }
    return h;
}

async function apiFetch(url, options = {}, allowAuthRetry = true) {
    const res = await fetch(url, {
        ...options,
        credentials: 'same-origin',
        headers: applyAuthHeaders(options.headers)
    });
    // 过期 Bearer 会盖过仍有效的 Cookie，401 时清 token 重试一次
    if (allowAuthRetry && res.status === 401 && authToken) {
        clearAuthToken();
        return apiFetch(url, options, false);
    }
    return res;
}

function hasUploadPerm() {
    return currentUser && (currentUser.role === 'admin' || Number(currentUser.perm_upload ?? 0) === 1);
}

function hasViewPerm() {
    if (!currentUser) return false;
    if (currentUser.role === 'admin') return true;
    // 与后端 buildUserFromRecord 一致：未设置时默认允许查看
    return Number(currentUser.perm_view ?? 1) === 1;
}

function hasManagePerm() {
    return currentUser && (currentUser.role === 'admin' || Number(currentUser.perm_manage ?? 0) === 1);
}

function canDeleteItem(item) {
    if (!hasUploadPerm()) return false;
    if (hasManagePerm()) return true;
    if (!item || !currentUser) return false;
    if (item.type === 'dir') return true;
    return item.uploaded_by != null && Number(item.uploaded_by) === Number(currentUser.id);
}

function normalizeCurrentPath(path) {
    if (path == null || path === '' || path === 'undefined' || path === 'null') return '/';
    let p = String(path).trim().replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/').replace(/\/$/, '');
    return p || '/';
}

function getSavedGalleryPath() {
    const raw = location.hash.slice(1);
    if (!raw) return '/';
    try {
        const decoded = decodeURIComponent(raw);
        return normalizeCurrentPath(decoded.startsWith('/') ? decoded : `/${decoded}`);
    } catch {
        return normalizeCurrentPath(raw.startsWith('/') ? raw : `/${raw}`);
    }
}

function syncGalleryPathToUrl(path) {
    const normalized = normalizeCurrentPath(path);
    const hash = normalized === '/' ? '' : `#${encodeURI(normalized)}`;
    const next = `${location.pathname}${location.search}${hash}`;
    const current = `${location.pathname}${location.search}${location.hash}`;
    if (current !== next) history.replaceState(null, '', next);
}

let galleryHashListenerBound = false;

function bindGalleryHashListener() {
    if (galleryHashListenerBound) return;
    galleryHashListenerBound = true;
    window.addEventListener('hashchange', () => {
        if (!currentUser || !document.getElementById('file-grid')) return;
        const path = getSavedGalleryPath();
        if (path !== normalizeCurrentPath(currentPath)) loadFiles(path);
    });
}

function renderPermBadges(user, disabled = true) {
    const dis = disabled ? ' disabled' : '';
    const uploadChecked = Number(user.perm_upload) === 1 ? ' checked' : '';
    const viewChecked = Number(user.perm_view) === 1 ? ' checked' : '';
    const manageChecked = Number(user.perm_manage) === 1 ? ' checked' : '';
    return `<label class="perm-badge"><input type="checkbox"${dis}${viewChecked}><span>查看</span></label>
        <label class="perm-badge"><input type="checkbox"${dis}${uploadChecked}><span>上传</span></label>
        <label class="perm-badge"><input type="checkbox"${dis}${manageChecked}><span>管理</span></label>`;
}

function showEditPermissionsDialog(user) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'ui-dialog-overlay';
        overlay.innerHTML = `
            <div class="ui-dialog" role="dialog" aria-modal="true">
                <div class="ui-dialog__header">
                    <span class="icon ui-dialog__icon ui-dialog__icon--info">manage_accounts</span>
                    <div class="ui-dialog__title">更改权限</div>
                </div>
                <div class="ui-dialog__body">
                    <p>用户：${escapeHtml(user.username)}</p>
                    <div class="perm-edit-group">
                        <label class="perm-badge perm-badge--editable"><input type="checkbox" id="perm-view-edit"${Number(user.perm_view) === 1 ? ' checked' : ''}><span>查看</span></label>
                        <label class="perm-badge perm-badge--editable"><input type="checkbox" id="perm-upload-edit"${Number(user.perm_upload) === 1 ? ' checked' : ''}><span>上传</span></label>
                        <label class="perm-badge perm-badge--editable"><input type="checkbox" id="perm-manage-edit"${Number(user.perm_manage) === 1 ? ' checked' : ''}><span>管理</span></label>
                    </div>
                </div>
                <div class="ui-dialog__footer">
                    <button type="button" class="btn btn-outlined ui-dialog-cancel">取消</button>
                    <button type="button" class="btn btn-filled ui-dialog-confirm">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('is-active'));

        let settled = false;
        const close = (value) => {
            if (settled) return;
            settled = true;
            overlay.classList.remove('is-active');
            setTimeout(() => overlay.remove(), 250);
            resolve(value);
        };

        overlay.querySelector('.ui-dialog-cancel').onclick = () => close(null);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        overlay.querySelector('.ui-dialog-confirm').onclick = () => {
            close({
                perm_view: overlay.querySelector('#perm-view-edit').checked,
                perm_upload: overlay.querySelector('#perm-upload-edit').checked,
                perm_manage: overlay.querySelector('#perm-manage-edit').checked
            });
        };
    });
}

function getItemParentPath(itemPath, itemType) {
    if (itemType === 'dir') return normalizeCurrentPath(itemPath);
    const p = String(itemPath || '').replace(/\\/g, '/');
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    const parent = '/' + p.slice(0, idx);
    return normalizeCurrentPath(parent);
}

function isFolderPickerTargetDisabled(sourcePath, sourceType, targetPath) {
    const target = normalizeCurrentPath(targetPath);
    if (sourceType === 'file') {
        return getItemParentPath(sourcePath, 'file') === target;
    }
    const src = normalizeCurrentPath(sourcePath);
    if (src === target) return true;
    return target.startsWith(src + '/');
}

function buildFolderTree(folders) {
    const root = { path: '/', name: '根目录', children: [] };
    const map = { '/': root };
    const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));
    for (const folder of sorted) {
        const path = normalizeCurrentPath(folder.path);
        if (path === '/') continue;
        const node = { path, name: folder.name || path.split('/').pop(), children: [] };
        map[path] = node;
        const parent = normalizeCurrentPath(folder.parent || '/');
        (map[parent] || root).children.push(node);
    }
    for (const node of Object.values(map)) {
        node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }
    return root;
}

function renderFolderTreeNode(node, depth, state) {
    const hasChildren = node.children.length > 0;
    const expanded = state.expanded.has(node.path);
    const selected = state.selected === node.path;
    const disabled = isFolderPickerTargetDisabled(state.sourcePath, state.sourceType, node.path);
    const indent = depth * 18;
    let html = `
        <div class="folder-tree-node${expanded ? ' is-expanded' : ''}${disabled ? ' is-disabled' : ''}" data-path="${escapeHtml(node.path)}">
            <div class="folder-tree-row${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}" data-path="${escapeHtml(node.path)}" style="padding-left:${12 + indent}px">
                <button type="button" class="folder-tree-toggle${hasChildren ? '' : ' is-empty'}" aria-label="${expanded ? '收起' : '展开'}" ${hasChildren ? '' : 'tabindex="-1"'}>
                    <span class="icon">${hasChildren ? (expanded ? 'expand_more' : 'chevron_right') : ''}</span>
                </button>
                <span class="icon folder-tree-icon">folder</span>
                <span class="folder-tree-label">${escapeHtml(node.name)}</span>
            </div>`;
    if (hasChildren) {
        html += `<div class="folder-tree-children"${expanded ? '' : ' hidden'}>`;
        for (const child of node.children) {
            html += renderFolderTreeNode(child, depth + 1, state);
        }
        html += '</div>';
    }
    html += '</div>';
    return html;
}

function expandPathToRoot(path, expandedSet) {
    const normalized = normalizeCurrentPath(path);
    expandedSet.add('/');
    if (normalized === '/') return;
    const parts = normalized.split('/').filter(Boolean);
    let accum = '';
    for (const part of parts) {
        accum += '/' + part;
        expandedSet.add(accum);
    }
}

async function showFolderPicker(options = {}) {
    const {
        title = '选择目标文件夹',
        icon = 'folder_open',
        confirmText = '确定',
        sourcePath = '',
        sourceType = 'file',
        defaultPath = '/',
        showOverwrite = true
    } = options;

    let folders;
    try {
        const res = await apiFetch(`${API_BASE}/folders`);
        if (!res.ok) throw new Error('load failed');
        folders = await res.json();
    } catch {
        uiToast('加载文件夹失败', 'error');
        return null;
    }

    const tree = buildFolderTree(folders);
    const initialPath = normalizeCurrentPath(defaultPath);
    const state = {
        selected: initialPath,
        expanded: new Set(['/']),
        sourcePath,
        sourceType
    };
    expandPathToRoot(initialPath, state.expanded);

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'ui-dialog-overlay';
        overlay.innerHTML = `
            <div class="ui-dialog ui-dialog--folder-picker" role="dialog" aria-modal="true">
                <div class="ui-dialog__header">
                    <span class="icon ui-dialog__icon ui-dialog__icon--info">${icon}</span>
                    <div class="ui-dialog__title">${escapeHtml(title)}</div>
                </div>
                <div class="folder-tree-panel">
                    <div class="folder-tree"></div>
                </div>
                ${showOverwrite ? `<div class="folder-picker-options">
                    <label class="perm-badge perm-badge--editable">
                        <input type="checkbox" class="folder-picker-overwrite"><span>覆盖现有文件</span>
                    </label>
                </div>` : ''}
                <div class="ui-dialog__footer">
                    <button type="button" class="btn btn-outlined ui-dialog-cancel">取消</button>
                    <button type="button" class="btn btn-filled ui-dialog-confirm">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('is-active'));

        const treeEl = overlay.querySelector('.folder-tree');
        const paintTree = () => {
            treeEl.innerHTML = renderFolderTreeNode(tree, 0, state);
            bindTreeEvents();
        };

        const bindTreeEvents = () => {
            treeEl.querySelectorAll('.folder-tree-toggle:not(.is-empty)').forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const path = btn.closest('.folder-tree-node')?.dataset.path;
                    if (!path) return;
                    if (state.expanded.has(path)) state.expanded.delete(path);
                    else state.expanded.add(path);
                    paintTree();
                };
            });
            treeEl.querySelectorAll('.folder-tree-row:not(.is-disabled)').forEach(row => {
                row.onclick = () => {
                    state.selected = row.dataset.path;
                    paintTree();
                };
            });
        };

        paintTree();

        let settled = false;
        const close = (value) => {
            if (settled) return;
            settled = true;
            overlay.classList.remove('is-active');
            setTimeout(() => overlay.remove(), 250);
            resolve(value);
        };

        overlay.querySelector('.ui-dialog-cancel').onclick = () => close(null);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        overlay.querySelector('.ui-dialog-confirm').onclick = () => {
            if (isFolderPickerTargetDisabled(sourcePath, sourceType, state.selected)) {
                uiToast('不能移动到当前位置', 'error');
                return;
            }
            close({
                targetDir: state.selected,
                overwrite: showOverwrite ? overlay.querySelector('.folder-picker-overwrite')?.checked : false
            });
        };
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    loadStoredAuthToken();
    await checkInstallAndRender();
});

// ------------------- 安装/登录/初始化 -------------------
async function checkInstallAndRender() {
    const res = await apiFetch(`${API_BASE}/install-check`);
    const data = await res.json();
    if (data.needInstall) {
        renderInstallPage();
        return;
    }
    const startPath = getSavedGalleryPath();
    const boot = await fetchBootstrap(startPath);
    if (boot?.user) {
        currentUser = boot.user;
        applySettings(boot.settings);
        renderGalleryPage(boot.files, startPath);
    } else {
        renderLoginPage();
    }
}

async function fetchBootstrap(parent = '/') {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await apiFetch(`${API_BASE}/bootstrap?parent=${encodeURIComponent(parent)}`, {}, attempt === 0);
            if (res.ok) return await res.json();
            if (res.status !== 401 || attempt > 0) return null;
            clearAuthToken();
        } catch {
            if (attempt > 0) return null;
        }
    }
    return null;
}

let footerResizeObserver = null;
let footerMutationObserver = null;
let footerLayoutEventsBound = false;

function isFooterVisible(footer) {
    return footer && !footer.classList.contains('is-hidden');
}

function measureFooterHeight(footer) {
    if (!footer || !isFooterVisible(footer)) return 0;
    return Math.ceil(footer.getBoundingClientRect().height);
}

function updateFooterSpacerHeight() {
    const footer = document.getElementById('site-footer');
    const spacer = document.getElementById('site-footer-spacer');
    if (!footer || !spacer) return;

    const height = measureFooterHeight(footer);
    const total = `${height}px`;
    spacer.style.height = total;
    document.documentElement.style.setProperty('--footer-height', total);
}

function observeFooterAssets(footer) {
    footer.querySelectorAll('img').forEach((img) => {
        if (img.complete) return;
        img.addEventListener('load', updateFooterSpacerHeight, { once: true });
        img.addEventListener('error', updateFooterSpacerHeight, { once: true });
    });
}

function bindFooterObservers(footer) {
    if (footerResizeObserver) footerResizeObserver.disconnect();
    if (footerMutationObserver) footerMutationObserver.disconnect();

    if (!isFooterVisible(footer)) return;

    if (typeof ResizeObserver !== 'undefined') {
        footerResizeObserver = new ResizeObserver(updateFooterSpacerHeight);
        footerResizeObserver.observe(footer);
        const content = footer.querySelector('.site-footer__content');
        if (content) footerResizeObserver.observe(content);
    }

    footerMutationObserver = new MutationObserver(() => {
        observeFooterAssets(footer);
        updateFooterSpacerHeight();
    });
    footerMutationObserver.observe(footer, {
        childList: true,
        subtree: true,
        characterData: true
    });

    observeFooterAssets(footer);
}

function syncFooterSpacer() {
    const footer = document.getElementById('site-footer');
    if (!footer) return;

    bindFooterObservers(footer);
    updateFooterSpacerHeight();

    if (!footerLayoutEventsBound) {
        footerLayoutEventsBound = true;
        window.addEventListener('resize', updateFooterSpacerHeight, { passive: true });
        window.visualViewport?.addEventListener('resize', updateFooterSpacerHeight, { passive: true });
        window.visualViewport?.addEventListener('scroll', updateFooterSpacerHeight, { passive: true });
    }

    if (document.fonts?.ready) {
        document.fonts.ready.then(updateFooterSpacerHeight).catch(() => {});
    }

    requestAnimationFrame(() => requestAnimationFrame(updateFooterSpacerHeight));
}

function applySettings(settings) {
    if (!settings) return;
    currentSettings = settings;
    document.title = settings.site_title || '我的图床';
    document.body.style.backgroundImage = settings.site_bg ? `url(${settings.site_bg})` : '';
    const footer = document.getElementById('site-footer');
    if (footer) {
        if (settings.footer_html) {
            footer.innerHTML = `<div class="site-footer__content">${settings.footer_html}</div>`;
            footer.classList.remove('is-hidden');
        } else {
            footer.innerHTML = '';
            footer.classList.add('is-hidden');
        }
    }
    syncFooterSpacer();
}

function getViewportBounds() {
    const margin = 8;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const offsetLeft = viewport?.offsetLeft ?? 0;
    const offsetTop = viewport?.offsetTop ?? 0;

    let maxBottom = offsetTop + viewportHeight - margin;

    const footer = document.getElementById('site-footer');
    if (isFooterVisible(footer)) {
        const rect = footer.getBoundingClientRect();
        if (rect.height > 0) {
            maxBottom = Math.min(maxBottom, rect.top - margin);
        }
    }

    return {
        margin,
        minLeft: offsetLeft + margin,
        minTop: offsetTop + margin,
        maxLeft: offsetLeft + viewportWidth - margin,
        maxBottom
    };
}

function clampContextMenuPosition(menu, x, y) {
    const bounds = getViewportBounds();
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.appendChild(menu);

    const { width, height } = menu.getBoundingClientRect();
    let left = x;
    let top = y;

    if (left + width > bounds.maxLeft) left = bounds.maxLeft - width;
    if (left < bounds.minLeft) left = bounds.minLeft;
    if (top + height > bounds.maxBottom) top = bounds.maxBottom - height;
    if (top < bounds.minTop) top = bounds.minTop;

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
}

function renderInstallPage() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="auth-container">
            <div class="auth-card">
                <div class="auth-header">
                    <div class="auth-title">初始化设置</div>
                    <div class="auth-subtitle">创建您的管理员账号</div>
                </div>
                <div class="auth-form">
                    <div class="form-group"><label>管理员账号</label><input type="text" id="admin-username" placeholder="请输入用户名"></div>
                    <div class="form-group"><label>密码</label><input type="password" id="admin-password" placeholder="请输入密码"></div>
                    <div class="form-group"><label>昵称</label><input type="text" id="admin-nickname" placeholder="请输入昵称"></div>
                    <div class="form-group"><label>R2 公开链接地址</label><input type="text" id="r2-public-url" placeholder="https://your-bucket.r2.dev"></div>
                    <button class="btn btn-filled auth-btn" id="install-btn">初始化</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('install-btn').onclick = async () => {
        const username = document.getElementById('admin-username').value.trim();
        const password = document.getElementById('admin-password').value;
        const nickname = document.getElementById('admin-nickname').value.trim();
        const r2PublicUrl = document.getElementById('r2-public-url').value.trim();
        if (!username || !password) return uiToast('请填写账号和密码', 'error');
        const res = await apiFetch(`${API_BASE}/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, nickname, r2PublicUrl })
        });
        if (res.ok) { uiToast('初始化成功，请登录', 'success'); renderLoginPage(); }
        else { const err = await res.json(); uiToast('初始化失败：' + err.error, 'error'); }
    };
}

function renderLoginPage() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="auth-container">
            <div class="auth-card">
                <div class="auth-header">
                    <div class="auth-title">欢迎回来</div>
                    <div class="auth-subtitle">登录您的图床账号</div>
                </div>
                <form class="auth-form" id="login-form" autocomplete="on">
                    <div class="form-group">
                        <label for="login-username">账号</label>
                        <input type="text" id="login-username" name="username" autocomplete="username" placeholder="请输入用户名" required>
                    </div>
                    <div class="form-group">
                        <label for="login-password">密码</label>
                        <input type="password" id="login-password" name="password" autocomplete="current-password" placeholder="请输入密码" required>
                    </div>
                    <button type="submit" class="btn btn-filled auth-btn" id="login-btn">登录</button>
                </form>
            </div>
        </div>
    `;

    const form = document.getElementById('login-form');
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');

    const focusLoginField = () => {
        if (!usernameInput || !passwordInput) return;
        if (usernameInput.value.trim()) passwordInput.focus();
        else usernameInput.focus();
    };

    const doLogin = async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        if (!username || !password) {
            uiToast('请输入账号和密码', 'warning');
            (username ? passwordInput : usernameInput).focus();
            return;
        }
        await runWithLoading('登录中，请稍候', async () => {
            try {
                const res = await apiFetch(`${API_BASE}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.token) setAuthToken(data.token);
                    currentUser = data.user;
                    const startPath = getSavedGalleryPath();
                    const boot = await fetchBootstrap(startPath);
                    if (boot) {
                        currentUser = boot.user;
                        applySettings(boot.settings);
                        renderGalleryPage(boot.files, startPath);
                    } else if (hasViewPerm()) {
                        await loadSettings();
                        renderGalleryPage(null, startPath);
                    } else {
                        uiToast('您没有查看权限', 'error');
                        currentUser = null;
                        clearAuthToken();
                        await apiFetch(`${API_BASE}/logout`, { method: 'POST' });
                        renderLoginPage();
                    }
                } else {
                    const err = await res.json().catch(() => ({}));
                    uiToast('登录失败' + (err.error ? '：' + err.error : ''), err.banned ? 'warning' : 'error');
                    passwordInput.focus();
                    passwordInput.select();
                }
            } catch {
                uiToast('登录失败，请检查网络后重试', 'error');
                passwordInput.focus();
            }
        });
    };

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        doLogin();
    });

    usernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            passwordInput.focus();
        }
    });

    focusLoginField();
    requestAnimationFrame(focusLoginField);
    setTimeout(focusLoginField, 120);
    setTimeout(focusLoginField, 400);
}

async function loadUser() {
    try {
        const res = await apiFetch(`${API_BASE}/user/profile`);
        if (res.ok) currentUser = await res.json();
        else currentUser = null;
    } catch(e) { currentUser = null; }
}

async function loadSettings() {
    try {
        const res = await apiFetch(`${API_BASE}/settings`);
        if (res.ok) applySettings(await res.json());
    } catch(e) {}
}

// ------------------- 图库页面 -------------------
function isDesktopGalleryInput() {
    return window.matchMedia('(min-width: 769px)').matches;
}

function enterBatchMode(initialPath = null, initialType = null) {
    batchMode = true;
    batchSelected.clear();
    if (initialPath) batchSelected.set(initialPath, initialType);
    updateBatchBar();
    renderFileGrid();
}

function exitBatchMode() {
    batchMode = false;
    batchSelected.clear();
    updateBatchBar();
    renderFileGrid();
}

function toggleBatchSelection(path, type) {
    if (!path) return;
    if (batchSelected.has(path)) batchSelected.delete(path);
    else batchSelected.set(path, type);
    updateBatchBar();
}

function updateBatchBar() {
    const bar = document.getElementById('batch-bar');
    if (!bar) return;
    const count = batchSelected.size;
    bar.classList.toggle('is-hidden', !batchMode);
    document.body.classList.toggle('batch-mode-active', batchMode);
    const countEl = bar.querySelector('.batch-bar__count');
    if (countEl) countEl.textContent = `已选 ${count} 项`;
    bar.querySelectorAll('[data-batch-action]').forEach(btn => {
        if (btn.dataset.batchAction !== 'exit') btn.disabled = count === 0;
    });
    const toggleBtn = document.getElementById('batch-select-btn');
    if (toggleBtn) toggleBtn.classList.toggle('is-active', batchMode);
}

function unbindGalleryContextMenu() {
    if (galleryContextMenuHandler && galleryContextMenuTarget) {
        galleryContextMenuTarget.removeEventListener('contextmenu', galleryContextMenuHandler);
    }
    galleryContextMenuHandler = null;
    galleryContextMenuTarget = null;
    if (previewImageObserver) {
        previewImageObserver.disconnect();
        previewImageObserver = null;
    }
}

function bindGalleryContextMenu() {
    unbindGalleryContextMenu();
    const main = document.querySelector('.gallery-main');
    if (!main) return;

    const handler = (e) => {
        if (e.target.closest('.file-card, .sort-panel, .upload-progress, .context-menu, .file-card-menu')) return;
        e.preventDefault();
        e.stopPropagation();
        window.getSelection()?.removeAllRanges();
        showAreaContextMenu(e.clientX, e.clientY);
    };

    galleryContextMenuHandler = handler;
    galleryContextMenuTarget = main;
    main.addEventListener('contextmenu', handler);
}

let galleryContextMenuHandler = null;
let galleryContextMenuTarget = null;

function renderGalleryPage(initialFiles = null, initialPath = null) {
    batchMode = false;
    batchSelected.clear();
    unbindGalleryContextMenu();
    bindGalleryHashListener();
    const targetPath = normalizeCurrentPath(initialPath ?? currentPath ?? getSavedGalleryPath());
    currentPath = targetPath;
    syncGalleryPathToUrl(targetPath);
    const app = document.getElementById('app');
    const canUpload = hasUploadPerm();
    const canView = hasViewPerm();
    app.innerHTML = `
        <div class="app-bar">
            <div class="breadcrumb" id="breadcrumb"></div>
            <div class="actions">
                <button class="btn btn-text" id="batch-select-btn"><span class="icon">checklist</span> 批量选择</button>
                ${canUpload ? `<button class="btn btn-text" id="upload-btn"><span class="icon">upload</span> 上传</button>
                <button class="btn btn-text" id="new-folder-btn"><span class="icon">create_new_folder</span> 新建文件夹</button>` : ''}
                <button class="btn btn-text" id="refresh-btn"><span class="icon">refresh</span> 刷新</button>
                ${hasManagePerm() ? `<button class="btn btn-text" id="manage-btn"><span class="icon">settings</span> 管理</button>` : ''}
                <button class="btn btn-text" id="logout-btn"><span class="icon">logout</span> 退出</button>
            </div>
        </div>
        <div class="gallery-main">
            <div class="sort-panel">
                <div>排序方式：</div>
                <select id="sort-field" class="sort-select">
                    <option value="name">文件名</option>
                    <option value="uploaded_at">时间</option>
                    <option value="size">文件大小</option>
                </select>
                <select id="sort-direction" class="sort-select">
                    <option value="asc">升序</option>
                    <option value="desc">降序</option>
                </select>
            </div>
            <div class="file-grid" id="file-grid" style="min-height:300px;"></div>
            <div id="upload-progress" class="upload-progress" style="display:none;"></div>
        </div>
        <div id="batch-bar" class="batch-bar is-hidden">
            <span class="batch-bar__count">已选 0 项</span>
            <div class="batch-bar__actions">
                ${canUpload ? `<button type="button" class="btn btn-text" data-batch-action="move"><span class="icon">drive_file_move</span> 移动</button>
                <button type="button" class="btn btn-text" data-batch-action="copy"><span class="icon">file_copy</span> 复制</button>
                <button type="button" class="btn btn-text batch-bar__danger" data-batch-action="delete"><span class="icon">delete</span> 删除</button>` : ''}
                <button type="button" class="btn btn-outlined" data-batch-action="exit"><span class="icon">close</span> 退出</button>
            </div>
        </div>
    `;
    document.getElementById('batch-select-btn').onclick = () => {
        if (batchMode) exitBatchMode();
        else enterBatchMode();
    };
    if (canUpload) {
        document.getElementById('upload-btn').onclick = () => { const input = document.createElement('input'); input.type='file'; input.multiple=true; input.accept='image/*'; input.onchange=e=>uploadFiles(Array.from(input.files)); input.click(); };
        document.getElementById('new-folder-btn').onclick = () => showNewFolderDialog();
    }
    document.getElementById('refresh-btn').onclick = () => loadFiles(currentPath, { force: true });
    const manageBtn = document.getElementById('manage-btn');
    if (manageBtn) manageBtn.onclick = () => renderManagePage();
    document.getElementById('logout-btn').onclick = async () => { await apiFetch(`${API_BASE}/logout`,{method:'POST'}); currentUser=null; clearAuthToken(); renderLoginPage(); };
    document.getElementById('sort-field').onchange = (e) => { sortField = e.target.value; renderFileGrid(); };
    document.getElementById('sort-direction').onchange = (e) => { sortDirection = e.target.value; renderFileGrid(); };
    bindBatchBarActions();
    bindGalleryContextMenu();
    window.addEventListener('click', hideContextMenu);
    if (canUpload) {
        initDragAndDrop();
        initPasteUpload();
    }
    if (!canView) {
        fileList = [];
        galleryListPath = null;
        renderBreadcrumb();
        const grid = document.getElementById('file-grid');
        if (grid) grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color: var(--text-secondary);">您没有查看权限</div>';
    } else if (initialFiles != null) {
        fileList = initialFiles;
        galleryListPath = targetPath;
        filesListCache.set(targetPath, { data: initialFiles, ts: Date.now() });
        renderBreadcrumb();
        renderFileGrid();
    } else {
        loadFiles(targetPath);
    }
    syncFooterSpacer();
}

const IMAGE_MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/tiff': 'tiff'
};

const IMAGE_EXT_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tiff: 'image/tiff', tif: 'image/tiff'
};

function getFileBaseName(name) {
    return String(name || '').split(/[/\\]/).pop() || '';
}

function sanitizeUploadFileName(name) {
    const cleaned = String(name || 'image')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    return cleaned || 'image';
}

function hasFileExtension(name) {
    const base = getFileBaseName(name);
    const idx = base.lastIndexOf('.');
    return idx > 0 && idx < base.length - 1;
}

function extensionFromMime(mime) {
    if (!mime) return 'png';
    return IMAGE_MIME_EXT[mime] || mime.split('/').pop()?.replace('jpeg', 'jpg') || 'png';
}

function sniffImageMimeFromBuffer(buffer) {
    const bytes = new Uint8Array(buffer.slice(0, 16));
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        const tag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (tag === 'WEBP') return 'image/webp';
    }
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
    try {
        const text = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 512))).trim();
        if ((/^<\?xml/i.test(text) && text.includes('<svg')) || /^<svg[\s>]/i.test(text)) return 'image/svg+xml';
    } catch { /* ignore */ }
    return null;
}

async function detectImageMime(blob) {
    if (blob?.type?.startsWith('image/')) return blob.type;
    const head = await blob.slice(0, 512).arrayBuffer();
    return sniffImageMimeFromBuffer(head);
}

function ensureImageFileName(name, mime) {
    const safeName = sanitizeUploadFileName(name || 'image');
    if (hasFileExtension(safeName)) return safeName;
    return `${safeName}.${extensionFromMime(mime)}`;
}

async function normalizeUploadFile(file) {
    if (!file) return null;
    let mime = file.type;
    if (!mime || mime === 'application/octet-stream') {
        const ext = getFileBaseName(file.name).split('.').pop()?.toLowerCase();
        if (ext && IMAGE_EXT_MIME[ext]) mime = IMAGE_EXT_MIME[ext];
    }
    if (!mime || !mime.startsWith('image/')) {
        mime = await detectImageMime(file);
    }
    if (!mime?.startsWith('image/')) return null;
    const fileName = ensureImageFileName(file.name || 'image', mime);
    if (fileName === file.name && file.type === mime) return file;
    return new File([file], fileName, { type: mime, lastModified: file.lastModified || Date.now() });
}

async function normalizeUploadFiles(files) {
    const accepted = [];
    const skipped = [];
    for (const file of files) {
        const normalized = await normalizeUploadFile(file);
        if (normalized) accepted.push(normalized);
        else skipped.push(file?.name || '未知文件');
    }
    if (skipped.length) {
        const preview = skipped.slice(0, 3).join('、');
        uiToast(`已跳过非图片：${preview}${skipped.length > 3 ? '…' : ''}`, 'warning');
    }
    return accepted;
}

async function clipboardImageToPngFile(blob) {
    const mime = await detectImageMime(blob);
    if (!mime?.startsWith('image/')) return null;

    if (mime === 'image/png') {
        return new File([blob], `clipboard-${Date.now()}.png`, { type: 'image/png', lastModified: Date.now() });
    }

    try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        const pngBlob = await new Promise((resolve, reject) => {
            canvas.toBlob((result) => {
                if (result) resolve(result);
                else reject(new Error('转换 PNG 失败'));
            }, 'image/png');
        });
        return new File([pngBlob], `clipboard-${Date.now()}.png`, { type: 'image/png', lastModified: Date.now() });
    } catch {
        return null;
    }
}

async function fileFromImageUrl(urlText) {
    const url = String(urlText || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('请粘贴有效的 http/https 图片链接');

    let resp;
    try {
        resp = await fetch(url);
    } catch {
        throw new Error('无法下载该链接（网络错误或跨域限制）');
    }
    if (!resp.ok) throw new Error(`下载失败（HTTP ${resp.status}）`);

    const blob = await resp.blob();
    const mime = await detectImageMime(blob);
    if (!mime?.startsWith('image/')) throw new Error('链接内容不是图片');

    let name = 'image';
    try {
        const pathname = new URL(url).pathname;
        name = decodeURIComponent(pathname.split('/').pop() || 'image');
    } catch { /* ignore */ }
    name = sanitizeUploadFileName(name.split('?')[0].split('#')[0] || 'image');
    name = ensureImageFileName(name, mime);
    return new File([blob], name, { type: mime, lastModified: Date.now() });
}

function shouldHandleGalleryPaste(e) {
    if (!hasUploadPerm()) return false;
    if (!document.getElementById('file-grid')) return false;
    const active = document.activeElement;
    if (!active) return true;
    if (active.isContentEditable) return false;
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    return true;
}

let pasteUploadBound = false;

function initDragAndDrop() {
    const zone = document.querySelector('.gallery-main');
    if (!zone) return;

    let dragDepth = 0;
    const clearDragState = () => {
        dragDepth = 0;
        zone.classList.remove('is-drag-over');
    };

    zone.addEventListener('dragenter', (e) => {
        if (!hasUploadPerm()) return;
        e.preventDefault();
        dragDepth += 1;
        zone.classList.add('is-drag-over');
    });
    zone.addEventListener('dragleave', (e) => {
        if (!hasUploadPerm()) return;
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) zone.classList.remove('is-drag-over');
    });
    zone.addEventListener('dragover', (e) => {
        if (!hasUploadPerm()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        clearDragState();
        if (!hasUploadPerm()) {
            uiToast('您没有上传权限', 'error');
            return;
        }
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length) await uploadFiles(files);
    });
}

async function handlePasteUpload(e) {
    if (!shouldHandleGalleryPaste(e)) return;

    const items = [...(e.clipboardData?.items || [])];
    const imageItems = items.filter((item) => item.type.startsWith('image/'));

    if (imageItems.length) {
        e.preventDefault();
        const files = [];
        for (const item of imageItems) {
            const blob = item.getAsFile();
            if (!blob) continue;
            const pngFile = await clipboardImageToPngFile(blob);
            if (pngFile) files.push(pngFile);
        }
        if (files.length) {
            await uploadFiles(files);
            return;
        }
        uiToast('剪贴板内容不是有效图片', 'error');
        return;
    }

    const plainText = (e.clipboardData?.getData('text/plain') || '').trim();
    if (/^https?:\/\//i.test(plainText)) {
        e.preventDefault();
        try {
            const file = await fileFromImageUrl(plainText);
            await uploadFiles([file]);
        } catch (err) {
            uiToast(err.message || '下载图片失败', 'error');
        }
    }
}

function initPasteUpload() {
    if (pasteUploadBound) return;
    pasteUploadBound = true;
    window.addEventListener('paste', handlePasteUpload);
}

function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatUploadProgress(loaded, total) {
    const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    return {
        pct,
        text: `${pct}% · ${formatFileSize(loaded)} / ${formatFileSize(total)}`
    };
}

function getUploadProgressPanel() {
    let panel = document.getElementById('upload-progress');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'upload-progress';
        panel.className = 'upload-progress';
        panel.style.display = 'none';
        document.body.appendChild(panel);
    }
    return panel;
}

function hideUploadProgressIfEmpty() {
    const panel = document.getElementById('upload-progress');
    const list = panel?.querySelector('.upload-progress__list');
    if (panel && list && !list.children.length) panel.style.display = 'none';
}

function removeUploadRow(rowEl) {
    if (!rowEl) return;
    rowEl.classList.add('is-leaving');
    setTimeout(() => {
        rowEl.remove();
        hideUploadProgressIfEmpty();
    }, 280);
}

function createUploadRow(file, rowId) {
    const panel = getUploadProgressPanel();
    let list = panel.querySelector('.upload-progress__list');
    if (!list) {
        panel.innerHTML = '<div class="upload-progress__list"></div>';
        list = panel.querySelector('.upload-progress__list');
    }
    panel.style.display = 'block';

    const row = document.createElement('div');
    row.className = 'upload-file-row';
    row.dataset.rowId = rowId;
    row.innerHTML = `
        <div class="upload-file-row__main">
            <div class="upload-file-row__name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
            <div class="upload-file-row__stats">0% · 0 B / ${escapeHtml(formatFileSize(file.size))}</div>
        </div>
        <div class="upload-file-row__track">
            <div class="upload-file-row__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="upload-file-row__fill"></div>
            </div>
            <button type="button" class="upload-file-row__copy btn btn-text" hidden>
                <span class="icon">content_copy</span> 复制链接
            </button>
        </div>
    `;
    list.appendChild(row);

    return {
        row,
        nameEl: row.querySelector('.upload-file-row__name'),
        statsEl: row.querySelector('.upload-file-row__stats'),
        barEl: row.querySelector('.upload-file-row__bar'),
        fillEl: row.querySelector('.upload-file-row__fill'),
        copyBtn: row.querySelector('.upload-file-row__copy')
    };
}

function updateUploadRow(ui, loaded, total) {
    const { pct, text } = formatUploadProgress(loaded, total);
    if (ui.statsEl) ui.statsEl.textContent = text;
    if (ui.fillEl) ui.fillEl.style.width = `${pct}%`;
    if (ui.barEl) ui.barEl.setAttribute('aria-valuenow', String(pct));
}

function markUploadRowDone(ui, publicUrl, options = {}) {
    ui.row.classList.add('is-done');
    if (options.duplicate) ui.row.classList.add('is-duplicate');
    updateUploadRow(ui, ui.row._fileSize || 1, ui.row._fileSize || 1);
    if (ui.statsEl) {
        ui.statsEl.textContent = options.message || `100% · ${formatFileSize(ui.row._fileSize || 0)} / ${formatFileSize(ui.row._fileSize || 0)}`;
    }
    if (ui.copyBtn) {
        ui.copyBtn.hidden = false;
        ui.copyBtn.onclick = async (e) => {
            e.stopPropagation();
            try {
                await navigator.clipboard.writeText(publicUrl);
                uiToast('链接已复制', 'success');
            } catch {
                await uiPrompt('请手动复制链接', { defaultValue: publicUrl, message: '浏览器不支持自动复制，请全选后复制' });
            }
        };
    }
    setTimeout(() => removeUploadRow(ui.row), 3000);
}

function markUploadRowError(ui, message) {
    ui.row.classList.add('is-error');
    if (ui.statsEl) ui.statsEl.textContent = message || '上传失败';
    if (ui.fillEl) ui.fillEl.style.width = '100%';
    ui.row.querySelector('.upload-file-row__bar')?.classList.add('is-error');
    setTimeout(() => removeUploadRow(ui.row), 5000);
}

function uploadSingleFileWithProgress(file, targetDir, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('files', file);
        formData.append('targetDir', targetDir);
        xhr.upload.addEventListener('progress', (e) => {
            const total = e.lengthComputable ? e.total : file.size;
            const loaded = e.lengthComputable ? e.loaded : Math.min(file.size * 0.9, file.size);
            onProgress(loaded, total);
        });
        xhr.addEventListener('load', () => {
            let payload = null;
            try { payload = JSON.parse(xhr.responseText); } catch { /* ignore */ }
            const item = payload?.results?.[0];
            if (xhr.status >= 200 && xhr.status < 300 && item?.success) {
                resolve(item);
                return;
            }
            reject(new Error(item?.error || '上传失败'));
        });
        xhr.addEventListener('error', () => reject(new Error('网络错误')));
        xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
        xhr.open('POST', `${API_BASE}/upload`);
        if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        xhr.withCredentials = true;
        xhr.send(formData);
    });
}

async function uploadFiles(files) {
    if (!hasUploadPerm()) { uiToast('您没有上传权限', 'error'); return; }
    if (!files || files.length === 0) return;
    if (uploadInProgress) { uiToast('请等待当前上传完成', 'warning'); return; }

    const normalized = await normalizeUploadFiles(Array.from(files));
    if (!normalized.length) return;
    if (normalized.length > 100) { uiToast('单次最多上传 100 张', 'error'); return; }
    for (const f of normalized) {
        if (f.size > 20 * 1024 * 1024) { uiToast(`文件 ${f.name} 超过 20MB`, 'error'); return; }
    }

    uploadInProgress = true;
    const targetDir = normalizeCurrentPath(currentPath);
    let anyNewUpload = false;

    try {
        for (let index = 0; index < normalized.length; index++) {
            const file = normalized[index];
            const rowId = `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            const ui = createUploadRow(file, rowId);
            ui.row._fileSize = file.size;
            try {
                const result = await uploadSingleFileWithProgress(file, targetDir, (loaded, total) => {
                    updateUploadRow(ui, loaded, total);
                });
                updateUploadRow(ui, file.size, file.size);
                if (result.duplicate) {
                    markUploadRowDone(ui, result.url, { duplicate: true, message: result.message || '文件已存在' });
                } else {
                    markUploadRowDone(ui, result.url);
                    anyNewUpload = true;
                }
            } catch (err) {
                markUploadRowError(ui, err.message || '上传失败');
            }
        }
    } finally {
        uploadInProgress = false;
    }

    if (anyNewUpload) await refreshGalleryAfterMutation();
}

function invalidateFilesListCache() {
    filesListCache.clear();
}

async function refreshGalleryAfterMutation(options = {}) {
    const targetPath = normalizeCurrentPath(options.path ?? currentPath);
    invalidateFilesListCache();
    if (options.patch) {
        const { oldPath, newPath, newName } = options.patch;
        const idx = fileList.findIndex(i => i.path === oldPath);
        if (idx >= 0) {
            fileList[idx] = { ...fileList[idx], path: newPath, name: newName };
            renderFileGrid();
        }
    }
    if (options.addItem) {
        const parent = getItemParentPath(options.addItem.path, options.addItem.type || 'dir');
        if (normalizeCurrentPath(parent) === targetPath && !fileList.some(i => i.path === options.addItem.path)) {
            fileList = sortItems([...fileList, options.addItem]);
            renderFileGrid();
        }
    }
    if (options.removePath) {
        const before = fileList.length;
        fileList = fileList.filter(i => i.path !== options.removePath);
        if (fileList.length !== before) renderFileGrid();
    }
    await loadFiles(targetPath, { force: true });
}

function getItemParentPath(itemPath, type) {
    if (type === 'dir') {
        const dir = normalizeCurrentPath(itemPath);
        const slash = dir.lastIndexOf('/');
        return slash <= 0 ? '/' : dir.slice(0, slash);
    }
    const key = (itemPath || '').replace(/^\/+/, '');
    const slash = key.lastIndexOf('/');
    return slash <= 0 ? '/' : normalizeCurrentPath('/' + key.slice(0, slash));
}

function showGridLoading(count = 8) {
    const grid = document.getElementById('file-grid');
    if (!grid) return;
    grid.innerHTML = Array.from({ length: count }, () => `
        <div class="file-card file-card--skeleton">
            <div class="file-preview file-preview--skeleton"></div>
            <div class="file-name-skeleton"></div>
        </div>
    `).join('');
}

async function loadFiles(path, { force = false } = {}) {
    const nextPath = normalizeCurrentPath(path);
    if (batchMode && nextPath !== normalizeCurrentPath(currentPath)) {
        batchMode = false;
        batchSelected.clear();
    }
    currentPath = nextPath;
    syncGalleryPathToUrl(nextPath);
    const cacheKey = currentPath;

    if (force) {
        filesListCache.delete(cacheKey);
    }

    const cached = filesListCache.get(cacheKey);

    if (!force && cached && Date.now() - cached.ts < FILES_CACHE_TTL) {
        fileList = cached.data;
        galleryListPath = cacheKey;
        renderBreadcrumb();
        renderFileGrid();
        return;
    }

    const keepVisibleWhileLoading = galleryListPath === cacheKey && fileList.length > 0;

    if (!force && cached) {
        fileList = cached.data;
        galleryListPath = cacheKey;
        renderBreadcrumb();
        renderFileGrid();
    } else if (keepVisibleWhileLoading) {
        renderBreadcrumb();
        renderFileGrid();
    } else {
        showGridLoading();
    }

    const seq = (filesListSeq.get(cacheKey) || 0) + 1;
    filesListSeq.set(cacheKey, seq);

    const promise = (async () => {
        try {
            const qs = new URLSearchParams({ parent: cacheKey });
            if (force) qs.set('_', String(Date.now()));
            const res = await apiFetch(`${API_BASE}/files?${qs}`);
            if (!res.ok) throw new Error('load failed');
            const data = await res.json();
            const items = Array.isArray(data) ? data : [];
            if (!Array.isArray(data)) uiToast('文件列表数据异常', 'error');
            if (filesListSeq.get(cacheKey) !== seq) return;
            filesListCache.set(cacheKey, { data: items, ts: Date.now() });
            if (normalizeCurrentPath(currentPath) === cacheKey) {
                fileList = items;
                galleryListPath = cacheKey;
                renderBreadcrumb();
                renderFileGrid();
            }
        } catch {
            if (filesListSeq.get(cacheKey) === seq && normalizeCurrentPath(currentPath) === cacheKey) {
                uiToast('加载文件列表失败', 'error');
                renderBreadcrumb();
                renderFileGrid();
            }
        } finally {
            if (filesListInflight.get(cacheKey) === promise) {
                filesListInflight.delete(cacheKey);
            }
        }
    })();

    filesListInflight.set(cacheKey, promise);
    await promise;
}

function renderBreadcrumb() {
    const container = document.getElementById('breadcrumb');
    if (!container) return;
    const parts = currentPath === '/' ? [] : currentPath.split('/').filter(p=>p);
    let html = `<div class="breadcrumb-item" data-path="/">根目录</div>`;
    let accum = '';
    for (const part of parts) {
        accum += '/' + part;
        html += `<span class="breadcrumb-separator">/</span><div class="breadcrumb-item" data-path="${accum}">${escapeHtml(part)}</div>`;
    }
    container.innerHTML = html;
    document.querySelectorAll('.breadcrumb-item').forEach(el=>{
        el.addEventListener('click',(e)=>{e.stopPropagation(); loadFiles(el.dataset.path);});
    });
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|svg|ico|avif|heic|heif|tiff?)$/i;
const PREVIEW_LOADER_HTML = '<div class="preview-loader-spinner" aria-hidden="true"></div>';

function isImageItem(item) {
    if (!item || item.type !== 'file') return false;
    const name = item.name || item.path || '';
    if (item.mime) {
        const mime = item.mime.toLowerCase();
        if (mime.startsWith('image/')) return true;
        if ((mime === 'text/xml' || mime === 'application/xml') && /\.svg$/i.test(name)) return true;
    }
    return IMAGE_EXT_RE.test(name);
}

function isSvgItem(item) {
    const name = item.name || item.path || item.src || '';
    if (/\.svg(\?|#|$)/i.test(name)) return true;
    const mime = (item.mime || '').toLowerCase();
    return mime === 'image/svg+xml' || mime === 'image/svg';
}

function getItemStorageKey(pathOrItem) {
    const path = typeof pathOrItem === 'string'
        ? pathOrItem
        : (pathOrItem?.path || '');
    return path.replace(/^\/+/, '');
}

function getItemFetchUrl(pathOrItem) {
    const key = getItemStorageKey(pathOrItem);
    return key ? `${API_BASE}/file/raw?path=${encodeURIComponent(key)}` : '';
}

function getItemLocalUrl(pathOrItem) {
    return getItemFetchUrl(pathOrItem);
}

function getItemUrl(item) {
    const path = getItemStorageKey(item);
    if (currentSettings.r2_public_url) {
        return `${currentSettings.r2_public_url.replace(/\/$/, '')}/${path}`;
    }
    return path ? `/${path}` : '/';
}

function resolvePreviewFetchUrl(img, remoteUrl) {
    const localSrc = img.dataset.localSrc;
    if (localSrc) return localSrc;
    const path = img.closest('.file-card')?.dataset.path;
    if (path) return getItemLocalUrl(path);
    try {
        const parsed = new URL(remoteUrl, window.location.origin);
        if (parsed.origin === window.location.origin) return `${parsed.pathname}${parsed.search}`;
    } catch { /* ignore */ }
    return remoteUrl;
}

function getPreviewHtml(item) {
    if (item.type === 'dir') {
        return '<span class="icon" style="font-size:48px;">folder</span>';
    }
    if (isImageItem(item)) {
        const svgClass = isSvgItem(item) ? ' is-svg' : '';
        const url = escapeHtml(getItemUrl(item));
        const localUrl = escapeHtml(getItemLocalUrl(item));
        return `<div class="preview-loader" aria-hidden="true">${PREVIEW_LOADER_HTML}</div><img class="preview-img${svgClass}" data-src="${url}" data-local-src="${localUrl}" alt="${escapeHtml(item.name)}" decoding="async">`;
    }
    return '<span class="icon" style="font-size:48px;">insert_drive_file</span>';
}

function revealPreviewImage(img, loader) {
    img.classList.add('is-loaded');
    if (loader) {
        loader.classList.add('is-hidden');
        setTimeout(() => loader.remove(), 350);
    }
}

function loadPreviewImage(img) {
    const preview = img.closest('.file-preview');
    const loader = preview?.querySelector('.preview-loader');
    const src = img.dataset.src;
    if (!src || img.dataset.loading === '1') return;
    img.dataset.loading = '1';
    delete img.dataset.src;

    const isSvg = img.classList.contains('is-svg');
    const imgUrl = src;
    let svgFallbackDone = false;

    const showBrokenIcon = () => {
        if (loader) loader.remove();
        const fallback = document.createElement('span');
        fallback.className = 'icon';
        fallback.style.fontSize = '48px';
        fallback.textContent = 'broken_image';
        img.replaceWith(fallback);
    };

    const fetchSvgInline = () => {
        if (svgFallbackDone || !img.isConnected) return;
        svgFallbackDone = true;
        if (loader) loader.remove();
        fetch(resolvePreviewFetchUrl(img, imgUrl))
            .then(res => res.text())
            .then(svgText => {
                if (!img.isConnected) return;
                if (svgText.includes('<svg')) {
                    const svgContainer = document.createElement('div');
                    svgContainer.className = 'svg-fallback';
                    svgContainer.innerHTML = svgText;
                    const svgEl = svgContainer.querySelector('svg');
                    if (svgEl) {
                        svgEl.style.width = '100%';
                        svgEl.style.height = '100%';
                        img.replaceWith(svgContainer);
                        return;
                    }
                }
                showBrokenIcon();
            })
            .catch(() => showBrokenIcon());
    };

    const showError = () => {
        if (isSvg) fetchSvgInline();
        else showBrokenIcon();
    };

    const reveal = () => {
        const done = () => revealPreviewImage(img, loader);
        if (typeof img.decode === 'function') {
            img.decode().then(done).catch(done);
        } else {
            done();
        }
    };

    img.onerror = isSvg ? showError : showBrokenIcon;
    img.onload = reveal;
    img.src = imgUrl;

    if (img.complete) {
        if (img.naturalWidth + img.naturalHeight > 0) {
            reveal();
        } else if (!isSvg) {
            showBrokenIcon();
        }
    }

    if (isSvg) {
        setTimeout(() => {
            if (!img.isConnected || img.classList.contains('is-loaded')) return;
            if (img.complete && img.naturalWidth !== 0) reveal();
            else fetchSvgInline();
        }, 3000);
    }
}

function initPreviewImages() {
    if (previewImageObserver) previewImageObserver.disconnect();

    previewImageObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            previewImageObserver.unobserve(entry.target);
            loadPreviewImage(entry.target);
        });
    }, { root: null, rootMargin: '280px 0px', threshold: 0.01 });

    document.querySelectorAll('.file-preview--image .preview-img[data-src]').forEach((img) => {
        previewImageObserver.observe(img);
    });
}

function sortItems(items) {
    const order = sortDirection === 'asc' ? 1 : -1;
    return items.slice().sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        let av, bv;
        switch (sortField) {
            case 'uploaded_at':
                av = a.uploaded_at || 0;
                bv = b.uploaded_at || 0;
                break;
            case 'size':
                av = a.size || 0;
                bv = b.size || 0;
                break;
            default:
                av = (a.name || '').toLowerCase();
                bv = (b.name || '').toLowerCase();
        }
        if (av < bv) return -1 * order;
        if (av > bv) return 1 * order;
        return 0;
    });
}

function renderFileGrid() {
    const grid = document.getElementById('file-grid');
    if (!grid) return;
    const items = sortItems(fileList);
    if (items.length===0) {
        grid.innerHTML='<div class="file-grid-empty" style="grid-column:1/-1; text-align:center; padding:40px;">空文件夹</div>';
        return;
    }
    const canUpload = hasUploadPerm();
    grid.innerHTML = items.map(item => {
        const selected = batchSelected.has(item.path);
        return `
        <div class="file-card${batchMode ? ' file-card--batch' : ''}${selected ? ' is-batch-selected' : ''}" data-path="${escapeHtml(item.path || '')}" data-type="${item.type}">
            ${!batchMode && (canUpload || item.type === 'file') ? `<button class="file-card-menu" type="button" aria-label="更多操作" data-path="${escapeHtml(item.path || '')}" data-type="${item.type}">
                <span class="icon">more_vert</span>
            </button>` : ''}
            ${batchMode ? `<label class="file-card-check" aria-label="选择"><input type="checkbox"${selected ? ' checked' : ''}></label>` : ''}
            <div class="file-preview${isImageItem(item) ? ' file-preview--image' : ''}">${getPreviewHtml(item)}</div>
            <div class="file-name">${escapeHtml(item.name)}</div>
        </div>`;
    }).join('');
    initPreviewImages();
    document.querySelectorAll('.file-card').forEach(card=>{
        card.addEventListener('click',(e)=>{
            if (e.target.closest('.file-card-menu') || e.target.closest('.file-card-check')) return;
            e.stopPropagation();
            const path=card.dataset.path, type=card.dataset.type;
            if (!batchMode && isDesktopGalleryInput() && (e.ctrlKey || e.metaKey || e.shiftKey)) {
                enterBatchMode(path, type);
                return;
            }
            if (batchMode) {
                toggleBatchSelection(path, type);
                card.classList.toggle('is-batch-selected', batchSelected.has(path));
                const cb = card.querySelector('.file-card-check input');
                if (cb) cb.checked = batchSelected.has(path);
                return;
            }
            if(type==='dir') loadFiles(path);
            else showImageViewer(path);
        });
        card.querySelector('.file-card-check input')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const path = card.dataset.path;
            const type = card.dataset.type;
            toggleBatchSelection(path, type);
            card.classList.toggle('is-batch-selected', batchSelected.has(path));
            e.target.checked = batchSelected.has(path);
        });
        if (!batchMode) {
            card.addEventListener('contextmenu',(e)=>{
                e.preventDefault();
                e.stopPropagation();
                selectedItem = getFileListItem(card.dataset.path) || { path: card.dataset.path, type: card.dataset.type };
                showContextMenu(e.clientX, e.clientY, card.dataset.type);
            });
            initLongPress(card, () => {
                selectedItem = getFileListItem(card.dataset.path) || { path: card.dataset.path, type: card.dataset.type };
                const rect = card.getBoundingClientRect();
                showContextMenu(rect.left + rect.width / 2, rect.top + 20, card.dataset.type);
            });
        }
    });
    if (!batchMode) {
        document.querySelectorAll('.file-card-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedItem = getFileListItem(btn.dataset.path) || { path: btn.dataset.path, type: btn.dataset.type };
                const rect = btn.getBoundingClientRect();
                showContextMenu(rect.left, rect.bottom + 4, btn.dataset.type);
            });
        });
    }
    updateBatchBar();
}

function bindBatchBarActions() {
    const bar = document.getElementById('batch-bar');
    if (!bar || bar.dataset.bound) return;
    bar.dataset.bound = '1';
    bar.querySelectorAll('[data-batch-action]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.batchAction;
            if (action === 'exit') exitBatchMode();
            else if (action === 'move') await batchMoveItems();
            else if (action === 'copy') await batchCopyItems();
            else if (action === 'delete') await batchDeleteItems();
        });
    });
}

async function batchDeleteItems() {
    if (!hasUploadPerm()) { uiToast('您没有上传权限', 'error'); return; }
    const items = [...batchSelected.entries()];
    if (!items.length) { uiToast('请先选择项目', 'error'); return; }
    if (!await uiConfirm(`确定删除 ${items.length} 项吗？`, { danger: true, confirmText: '删除' })) return;
    uiLoadingShow('删除中，请稍候');
    try {
        let failed = 0;
        let lastError = '';
        for (const [path] of items) {
            const res = await apiFetch(`${API_BASE}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
            if (!res.ok) {
                failed++;
                const err = await res.json().catch(() => ({}));
                lastError = err.error || '';
            }
        }
        exitBatchMode();
        await refreshGalleryAfterMutation();
        if (failed === 0) uiToast('删除成功', 'success');
        else if (failed === items.length) uiToast('删除失败' + (lastError ? '：' + lastError : ''), 'error');
        else uiToast(`部分删除失败（${failed}/${items.length}）` + (lastError ? '：' + lastError : ''), 'warning');
    } catch {
        uiToast('删除失败', 'error');
    } finally {
        uiLoadingHide();
    }
}

async function batchMoveItems() {
    if (!hasUploadPerm()) { uiToast('您没有上传权限', 'error'); return; }
    const items = [...batchSelected.entries()];
    if (!items.length) { uiToast('请先选择项目', 'error'); return; }
    const picked = await showFolderPicker({
        title: '选择目标文件夹',
        icon: 'drive_file_move',
        sourcePath: items.find(([, t]) => t === 'dir')?.[0] || items[0][0],
        sourceType: items.some(([, t]) => t === 'dir') ? 'dir' : 'file',
        defaultPath: normalizeCurrentPath(currentPath),
        showOverwrite: true
    });
    if (!picked) return;
    uiLoadingShow('移动中，请稍候');
    try {
        let failed = 0;
        for (const [path, type] of items) {
            if (isFolderPickerTargetDisabled(path, type, picked.targetDir)) { failed++; continue; }
            const res = await apiFetch(`${API_BASE}/move`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourcePath: path, targetDir: picked.targetDir, overwrite: picked.overwrite })
            });
            if (!res.ok) failed++;
        }
        exitBatchMode();
        await refreshGalleryAfterMutation();
        uiToast(failed ? `完成，${failed} 项失败` : '移动成功', failed ? 'error' : 'success');
    } catch {
        uiToast('移动失败', 'error');
    } finally {
        uiLoadingHide();
    }
}

async function batchCopyItems() {
    if (!hasUploadPerm()) { uiToast('您没有上传权限', 'error'); return; }
    const items = [...batchSelected.entries()];
    if (!items.length) { uiToast('请先选择项目', 'error'); return; }
    const picked = await showFolderPicker({
        title: '选择目标文件夹',
        icon: 'content_copy',
        sourcePath: items[0][0],
        sourceType: items[0][1],
        defaultPath: normalizeCurrentPath(currentPath),
        showOverwrite: true
    });
    if (!picked) return;
    uiLoadingShow('复制中，请稍候');
    try {
        let failed = 0;
        for (const [path] of items) {
            const res = await apiFetch(`${API_BASE}/copy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourcePath: path, targetDir: picked.targetDir, overwrite: picked.overwrite })
            });
            if (!res.ok) failed++;
        }
        exitBatchMode();
        await refreshGalleryAfterMutation();
        uiToast(failed ? `完成，${failed} 项失败` : '复制成功', failed ? 'error' : 'success');
    } catch {
        uiToast('复制失败', 'error');
    } finally {
        uiLoadingHide();
    }
}

function initLongPress(el, callback, delay = 500) {
    let timer = null;
    let moved = false;
    const start = (e) => {
        if (e.target.closest('.file-card-menu')) return;
        moved = false;
        timer = setTimeout(() => { callback(); }, delay);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const move = () => { moved = true; cancel(); };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
}

function isViewerMobileLayout() {
    return window.matchMedia('(max-width: 768px)').matches;
}

function syncViewerAccordion(contentEl) {
    const accordion = contentEl?.querySelector('.viewer-accordion');
    if (!accordion) return;
    const items = [...accordion.querySelectorAll('.viewer-acc-item')];
    const mobile = isViewerMobileLayout();
    contentEl.classList.toggle('layout-mobile', mobile);
    if (mobile) {
        const openItem = items.find((i) => i.classList.contains('is-open')) || items[0];
        items.forEach((item) => item.classList.toggle('is-open', item === openItem));
    } else {
        items.forEach((item) => item.classList.add('is-open'));
    }
}

function bindViewerAccordion(modal) {
    const accordion = modal.querySelector('.viewer-accordion');
    if (!accordion) return;
    accordion.addEventListener('click', (e) => {
        if (e.target.closest('.info-copy-btn')) return;
        if (!isViewerMobileLayout()) return;
        const head = e.target.closest('.viewer-acc-head');
        if (!head) return;
        const item = head.closest('.viewer-acc-item');
        if (!item) return;
        const items = [...accordion.querySelectorAll('.viewer-acc-item')];
        const willOpen = !item.classList.contains('is-open');
        items.forEach((i) => i.classList.remove('is-open'));
        if (willOpen) item.classList.add('is-open');
    });
}

function applyViewerLayout(contentEl, width, height) {
    if (!contentEl || !width || !height) return;

    if (isViewerMobileLayout()) {
        // 手机：固定上下布局，下方信息区 30%–40%
        contentEl.classList.add('layout-stack');
        contentEl.classList.remove('layout-side');
        contentEl.dataset.viewerFit = 'contain';
        syncViewerAccordion(contentEl);
        return;
    }

    // 桌面：横图（宽≥高）→ 上下；竖图（高>宽）→ 左右，信息栏窄
    const isPortrait = height > width;
    contentEl.classList.toggle('layout-side', isPortrait);
    contentEl.classList.toggle('layout-stack', !isPortrait);
    contentEl.dataset.viewerFit = isPortrait ? 'height' : 'contain';
    syncViewerAccordion(contentEl);
}

function fitViewerMediaContent(mediaEl) {
    const stage = mediaEl?.querySelector('.viewer-media-stage');
    const transformEl = mediaEl?.querySelector('.viewer-media-transform');
    if (!stage || !transformEl) return;

    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    const img = transformEl.querySelector('img');
    const svgContainer = transformEl.querySelector('.viewer-svg-container');
    const svgFallback = transformEl.querySelector('.svg-viewer-fallback');

    let natW = 0;
    let natH = 0;
    if (img?.naturalWidth > 0) {
        natW = img.naturalWidth;
        natH = img.naturalHeight;
    } else if (svgContainer) {
        const rect = svgContainer.getBoundingClientRect();
        natW = rect.width || svgContainer.scrollWidth;
        natH = rect.height || svgContainer.scrollHeight;
    } else if (svgFallback?.firstElementChild) {
        const rect = svgFallback.getBoundingClientRect();
        natW = rect.width || svgFallback.scrollWidth;
        natH = rect.height || svgFallback.scrollHeight;
    }
    if (!natW || !natH) return;

    const fitMode = mediaEl.closest('.image-viewer-content')?.dataset.viewerFit || 'contain';
    const fit = fitMode === 'width'
        ? cw / natW
        : fitMode === 'height'
            ? ch / natH
            : Math.min(cw / natW, ch / natH);
    const dw = Math.max(1, Math.round(natW * fit));
    const dh = Math.max(1, Math.round(natH * fit));

    [img, svgContainer, svgFallback].forEach((el) => {
        if (!el) return;
        el.style.width = `${dw}px`;
        el.style.height = `${dh}px`;
        el.style.maxWidth = 'none';
        el.style.maxHeight = 'none';
    });
}

let ghostClickSuppressUntil = 0;
let ghostClickSuppressHandler = null;

function suppressGhostClick(ms = 450) {
    ghostClickSuppressUntil = Date.now() + ms;
    if (ghostClickSuppressHandler) return;
    ghostClickSuppressHandler = (e) => {
        if (Date.now() < ghostClickSuppressUntil) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }
    };
    document.addEventListener('click', ghostClickSuppressHandler, true);
    document.addEventListener('touchend', ghostClickSuppressHandler, true);
}

function bindViewerMediaInteraction(mediaEl, options = {}) {
    const { onMobileTapClose } = options;
    const transformEl = mediaEl?.querySelector('.viewer-media-transform');
    if (!transformEl) return { reset() {}, destroy() {} };

    const ac = new AbortController();
    const { signal } = ac;
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTx = 0;
    let startTy = 0;
    let touchMode = null;
    let touchStartDist = 0;
    let touchStartScale = 1;
    let touchMoved = false;
    let pinchActive = false;
    let touchStartTime = 0;

    const apply = () => {
        transformEl.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
        mediaEl.classList.toggle('is-zoomed', scale !== 1 || tx !== 0 || ty !== 0);
    };

    const reset = () => {
        scale = 1;
        tx = 0;
        ty = 0;
        dragging = false;
        touchMode = null;
        mediaEl.classList.remove('is-dragging');
        fitViewerMediaContent(mediaEl);
        apply();
    };

    const refit = () => fitViewerMediaContent(mediaEl);

    const zoomAt = (factor) => {
        scale = Math.min(6, Math.max(0.25, scale * factor));
        apply();
    };

    mediaEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false, signal });

    mediaEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        mediaEl.classList.add('is-dragging');
        startX = e.clientX;
        startY = e.clientY;
        startTx = tx;
        startTy = ty;
    }, { signal });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        tx = startTx + (e.clientX - startX);
        ty = startTy + (e.clientY - startY);
        apply();
    }, { signal });

    window.addEventListener('mouseup', () => {
        dragging = false;
        mediaEl.classList.remove('is-dragging');
    }, { signal });

    mediaEl.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        reset();
    }, { signal });

    mediaEl.addEventListener('touchstart', (e) => {
        touchMoved = false;
        pinchActive = false;
        touchStartTime = Date.now();
        if (e.touches.length === 2) {
            touchMode = 'pinch';
            pinchActive = true;
            dragging = false;
            mediaEl.classList.remove('is-dragging');
            touchStartDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            touchStartScale = scale;
        } else if (e.touches.length === 1) {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            startTx = tx;
            startTy = ty;
            const zoomed = scale !== 1 || tx !== 0 || ty !== 0;
            if (zoomed) {
                touchMode = 'pan';
                dragging = true;
                mediaEl.classList.add('is-dragging');
            } else {
                touchMode = 'tap';
                dragging = false;
            }
        }
    }, { passive: true, signal });

    mediaEl.addEventListener('touchmove', (e) => {
        if (touchMode === 'tap' && e.touches.length === 1) {
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (Math.hypot(dx, dy) > 10) touchMoved = true;
            return;
        }
        if (touchMode === 'pan' && e.touches.length === 1) {
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            if (Math.hypot(dx, dy) > 10) touchMoved = true;
            e.preventDefault();
            tx = startTx + dx;
            ty = startTy + dy;
            apply();
        } else if (touchMode === 'pinch' && e.touches.length === 2) {
            pinchActive = true;
            e.preventDefault();
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (touchStartDist > 0) {
                scale = Math.min(6, Math.max(0.25, touchStartScale * (dist / touchStartDist)));
                apply();
            }
        }
    }, { passive: false, signal });

    mediaEl.addEventListener('touchend', (e) => {
        const tapClose = onMobileTapClose
            && isViewerMobileLayout()
            && touchMode === 'tap'
            && !pinchActive
            && !touchMoved
            && scale === 1
            && tx === 0
            && ty === 0
            && Date.now() - touchStartTime < 500;
        dragging = false;
        touchMode = null;
        mediaEl.classList.remove('is-dragging');
        if (tapClose) {
            e.preventDefault();
            e.stopPropagation();
            suppressGhostClick();
            onMobileTapClose();
        }
    }, { passive: false, signal });

    const imgEl = transformEl.querySelector('img');
    const onImgReady = () => refit();
    if (imgEl?.complete && imgEl.naturalWidth) onImgReady();
    else imgEl?.addEventListener('load', onImgReady, { signal });

    const stageEl = mediaEl.querySelector('.viewer-media-stage');
    if (stageEl && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
            if (scale !== 1 || tx !== 0 || ty !== 0) reset();
            else refit();
        });
        ro.observe(stageEl);
        ac.signal.addEventListener('abort', () => ro.disconnect());
    }

    refit();
    apply();
    return { reset, refit, destroy: () => ac.abort() };
}

function lockBodyScrollForViewer() {
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.dataset.viewerScrollY = String(scrollY);
    document.body.classList.add('viewer-scroll-lock');
    document.body.style.top = `-${scrollY}px`;
}

function unlockBodyScrollForViewer() {
    const scrollY = Number(document.body.dataset.viewerScrollY || 0);
    document.body.classList.remove('viewer-scroll-lock');
    document.body.style.top = '';
    delete document.body.dataset.viewerScrollY;
    window.scrollTo(0, scrollY);
}

function bindViewerImageLayout(contentEl, imgEl, onLayout) {
    if (!contentEl || !imgEl) return;
    const apply = () => {
        applyViewerLayout(contentEl, imgEl.naturalWidth, imgEl.naturalHeight);
        onLayout?.();
    };
    if (imgEl.complete && imgEl.naturalWidth) apply();
    else imgEl.addEventListener('load', apply, { once: true });

    const onResize = () => apply();
    window.addEventListener('resize', onResize);
    contentEl._viewerLayoutCleanup = () => window.removeEventListener('resize', onResize);
}

let exifrPromise = null;
const exifMetaCache = new Map();
const exifMetaInflight = new Map();
const EXIF_PARSE_PICK = [
    'Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO',
    'FocalLength', 'FocalLengthIn35mmFormat', 'DateTimeOriginal', 'CreateDate',
    'ModifyDate', 'Orientation', 'Software', 'ColorSpace',
    'GPSLatitude', 'GPSLongitude', 'ImageWidth', 'ImageHeight', 'PixelXDimension', 'PixelYDimension'
];
const EXIF_PARSE_EXT_RE = /\.(jpe?g|png|webp|tiff?|heic|heif|avif)$/i;

function getExifCacheKey(normalizedPath) {
    return (normalizedPath || '').replace(/^\/+/, '');
}

function canParseExifFileName(fileName) {
    return EXIF_PARSE_EXT_RE.test(fileName || '');
}

function buildExifRows(exif) {
    if (!exif) return [];
    const rows = [];
    if (exif.Make || exif.Model) {
        rows.push(['相机', [exif.Make, exif.Model].filter(Boolean).join(' ')]);
    }
    if (exif.LensModel) rows.push(['镜头', String(exif.LensModel)]);
    const aperture = formatAperture(exif.FNumber);
    if (aperture) rows.push(['光圈', aperture]);
    const shutter = formatExposureTime(exif.ExposureTime);
    if (shutter) rows.push(['快门', shutter]);
    if (exif.ISO) rows.push(['ISO', String(exif.ISO)]);
    if (exif.FocalLength) {
        const fl = `${Number(exif.FocalLength).toFixed(1).replace(/\.0$/, '')}mm`;
        rows.push(['焦距', exif.FocalLengthIn35mmFormat ? `${fl}（等效 ${exif.FocalLengthIn35mmFormat}mm）` : fl]);
    }
    const taken = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
    if (taken) rows.push(['拍摄时间', formatViewerTimestamp(taken)]);
    if (exif.Orientation && exif.Orientation !== 1) rows.push(['方向', String(exif.Orientation)]);
    if (exif.Software) rows.push(['软件', String(exif.Software)]);
    if (exif.ColorSpace) rows.push(['色彩空间', String(exif.ColorSpace)]);
    const gps = formatGps(exif.GPSLatitude, exif.GPSLongitude);
    if (gps) rows.push(['GPS', gps]);
    return rows;
}

function buildViewerBaseRows(viewerImg, item) {
    const rows = [];
    if (viewerImg?.naturalWidth) {
        rows.push(['尺寸', `${viewerImg.naturalWidth} × ${viewerImg.naturalHeight} 像素`]);
    }
    if (item?.size) rows.push(['文件大小', formatFileSize(item.size)]);
    if (item?.mime) rows.push(['格式', item.mime]);
    if (item?.uploaded_at) rows.push(['上传时间', formatViewerTimestamp(item.uploaded_at)]);
    return rows;
}

function renderViewerMetaRows(metaEl, rows, options = {}) {
    if (!metaEl) return;
    if (!rows.length && !options.exifLoading) {
        metaEl.innerHTML = '<div class="info-meta-empty">暂无更多信息</div>';
        return;
    }
    let html = rows.map(([key, val]) =>
        `<div class="info-meta-row"><span class="info-meta-key">${escapeHtml(key)}</span><span class="info-meta-val">${escapeHtml(val)}</span></div>`
    ).join('');
    if (options.exifLoading) {
        html += '<div class="info-meta-row info-meta-row--loading"><span class="info-meta-key">EXIF</span><span class="info-meta-val">读取中…</span></div>';
    }
    metaEl.innerHTML = html;
}

function isCrossOriginResourceUrl(url) {
    if (!url) return false;
    try {
        return new URL(url, window.location.origin).origin !== window.location.origin;
    } catch {
        return false;
    }
}

function canParseExifFromImageElement(img) {
    if (!img?.complete || img.naturalWidth <= 0) return false;
    return !isCrossOriginResourceUrl(img.currentSrc || img.src);
}

async function parseExifRows(cacheKey, viewerImg) {
    if (exifMetaCache.has(cacheKey)) return exifMetaCache.get(cacheKey);
    if (exifMetaInflight.has(cacheKey)) return exifMetaInflight.get(cacheKey);

    const fileName = cacheKey.split('/').pop() || cacheKey;
    if (!canParseExifFileName(fileName)) {
        exifMetaCache.set(cacheKey, []);
        return [];
    }

    const promise = (async () => {
        const exifr = await getExifr();
        if (!exifr) {
            exifMetaCache.set(cacheKey, []);
            return [];
        }

        const options = { pick: EXIF_PARSE_PICK };
        let exif = null;

        if (canParseExifFromImageElement(viewerImg)) {
            try {
                exif = await exifr.parse(viewerImg, options);
            } catch {
                /* 无法从 img 直接读 EXIF */
            }
        }

        if (!exif) {
            try {
                const res = await apiFetch(getItemFetchUrl(cacheKey));
                if (res.ok) exif = await exifr.parse(await res.blob(), options);
            } catch {
                /* 无 EXIF 或解析失败 */
            }
        }

        const rows = buildExifRows(exif);
        exifMetaCache.set(cacheKey, rows);
        return rows;
    })().finally(() => {
        exifMetaInflight.delete(cacheKey);
    });

    exifMetaInflight.set(cacheKey, promise);
    return promise;
}

function getExifr() {
    if (!exifrPromise) {
        exifrPromise = import('https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs')
            .then(m => m.default || m)
            .catch(() => null);
    }
    return exifrPromise;
}

function formatViewerTimestamp(ts) {
    if (!ts) return '';
    const d = typeof ts === 'number' ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
}

function formatExposureTime(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (Number.isNaN(n)) return String(value);
    if (n >= 1) return `${Number(n.toFixed(2))}s`;
    const denom = Math.round(1 / n);
    return denom > 0 ? `1/${denom}s` : `${n}s`;
}

function formatAperture(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (Number.isNaN(n)) return String(value);
    const text = n.toFixed(1).replace(/\.0$/, '');
    return `f/${text}`;
}

function formatGps(lat, lng) {
    if (lat == null || lng == null) return '';
    const la = Number(lat);
    const ln = Number(lng);
    if (Number.isNaN(la) || Number.isNaN(ln)) return '';
    return `${la.toFixed(6)}, ${ln.toFixed(6)}`;
}

function getFileListItem(path) {
    return findFileItem(path);
}

function findFileItem(path) {
    const key = (path || '').replace(/^\/+/, '');
    return fileList.find(i => (i.path || '').replace(/^\/+/, '') === key);
}

async function copyViewerText(text, label = '已复制') {
    try {
        await navigator.clipboard.writeText(text);
        uiToast(label, 'success');
    } catch {
        await uiPrompt('请手动复制', { defaultValue: text, message: '浏览器不支持自动复制，请全选后复制' });
    }
}

function buildViewerAccMetaItem() {
    return `
        <div class="viewer-acc-item is-open" data-acc="meta">
            <button type="button" class="viewer-acc-head">
                <span class="viewer-acc-title">图片信息</span>
                <span class="viewer-acc-chevron icon">expand_more</span>
            </button>
            <div class="viewer-acc-body">
                <div class="info-meta" id="viewer-meta">
                    <div class="info-meta-loading">正在读取图片信息…</div>
                </div>
            </div>
        </div>`;
}

function buildViewerAccCodeItem(id, label, text, copyKey) {
    return `
        <div class="viewer-acc-item" data-acc="${id}">
            <button type="button" class="viewer-acc-head">
                <span class="viewer-acc-title">${escapeHtml(label)}</span>
                <span class="viewer-acc-chevron icon">expand_more</span>
            </button>
            <div class="viewer-acc-body">
                <div class="info-field__line">
                    <div class="info-field__code">${escapeHtml(text)}</div>
                    <button type="button" class="info-copy-btn" data-copy-key="${copyKey}" title="复制" aria-label="复制${escapeHtml(label)}">
                        <span class="icon">content_copy</span>
                    </button>
                </div>
            </div>
        </div>`;
}

function buildViewerCodeField(label, text, copyKey) {
    return `
        <div class="info-field">
            <div class="info-field__head">
                <span class="info-field__label">${escapeHtml(label)}</span>
                <button type="button" class="info-copy-btn" data-copy-key="${copyKey}" title="复制" aria-label="复制${escapeHtml(label)}">
                    <span class="icon">content_copy</span>
                </button>
            </div>
            <div class="info-field__code">${escapeHtml(text)}</div>
        </div>`;
}

async function loadViewerImageMeta(modal, normalizedPath, viewerImg) {
    const metaEl = modal.querySelector('#viewer-meta');
    if (!metaEl) return;

    const cacheKey = getExifCacheKey(normalizedPath);
    const item = findFileItem(cacheKey);
    const baseRows = buildViewerBaseRows(viewerImg, item);
    const metaSeq = String((Number(modal.dataset.metaSeq) || 0) + 1);
    modal.dataset.metaSeq = metaSeq;

    if (exifMetaCache.has(cacheKey)) {
        renderViewerMetaRows(metaEl, [...baseRows, ...exifMetaCache.get(cacheKey)]);
        return;
    }

    renderViewerMetaRows(metaEl, baseRows, { exifLoading: canParseExifFileName(cacheKey.split('/').pop()) });

    const exifRows = await parseExifRows(cacheKey, viewerImg);
    if (modal.dataset.metaSeq !== metaSeq || !metaEl.isConnected) return;
    renderViewerMetaRows(metaEl, [...baseRows, ...exifRows]);
}

async function downloadViewerImage(publicUrl, normalizedPath) {
    const fileName = normalizedPath.split('/').pop() || 'image';
    const fetchUrl = getItemFetchUrl(normalizedPath);
    uiLoadingShow('准备下载…');
    try {
        let blob;
        try {
            const res = await apiFetch(fetchUrl);
            if (!res.ok) throw new Error('fetch failed');
            blob = await res.blob();
        } catch {
            const res = await fetch(publicUrl);
            if (!res.ok) throw new Error('fetch failed');
            blob = await res.blob();
        }
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
        uiToast('开始下载', 'success');
    } catch {
        const a = document.createElement('a');
        a.href = publicUrl;
        a.download = fileName;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        uiToast('已尝试下载', 'info');
    } finally {
        uiLoadingHide();
    }
}

function bindViewerDetails(modal, normalizedPath, publicUrl, viewerImg, copyTexts) {
    modal.querySelectorAll('.info-copy-btn[data-copy-key]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyViewerText(copyTexts[btn.dataset.copyKey] || '', '已复制');
        });
    });

    modal.querySelector('#viewer-download-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadViewerImage(publicUrl, normalizedPath);
    });

    const runMeta = () => loadViewerImageMeta(modal, normalizedPath, viewerImg);
    if (viewerImg?.complete && viewerImg.naturalWidth) runMeta();
    else viewerImg?.addEventListener('load', runMeta, { once: true });
}

function showImageViewer(path) {
    const normalizedPath = (path || '').replace(/^\/+/, '');
    const fileName = normalizedPath.split('/').pop() || normalizedPath;
    const publicUrl = currentSettings.r2_public_url
        ? `${currentSettings.r2_public_url.replace(/\/$/, '')}/${normalizedPath}`
        : `/${normalizedPath}`;
    const htmlCode = `<img src="${publicUrl}" alt="${fileName.replace(/"/g, '&quot;')}" />`;
    const markdownCode = `![${fileName}](${publicUrl})`;
    const isSvg = /\.svg$/i.test(normalizedPath);
    const modal = document.createElement('div');
    modal.className = 'image-viewer active';
    
    const imgHtml = isSvg 
        ? `<div class="viewer-svg-container"><img src="${publicUrl}" alt="preview" class="viewer-svg" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="svg-viewer-fallback" style="display:none;"></div></div>`
        : `<img src="${publicUrl}" alt="preview">`;
    
    modal.innerHTML = `
        <div class="image-viewer-content layout-stack">
            <div class="close-viewer" title="关闭"><span class="icon">close</span></div>
            <div class="viewer-body">
                <div class="viewer-media">
                    <div class="viewer-media-stage">
                        <div class="viewer-media-transform">
                            ${imgHtml}
                        </div>
                    </div>
                </div>
                <div class="viewer-details">
                    <div class="image-info">
                        <div class="viewer-filename">${escapeHtml(fileName)}</div>
                        <div class="viewer-accordion">
                            ${buildViewerAccMetaItem()}
                            ${buildViewerAccCodeItem('url', '公开链接', publicUrl, 'url')}
                            ${buildViewerAccCodeItem('html', 'HTML', htmlCode, 'html')}
                            ${buildViewerAccCodeItem('md', 'Markdown', markdownCode, 'md')}
                        </div>
                        <div class="viewer-actions">
                            <button type="button" class="btn btn-filled" id="viewer-download-btn">
                                <span class="icon">download</span> 下载图片
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    lockBodyScrollForViewer();

    const contentEl = modal.querySelector('.image-viewer-content');
    const viewerImg = modal.querySelector('.viewer-media img');
    const mediaEl = modal.querySelector('.viewer-media');
    let mediaInteraction;

    const closeViewer = () => {
        contentEl._viewerLayoutCleanup?.();
        mediaInteraction?.destroy();
        if (modal._viewerKeydown) {
            document.removeEventListener('keydown', modal._viewerKeydown);
            delete modal._viewerKeydown;
        }
        unlockBodyScrollForViewer();
        modal.remove();
    };

    modal._viewerKeydown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeViewer();
        }
    };
    document.addEventListener('keydown', modal._viewerKeydown);

    mediaInteraction = bindViewerMediaInteraction(mediaEl, { onMobileTapClose: closeViewer });

    bindViewerDetails(modal, normalizedPath, publicUrl, viewerImg, {
        url: publicUrl,
        html: htmlCode,
        md: markdownCode
    });
    bindViewerAccordion(modal);
    
    if (viewerImg) {
        bindViewerImageLayout(contentEl, viewerImg, () => {
            mediaInteraction.refit();
            mediaInteraction.reset();
            loadViewerImageMeta(modal, normalizedPath, viewerImg);
        });
    }

    if (isSvg) {
        const fallbackDiv = modal.querySelector('.svg-viewer-fallback');
        const img = modal.querySelector('.viewer-svg');
        
        const timeoutId = setTimeout(() => {
            if (!img.complete || img.naturalWidth === 0) {
                loadSvgFallback(getItemLocalUrl(normalizedPath), fallbackDiv, img, contentEl, () => {
                    mediaInteraction.refit();
                    mediaInteraction.reset();
                });
            }
        }, 3000);
        
        img.onload = () => {
            clearTimeout(timeoutId);
            img.style.display = '';
            fallbackDiv.style.display = 'none';
            applyViewerLayout(contentEl, img.naturalWidth, img.naturalHeight);
            mediaInteraction.refit();
            mediaInteraction.reset();
            loadViewerImageMeta(modal, normalizedPath, img);
        };
        
        img.onerror = () => {
            clearTimeout(timeoutId);
            loadSvgFallback(getItemLocalUrl(normalizedPath), fallbackDiv, img, contentEl, () => {
                mediaInteraction.refit();
                mediaInteraction.reset();
            });
        };
    }
    
    modal.querySelector('.close-viewer').onclick = (e) => {
        e.stopPropagation();
        closeViewer();
    };
    modal.addEventListener('click', (e) => {
        if (e.target.closest('.viewer-media, .viewer-details, .close-viewer')) return;
        closeViewer();
    });
}

function loadSvgFallback(url, fallbackDiv, img, contentEl, onReady) {
    fetch(url)
        .then(res => res.text())
        .then(svgText => {
            if (svgText.includes('<svg')) {
                fallbackDiv.innerHTML = svgText;
                const svgEl = fallbackDiv.querySelector('svg');
                if (svgEl) {
                    svgEl.style.maxWidth = '100%';
                    svgEl.style.maxHeight = '80vh';
                    svgEl.style.width = 'auto';
                    svgEl.style.height = 'auto';
                    if (img) img.style.display = 'none';
                    fallbackDiv.style.display = 'flex';
                    const vb = svgEl.viewBox?.baseVal;
                    const w = vb?.width || svgEl.width?.baseVal?.value || svgEl.clientWidth;
                    const h = vb?.height || svgEl.height?.baseVal?.value || svgEl.clientHeight;
                    if (contentEl) applyViewerLayout(contentEl, w, h);
                    onReady?.();
                }
            }
        })
        .catch(() => {});
}

function contextMenuItem(action, icon, label, extraClass = '') {
    return `<div class="context-menu-item${extraClass ? ' ' + extraClass : ''}" data-action="${action}"><span class="icon context-menu-item__icon">${icon}</span><span class="context-menu-item__label">${label}</span></div>`;
}

function showCustomContextMenu(x, y, menuItems, onAction) {
    hideContextMenu();
    if (!menuItems.length) return;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = menuItems.map(i => contextMenuItem(i.action, i.icon, i.label, i.className || '')).join('')
        + `<div class="context-menu-divider"></div>${contextMenuItem('cancel', 'close', '取消')}`;
    clampContextMenuPosition(menu, x, y);
    contextMenuVisible = true;
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.action;
            hideContextMenu();
            if (action && action !== 'cancel') onAction(action);
        });
    });
    setTimeout(() => { window.addEventListener('click', hideContextMenu, { once: true }); }, 0);
}

function showAreaContextMenu(x, y) {
    const items = [{ action: 'batch-select', icon: 'checklist', label: '批量选择' }];
    if (hasUploadPerm()) items.push({ action: 'new-folder', icon: 'create_new_folder', label: '新建文件夹' });
    showCustomContextMenu(x, y, items, (action) => {
        if (action === 'batch-select') enterBatchMode();
        else if (action === 'new-folder') showNewFolderDialog();
    });
}

function showContextMenu(x, y, type) {
    hideContextMenu();
    const canUpload = hasUploadPerm();
    const item = selectedItem?.path ? (findFileItem(selectedItem.path) || selectedItem) : null;
    const canDelete = item && canDeleteItem(item);
    let items = '';
    if (type === 'file') {
        items = contextMenuItem('copy-url', 'link', '复制公开链接')
            + contextMenuItem('view-props', 'info', '查看图片属性');
        if (canUpload) {
            items += contextMenuItem('rename', 'drive_file_rename_outline', '重命名')
                + contextMenuItem('move', 'drive_file_move', '移动')
                + contextMenuItem('copy', 'file_copy', '复制');
            if (canDelete) items += contextMenuItem('delete', 'delete', '删除', 'context-menu-item--danger');
        }
    } else if (type === 'dir' && canUpload) {
        items = contextMenuItem('rename', 'drive_file_rename_outline', '重命名')
            + contextMenuItem('move', 'drive_file_move', '移动')
            + contextMenuItem('copy', 'file_copy', '复制');
        if (canDelete) items += contextMenuItem('delete', 'delete', '删除', 'context-menu-item--danger');
    }
    if (!items) return;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = items + `<div class="context-menu-divider"></div>${contextMenuItem('cancel', 'close', '取消')}`;
    clampContextMenuPosition(menu, x, y);
    contextMenuVisible = true;
    menu.querySelectorAll('.context-menu-item').forEach(item=>{
        item.addEventListener('click',async ()=>{
            const action=item.dataset.action;
            hideContextMenu();
            if(action==='copy-url'){
                const url = currentSettings.r2_public_url ? `${currentSettings.r2_public_url}/${selectedItem.path}` : `/${selectedItem.path}`;
                await navigator.clipboard.writeText(url);
                uiToast('链接已复制', 'success');
            }             else if(action==='view-props') showImageViewer(selectedItem.path);
            else if(action==='rename') showRenameDialog(selectedItem.path);
            else if(action==='move') showMoveDialog(selectedItem.path);
            else if(action==='copy') showCopyDialog(selectedItem.path);
            else if(action==='delete'){
                if(await uiConfirm(`确定删除 ${selectedItem.path} 吗？`, { danger: true, confirmText: '删除' })){
                    const delRes = await apiFetch(`${API_BASE}/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:selectedItem.path})});
                    if (delRes.ok) {
                        await refreshGalleryAfterMutation({ removePath: selectedItem.path });
                        uiToast('删除成功', 'success');
                    } else {
                        const err = await delRes.json().catch(() => ({}));
                        uiToast('删除失败' + (err.error ? '：' + err.error : ''), 'error');
                    }
                }
            }
        });
    });
    setTimeout(()=>{ window.addEventListener('click',hideContextMenu,{once:true}); },0);
}
function hideContextMenu(){ const m=document.querySelector('.context-menu'); if(m) m.remove(); contextMenuVisible=false; }

async function showNewFolderDialog(){
    if (!hasUploadPerm()) { uiToast('您没有上传权限', 'error'); return; }
    const name = await uiPrompt('新建文件夹', { placeholder: '请输入文件夹名称' });
    if(!name) return;
    const trimmed = name.trim();
    if (!trimmed) { uiToast('名称不能为空', 'error'); return; }
    if (/[/\\]/.test(trimmed)) { uiToast('名称不能包含 / 或 \\', 'error'); return; }
    const base = normalizeCurrentPath(currentPath);
    const folderPath = base === '/' ? `/${trimmed}` : `${base}/${trimmed}`;
    const res = await apiFetch(`${API_BASE}/mkdir`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:folderPath})});
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
        uiToast('文件夹已创建', 'success');
        await refreshGalleryAfterMutation({
            path: base,
            addItem: data.folder || { path: normalizeCurrentPath(folderPath), name: trimmed, parent: base, type: 'dir' }
        });
    } else {
        uiToast('创建失败' + (data.error ? '：' + data.error : ''), 'error');
    }
}
async function showRenameDialog(sourcePath) {
    if (!hasUploadPerm()) { uiToast('您没有上传权限', 'error'); return; }
    const item = fileList.find(i => i.path === sourcePath) || selectedItem;
    const currentName = item?.name || sourcePath.split('/').pop() || '';
    const newName = await uiPrompt('重命名', { placeholder: '请输入新名称', defaultValue: currentName });
    if (!newName) return;
    const trimmed = newName.trim();
    if (!trimmed) { uiToast('名称不能为空', 'error'); return; }
    if (trimmed === currentName) return;
    if (/[/\\]/.test(trimmed)) { uiToast('名称不能包含 / 或 \\', 'error'); return; }
    uiLoadingShow('重命名中…');
    try {
        const res = await apiFetch(`${API_BASE}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: sourcePath, newName: trimmed })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            uiToast('重命名成功', 'success');
            let nextPath = currentPath;
            if (item?.type === 'dir' && data.path) {
                const oldDir = normalizeCurrentPath(sourcePath);
                const cur = normalizeCurrentPath(currentPath);
                if (cur === oldDir || cur.startsWith(oldDir + '/')) {
                    nextPath = normalizeCurrentPath(data.path + cur.slice(oldDir.length));
                }
            }
            await refreshGalleryAfterMutation({
                path: nextPath,
                patch: data.path ? { oldPath: sourcePath, newPath: data.path, newName: trimmed } : null
            });
        } else {
            uiToast('重命名失败' + (data.error ? '：' + data.error : ''), 'error');
        }
    } catch {
        uiToast('重命名失败', 'error');
    } finally {
        uiLoadingHide();
    }
}

async function showMoveDialog(sourcePath){
    const sourceType = selectedItem?.path === sourcePath ? selectedItem.type : (fileList.find(i => i.path === sourcePath)?.type || 'file');
    const picked = await showFolderPicker({
        title: '选择目标文件夹',
        icon: 'drive_file_move',
        sourcePath,
        sourceType,
        defaultPath: normalizeCurrentPath(currentPath),
        showOverwrite: true
    });
    if (!picked) return;
    const res = await apiFetch(`${API_BASE}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath, targetDir: picked.targetDir, overwrite: picked.overwrite })
    });
    if (res.ok) {
        uiToast('移动成功', 'success');
        const sourceParent = getItemParentPath(sourcePath, sourceType);
        const refreshPath = normalizeCurrentPath(currentPath);
        const removePath = sourceParent === refreshPath ? sourcePath : null;
        await refreshGalleryAfterMutation({ path: refreshPath, removePath });
    } else {
        const err = await res.json().catch(() => ({}));
        uiToast('移动失败' + (err.error ? '：' + err.error : ''), 'error');
    }
}
async function showCopyDialog(sourcePath){
    const sourceType = selectedItem?.path === sourcePath ? selectedItem.type : (fileList.find(i => i.path === sourcePath)?.type || 'file');
    const picked = await showFolderPicker({
        title: '选择目标文件夹',
        icon: 'content_copy',
        sourcePath,
        sourceType,
        defaultPath: normalizeCurrentPath(currentPath),
        showOverwrite: true
    });
    if (!picked) return;
    const res = await apiFetch(`${API_BASE}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath, targetDir: picked.targetDir, overwrite: picked.overwrite })
    });
    if (res.ok) {
        uiToast('复制成功', 'success');
        await refreshGalleryAfterMutation();
    } else {
        const err = await res.json().catch(() => ({}));
        uiToast('复制失败' + (err.error ? '：' + err.error : ''), 'error');
    }
}

async function renderManagePage(){
    if(!hasManagePerm()){ uiToast('无权限', 'error'); renderGalleryPage(); return; }
    const panelRes = await apiFetch(`${API_BASE}/manage-panel`);
    if (!panelRes.ok) { uiToast('加载失败', 'error'); renderGalleryPage(); return; }
    const { stats, settings, users, canManageUsers } = await panelRes.json();
    currentSettings = settings;
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="app-bar">
            <div class="actions">
                <button class="btn btn-text" id="back-gallery">← 返回图库</button>
                <button class="btn btn-text" id="refresh-index" title="增量同步 R2 与数据库；Shift+点击为全量重建">刷新索引</button>
                <button class="btn btn-text" id="export-settings">导出设置</button>
                <button class="btn btn-text" id="import-settings">导入设置</button>
            </div>
        </div>
        <div class="manage-container">
            <h2 style="font-size: 24px; font-weight: 700; margin-bottom: 24px; background: linear-gradient(135deg, #00d4ff 0%, #7c3aed 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">管理面板</h2>
            
            <div class="manage-section">
                <h3>统计信息</h3>
                <div class="stats-grid">
                    <div class="stat-item"><div class="stat-value">${stats.folderCount}</div><div class="stat-label">文件夹</div></div>
                    <div class="stat-item"><div class="stat-value">${stats.fileCount}</div><div class="stat-label">图片</div></div>
                    <div class="stat-item"><div class="stat-value">${(stats.totalSize/1024/1024).toFixed(2)}</div><div class="stat-label">总大小 (MB)</div></div>
                </div>
            </div>

            <div class="manage-section">
                <h3>个人资料</h3>
                <div class="form-group"><label>昵称</label><input type="text" id="profile-nickname" value="${currentUser.nickname||''}" placeholder="请输入昵称"></div>
                <div class="form-group"><label>新密码</label><input type="password" id="profile-password" placeholder="留空表示不修改"></div>
                <button class="btn btn-filled" id="update-profile">更新资料</button>
            </div>

            <div class="manage-section">
                <h3>站点设置</h3>
                <div class="form-group"><label>网站标题</label><input type="text" id="site-title" value="${settings.site_title||''}" placeholder="请输入网站标题"></div>
                <div class="form-group"><label>Logo URL</label><input type="text" id="site-logo" value="${settings.site_logo||''}" placeholder="请输入Logo地址"></div>
                <div class="form-group"><label>背景图URL</label><input type="text" id="site-bg" value="${settings.site_bg||''}" placeholder="请输入背景图地址"></div>
                <div class="form-group"><label>页脚HTML</label><textarea id="footer-html" rows="4" placeholder="请输入页脚HTML内容">${settings.footer_html||''}</textarea></div>
                <div class="form-group"><label>R2公开链接</label><input type="text" id="r2-public-url" value="${settings.r2_public_url||''}" placeholder="https://your-bucket.r2.dev"></div>
                <button class="btn btn-filled" id="save-settings">保存设置</button>
            </div>

            <div class="manage-section">
                <h3>登录防暴力（Fail2ban）</h3>
                <p style="font-size:12px; color: var(--text-secondary); margin-bottom: 12px;">按 IP 统计失败登录次数，超过阈值后临时或永久封禁。</p>
                <div class="form-group"><label>统计窗口（秒）</label><input type="number" id="login-ban-window" min="60" value="${settings.login_ban_window_sec ?? 900}" placeholder="900"></div>
                <div class="form-group"><label>最大失败次数</label><input type="number" id="login-ban-max" min="1" value="${settings.login_ban_max_attempts ?? 5}" placeholder="5"></div>
                <div class="form-group"><label>封禁时长（秒，0=永久）</label><input type="number" id="login-ban-duration" min="0" value="${settings.login_ban_duration_sec ?? 3600}" placeholder="3600"></div>
                <button class="btn btn-filled" id="save-ban-settings">保存防暴力设置</button>
            </div>

            ${canManageUsers ? `<div class="manage-section">
                <h3>用户管理</h3>
                <button class="btn btn-outlined" id="add-user-btn">添加用户</button>
                <table class="user-table">
                    <thead><tr><th>用户名</th><th>昵称</th><th>角色</th><th>权限</th><th>操作</th></tr></thead>
                    <tbody id="user-list"></tbody>
                </table>
            </div>` : ''}
        </div>
    `;
    if (canManageUsers) {
    const tbody = document.getElementById('user-list');
    tbody.innerHTML = users.map(u=>{
        const ops = [];
        if (u.role !== 'admin') ops.push(`<button class="btn btn-text perm-edit-btn" data-user-id="${u.id}">更改权限</button>`);
        if (u.id !== currentUser.id) ops.push(`<button class="btn btn-text" style="color: #ff4757;" data-user-id="${u.id}" data-action="delete">删除</button>`);
        return `<tr>
            <td>${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.nickname)}</td>
            <td>${u.role}</td>
            <td class="perm-cell">${renderPermBadges(u)}</td>
            <td class="user-actions">${ops.join(' ') || '—'}</td>
        </tr>`;
    }).join('');
    document.querySelectorAll('[data-user-id][data-action="delete"]').forEach(btn=>{ btn.onclick=async()=>{ if(await uiConfirm('确定删除该用户？', { danger: true, confirmText: '删除' })){ await runWithLoading('删除用户中，请稍候', async () => { const res = await apiFetch(`${API_BASE}/user`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:btn.dataset.userId})}); if (res.ok) { uiToast('用户已删除', 'success'); await renderManagePage(); } else uiToast('删除失败', 'error'); }); } }; });
    document.querySelectorAll('.perm-edit-btn').forEach(btn=>{
        btn.onclick = async () => {
            const user = users.find(u => String(u.id) === btn.dataset.userId);
            if (!user) return;
            const perms = await showEditPermissionsDialog(user);
            if (!perms) return;
            await runWithLoading('更新权限中，请稍候', async () => {
                const res = await apiFetch(`${API_BASE}/user`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: user.id, perm_upload: perms.perm_upload, perm_view: perms.perm_view, perm_manage: perms.perm_manage })
                });
                if (res.ok) {
                    uiToast('权限已更新', 'success');
                    await renderManagePage();
                } else {
                    const err = await res.json().catch(() => ({}));
                    uiToast('更新失败' + (err.error ? '：' + err.error : ''), 'error');
                }
            });
        };
    });
    document.getElementById('add-user-btn').onclick=showAddUserDialog;
    }
    document.getElementById('back-gallery').onclick=()=>renderGalleryPage();
    document.getElementById('refresh-index').onclick = async (e) => {
        const full = e.shiftKey;
        if (full && !(await uiConfirm('全量重建将清空并重建全部索引，图片较多时耗时较长，确定继续？'))) return;
        await runWithLoading(full ? '全量重建中，请稍候' : '同步索引中，请稍候', async () => {
            const url = full ? `${API_BASE}/refresh-index?mode=full` : `${API_BASE}/refresh-index`;
            const res = await apiFetch(url, { method: 'POST' });
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                await renderManagePage();
                const parts = [];
                if (data.mode === 'full') {
                    if (data.filesIndexed) parts.push(`重建 ${data.filesIndexed} 个文件`);
                } else {
                    if (data.added) parts.push(`新增 ${data.added}`);
                    if (data.updated) parts.push(`更新 ${data.updated}`);
                    if (data.removed) parts.push(`删除 ${data.removed}`);
                    if (data.removedDirs) parts.push(`清理文件夹 ${data.removedDirs}`);
                    if (!data.added && !data.updated && !data.removed && !data.removedDirs) parts.push('无变更');
                }
                if (data.hashBackfilled) parts.push(`回填 hash ${data.hashBackfilled}`);
                if (data.hashPending) parts.push(`待回填 ${data.hashPending}`);
                uiToast(parts.length ? `索引已同步：${parts.join('，')}` : '索引已是最新', 'success');
            } else {
                uiToast('刷新失败', 'error');
            }
        });
    };
    document.getElementById('export-settings').onclick=()=>window.location.href=`${API_BASE}/settings/export`;
    document.getElementById('import-settings').onclick=()=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='application/json'; inp.onchange=async(e)=>{ const file=e.target.files[0]; if (!file) return; await runWithLoading('导入设置中，请稍候', async () => { try { const text=await file.text(); const json=JSON.parse(text); const res=await apiFetch(`${API_BASE}/settings/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(json)}); if (res.ok) { uiToast('导入成功', 'success'); await renderManagePage(); } else uiToast('导入失败', 'error'); } catch { uiToast('导入失败，文件格式无效', 'error'); } }); }; inp.click(); };
    document.getElementById('update-profile').onclick=async()=>{ const nickname=document.getElementById('profile-nickname').value; const password=document.getElementById('profile-password').value; const body={nickname}; if(password) body.password=password; await runWithLoading('更新资料中，请稍候', async () => { const res=await apiFetch(`${API_BASE}/user/profile`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(res.ok){ const data=await res.json(); if(data.token) setAuthToken(data.token); if(data.user) currentUser=data.user; uiToast('更新成功', 'success'); await renderManagePage(); } else uiToast('更新失败', 'error'); }); };
    document.getElementById('save-settings').onclick=async()=>{ const newSettings={ site_title:document.getElementById('site-title').value, site_logo:document.getElementById('site-logo').value, site_bg:document.getElementById('site-bg').value, footer_html:document.getElementById('footer-html').value, r2_public_url:document.getElementById('r2-public-url').value }; await runWithLoading('保存设置中，请稍候', async () => { const res=await apiFetch(`${API_BASE}/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(newSettings)}); if (res.ok) { uiToast('设置已保存', 'success'); await loadSettings(); await renderManagePage(); } else uiToast('保存失败', 'error'); }); };
    document.getElementById('save-ban-settings').onclick=async()=>{ const newSettings={ login_ban_window_sec: parseInt(document.getElementById('login-ban-window').value,10)||900, login_ban_max_attempts: parseInt(document.getElementById('login-ban-max').value,10)||5, login_ban_duration_sec: parseInt(document.getElementById('login-ban-duration').value,10) }; await runWithLoading('保存防暴力设置中，请稍候', async () => { const res=await apiFetch(`${API_BASE}/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(newSettings)}); if (res.ok) { uiToast('防暴力设置已保存', 'success'); await loadSettings(); await renderManagePage(); } else uiToast('保存失败', 'error'); }); };
}

async function showAddUserDialog() {
    const username = await uiPrompt('添加用户', { placeholder: '用户名' });
    if (!username) return;
    const password = await uiPrompt('添加用户', { message: `为用户 ${username} 设置密码`, inputType: 'password', placeholder: '密码' });
    if (!password) return;
    const role = await uiPrompt('添加用户', { message: '设置角色', defaultValue: 'guest', placeholder: 'admin 或 guest' });
    if (!role) return;
    await runWithLoading('添加用户中，请稍候', async () => {
        const res = await apiFetch(`${API_BASE}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role }) });
        if (res.ok) {
            uiToast('用户已添加', 'success');
            await renderManagePage();
        } else {
            const err = await res.json().catch(() => ({}));
            uiToast('添加失败' + (err.error ? '：' + err.error : ''), 'error');
        }
    });
}

function escapeHtml(str){ if(!str) return ''; return str.replace(/[&<>]/g,function(m){if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }