// app.js - 完整前端逻辑（含所有上传方式）
const API_BASE = '/api';
let currentUser = null;
let currentPath = '/';
let fileList = [];
let selectedItem = null;
let contextMenuVisible = false;
let currentSettings = {};
let sortField = 'name';
let sortDirection = 'asc';
const filesListCache = new Map();
const filesListInflight = new Map();
const FILES_CACHE_TTL = 60_000;

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

function hasUploadPerm() {
    return currentUser && (currentUser.role === 'admin' || Number(currentUser.perm_upload) === 1);
}

function hasViewPerm() {
    return currentUser && (currentUser.role === 'admin' || Number(currentUser.perm_view) === 1);
}

function normalizeCurrentPath(path) {
    if (path == null || path === '' || path === 'undefined' || path === 'null') return '/';
    let p = String(path).trim().replace(/\\/g, '/');
    if (!p.startsWith('/')) p = '/' + p;
    p = p.replace(/\/+/g, '/').replace(/\/$/, '');
    return p || '/';
}

function renderPermBadges(user, disabled = true) {
    const dis = disabled ? ' disabled' : '';
    const uploadChecked = Number(user.perm_upload) === 1 ? ' checked' : '';
    const viewChecked = Number(user.perm_view) === 1 ? ' checked' : '';
    return `<label class="perm-badge"><input type="checkbox"${dis}${viewChecked}><span>查看</span></label>
        <label class="perm-badge"><input type="checkbox"${dis}${uploadChecked}><span>上传</span></label>`;
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
                perm_upload: overlay.querySelector('#perm-upload-edit').checked
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
        const res = await fetch(`${API_BASE}/folders`);
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
    await checkInstallAndRender();
});

// ------------------- 安装/登录/初始化 -------------------
async function checkInstallAndRender() {
    const res = await fetch(`${API_BASE}/install-check`);
    const data = await res.json();
    if (data.needInstall) {
        renderInstallPage();
        return;
    }
    const boot = await fetchBootstrap('/');
    if (boot?.user) {
        currentUser = boot.user;
        applySettings(boot.settings);
        renderGalleryPage(boot.files);
    } else {
        renderLoginPage();
    }
}

async function fetchBootstrap(parent = '/') {
    try {
        const res = await fetch(`${API_BASE}/bootstrap?parent=${encodeURIComponent(parent)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
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
        const res = await fetch(`${API_BASE}/install`, {
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
                <div class="auth-form">
                    <div class="form-group"><label>账号</label><input type="text" id="login-username" placeholder="请输入用户名"></div>
                    <div class="form-group"><label>密码</label><input type="password" id="login-password" placeholder="请输入密码"></div>
                    <button class="btn btn-filled auth-btn" id="login-btn">登录</button>
                </div>
            </div>
        </div>
    `;
    document.getElementById('login-btn').onclick = async () => {
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (res.ok) {
            const data = await res.json();
            currentUser = data.user;
            const boot = await fetchBootstrap('/');
            if (boot) {
                currentUser = boot.user;
                applySettings(boot.settings);
                renderGalleryPage(boot.files);
            } else {
                await loadSettings();
                renderGalleryPage();
            }
        } else {
            const err = await res.json().catch(() => ({}));
            uiToast('登录失败' + (err.error ? '：' + err.error : ''), 'error');
        }
    };
}

async function loadUser() {
    try {
        const res = await fetch(`${API_BASE}/user/profile`);
        if (res.ok) currentUser = await res.json();
        else currentUser = null;
    } catch(e) { currentUser = null; }
}

async function loadSettings() {
    try {
        const res = await fetch(`${API_BASE}/settings`);
        if (res.ok) applySettings(await res.json());
    } catch(e) {}
}

// ------------------- 图库页面 -------------------
function renderGalleryPage(initialFiles = null) {
    const app = document.getElementById('app');
    const canUpload = hasUploadPerm();
    const canView = hasViewPerm();
    app.innerHTML = `
        <div class="app-bar">
            <div class="breadcrumb" id="breadcrumb"></div>
            <div class="actions">
                ${canUpload ? `<button class="btn btn-text" id="upload-btn"><span class="icon">upload</span> 上传</button>
                <button class="btn btn-text" id="new-folder-btn"><span class="icon">create_new_folder</span> 新建文件夹</button>` : ''}
                <button class="btn btn-text" id="refresh-btn"><span class="icon">refresh</span> 刷新</button>
                ${currentUser && currentUser.role === 'admin' ? `<button class="btn btn-text" id="manage-btn"><span class="icon">settings</span> 管理</button>` : ''}
                <button class="btn btn-text" id="logout-btn"><span class="icon">logout</span> 退出</button>
            </div>
        </div>
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
    `;
    if (canUpload) {
        document.getElementById('upload-btn').onclick = () => { const input = document.createElement('input'); input.type='file'; input.multiple=true; input.accept='image/*'; input.onchange=e=>uploadFiles(Array.from(input.files)); input.click(); };
        document.getElementById('new-folder-btn').onclick = () => showNewFolderDialog();
    }
    document.getElementById('refresh-btn').onclick = () => loadFiles(currentPath, { force: true });
    const manageBtn = document.getElementById('manage-btn');
    if (manageBtn) manageBtn.onclick = () => renderManagePage();
    document.getElementById('logout-btn').onclick = async () => { await fetch(`${API_BASE}/logout`,{method:'POST'}); currentUser=null; renderLoginPage(); };
    document.getElementById('sort-field').onchange = (e) => { sortField = e.target.value; renderFileGrid(); };
    document.getElementById('sort-direction').onchange = (e) => { sortDirection = e.target.value; renderFileGrid(); };
    window.addEventListener('click', hideContextMenu);
    if (canUpload) {
        initDragAndDrop();
        initPasteUpload();
    }
    if (!canView) {
        fileList = [];
        renderBreadcrumb();
        const grid = document.getElementById('file-grid');
        if (grid) grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:40px; color: var(--text-secondary);">您没有查看权限</div>';
    } else if (initialFiles) {
        fileList = initialFiles;
        filesListCache.set('/', { data: initialFiles, ts: Date.now() });
        renderBreadcrumb();
        renderFileGrid();
    } else {
        loadFiles(currentPath);
    }
    syncFooterSpacer();
}

function initDragAndDrop() {
    const grid = document.getElementById('file-grid');
    if (!grid) return;
    grid.addEventListener('dragover', (e) => { e.preventDefault(); grid.style.opacity='0.7'; });
    grid.addEventListener('dragleave', () => { grid.style.opacity='1'; });
    grid.addEventListener('drop', async (e) => {
        e.preventDefault();
        grid.style.opacity='1';
        const files = Array.from(e.dataTransfer.files);
        if (files.length) await uploadFiles(files);
    });
}

function initPasteUpload() {
    window.addEventListener('paste', async (e) => {
        const items = e.clipboardData.items;
        const files = [];
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length) {
            await uploadFiles(files);
            return;
        }
        const plainText = e.clipboardData.getData('text/plain');
        if (plainText && (plainText.startsWith('http://') || plainText.startsWith('https://'))) {
            const imageExt = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)(\?.*)?$/i;
            if (imageExt.test(plainText)) {
                const url = plainText;
                try {
                    const resp = await fetch(url);
                    const blob = await resp.blob();
                    if (blob.type.startsWith('image/')) {
                        const fileName = url.split('/').pop().split('?')[0] || 'pasted.jpg';
                        const file = new File([blob], fileName, { type: blob.type });
                        await uploadFiles([file]);
                    } else {
                        uiToast('链接不是有效的图片', 'error');
                    }
                } catch(err) {
                    uiToast('下载图片失败：' + err.message, 'error');
                }
            } else {
                uiToast('请粘贴图片链接（以 .jpg / .png 等结尾）', 'error');
            }
        }
    });
}

async function uploadFiles(files) {
    if (!hasUploadPerm()) { uiToast('您没有上传权限', 'error'); return; }
    if (!files || files.length === 0) return;
    if (files.length > 100) { uiToast('单次最多上传 100 张', 'error'); return; }
    for (const f of files) {
        if (f.size > 20 * 1024 * 1024) { uiToast(`文件 ${f.name} 超过 20MB`, 'error'); return; }
    }
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    formData.append('targetDir', normalizeCurrentPath(currentPath));
    const progressDiv = document.getElementById('upload-progress');
    progressDiv.style.display = 'block';
    progressDiv.innerHTML = '<div>上传中...</div>';
    const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData });
    const result = await res.json();
    let html = '';
    for (const r of result.results) {
        if (r.success) html += `<div class="upload-item">✅ ${r.name} 成功 <a href="${r.url}" target="_blank">链接</a></div>`;
        else html += `<div class="upload-item upload-error">❌ ${r.name} 失败: ${r.error}</div>`;
    }
    progressDiv.innerHTML = html;
    setTimeout(() => { progressDiv.style.display = 'none'; }, 5000);
    invalidateFilesListCache();
    loadFiles(currentPath, { force: true });
}

function invalidateFilesListCache() {
    filesListCache.clear();
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
    currentPath = normalizeCurrentPath(path);
    const cacheKey = currentPath;
    const cached = filesListCache.get(cacheKey);

    if (!force && cached && Date.now() - cached.ts < FILES_CACHE_TTL) {
        fileList = cached.data;
        renderBreadcrumb();
        renderFileGrid();
        return;
    }

    if (!force && cached) {
        fileList = cached.data;
        renderBreadcrumb();
        renderFileGrid();
    } else {
        showGridLoading();
    }

    if (filesListInflight.has(cacheKey)) {
        await filesListInflight.get(cacheKey);
        return;
    }

    const promise = (async () => {
        try {
            const res = await fetch(`${API_BASE}/files?parent=${encodeURIComponent(cacheKey)}`);
            const items = await res.json();
            filesListCache.set(cacheKey, { data: items, ts: Date.now() });
            if (normalizeCurrentPath(currentPath) === cacheKey) {
                fileList = items;
                renderBreadcrumb();
                renderFileGrid();
            }
        } finally {
            filesListInflight.delete(cacheKey);
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

function getItemUrl(item) {
    const path = (item.path || '').replace(/^\/+/, '');
    if (currentSettings.r2_public_url) {
        return `${currentSettings.r2_public_url.replace(/\/$/, '')}/${path}`;
    }
    return `/${path}`;
}

function getPreviewHtml(item) {
    if (item.type === 'dir') {
        return '<span class="icon" style="font-size:48px;">folder</span>';
    }
    if (isImageItem(item)) {
        const svgClass = isSvgItem(item) ? ' is-svg' : '';
        return `<div class="preview-loader" aria-hidden="true">${PREVIEW_LOADER_HTML}</div><img class="preview-img${svgClass}" src="${getItemUrl(item)}" loading="lazy" alt="${escapeHtml(item.name)}">`;
    }
    return '<span class="icon" style="font-size:48px;">insert_drive_file</span>';
}

function initPreviewImages() {
    document.querySelectorAll('.file-preview--image').forEach(preview => {
        const img = preview.querySelector('.preview-img');
        const loader = preview.querySelector('.preview-loader');
        if (!img) return;

        const isSvg = img.classList.contains('is-svg');
        const imgUrl = img.src;

        const showError = () => {
            if (loader) loader.remove();
            // 对于 SVG，尝试用 fetch 方式获取并渲染
            if (isSvg) {
                fetch(imgUrl)
                    .then(res => res.text())
                    .then(svgText => {
                        if (svgText.includes('<svg')) {
                            const svgContainer = document.createElement('div');
                            svgContainer.className = 'svg-fallback';
                            svgContainer.innerHTML = svgText;
                            const svgEl = svgContainer.querySelector('svg');
                            if (svgEl) {
                                svgEl.style.width = '100%';
                                svgEl.style.height = '100%';
                                img.replaceWith(svgContainer);
                            } else {
                                showBrokenIcon();
                            }
                        } else {
                            showBrokenIcon();
                        }
                    })
                    .catch(() => showBrokenIcon());
            } else {
                showBrokenIcon();
            }
        };

        const showBrokenIcon = () => {
            const fallback = document.createElement('span');
            fallback.className = 'icon';
            fallback.style.fontSize = '48px';
            fallback.textContent = 'broken_image';
            img.replaceWith(fallback);
        };

        const reveal = () => {
            img.classList.add('is-loaded');
            if (loader) {
                loader.classList.add('is-hidden');
                setTimeout(() => loader.remove(), 350);
            }
        };

        // SVG 特殊处理：设置更长的超时时间
        if (isSvg) {
            img.onerror = () => {
                // SVG img 加载失败，尝试 fetch 方式
                showError();
            };
            img.onload = reveal;
            
            // SVG 可能不会触发 onload/onerror，添加超时检测
            setTimeout(() => {
                if (!img.classList.contains('is-loaded') && loader) {
                    // 检查图片是否实际已加载
                    if (img.complete && img.naturalWidth !== 0) {
                        reveal();
                    } else {
                        // 尝试 fetch 方式获取 SVG
                        showError();
                    }
                }
            }, 3000);
        } else {
            img.onerror = showBrokenIcon;
            img.onload = reveal;
            if (img.complete) {
                if (img.naturalWidth + img.naturalHeight > 0) {
                    reveal();
                } else {
                    showBrokenIcon();
                }
            }
        }
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
    if (items.length===0) { grid.innerHTML='<div style="grid-column:1/-1; text-align:center; padding:40px;">空文件夹</div>'; return; }
    const canUpload = hasUploadPerm();
    grid.innerHTML = items.map(item => `
        <div class="file-card" data-path="${escapeHtml(item.path || '')}" data-type="${item.type}">
            ${canUpload || item.type === 'file' ? `<button class="file-card-menu" type="button" aria-label="更多操作" data-path="${escapeHtml(item.path || '')}" data-type="${item.type}">
                <span class="icon">more_vert</span>
            </button>` : ''}
            <div class="file-preview${isImageItem(item) ? ' file-preview--image' : ''}">${getPreviewHtml(item)}</div>
            <div class="file-name">${escapeHtml(item.name)}</div>
        </div>
    `).join('');
    initPreviewImages();
    document.querySelectorAll('.file-card').forEach(card=>{
        card.addEventListener('click',(e)=>{
            if (e.target.closest('.file-card-menu')) return;
            e.stopPropagation();
            const path=card.dataset.path, type=card.dataset.type;
            if(type==='dir') loadFiles(path);
            else showImageViewer(path);
        });
        card.addEventListener('contextmenu',(e)=>{
            e.preventDefault();
            e.stopPropagation();
            selectedItem={path:card.dataset.path, type:card.dataset.type};
            showContextMenu(e.clientX,e.clientY,card.dataset.type);
        });
        initLongPress(card, () => {
            selectedItem = { path: card.dataset.path, type: card.dataset.type };
            const rect = card.getBoundingClientRect();
            showContextMenu(rect.left + rect.width / 2, rect.top + 20, card.dataset.type);
        });
    });
    document.querySelectorAll('.file-card-menu').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedItem = { path: btn.dataset.path, type: btn.dataset.type };
            const rect = btn.getBoundingClientRect();
            showContextMenu(rect.left, rect.bottom + 4, btn.dataset.type);
        });
    });
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

function showImageViewer(path) {
    const normalizedPath = (path || '').replace(/^\/+/, '');
    const publicUrl = currentSettings.r2_public_url
        ? `${currentSettings.r2_public_url.replace(/\/$/, '')}/${normalizedPath}`
        : `/${normalizedPath}`;
    const isSvg = /\.svg$/i.test(normalizedPath);
    const modal = document.createElement('div');
    modal.className = 'image-viewer active';
    
    const imgHtml = isSvg 
        ? `<div class="viewer-svg-container"><img src="${publicUrl}" alt="preview" class="viewer-svg" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="svg-viewer-fallback" style="display:none;"></div></div>`
        : `<img src="${publicUrl}" alt="preview">`;
    
    modal.innerHTML = `
        <div class="image-viewer-content">
            ${imgHtml}
            <div class="image-info">
                <div>名称: ${normalizedPath.split('/').pop()}</div>
                <div>路径: ${normalizedPath}</div>
                <div>公开链接: <a href="${publicUrl}" target="_blank">${publicUrl}</a></div>
            </div>
            <div class="viewer-actions">
                <button class="btn btn-filled" id="copy-url-btn"><span class="icon">content_copy</span> 复制链接</button>
            </div>
            <div class="close-viewer"><span class="icon">close</span></div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#copy-url-btn').onclick = async () => {
        try {
            await navigator.clipboard.writeText(publicUrl);
            uiToast('链接已复制', 'success');
        } catch {
            await uiPrompt('请手动复制链接', { defaultValue: publicUrl, message: '浏览器不支持自动复制，请全选后复制' });
        }
    };
    
    // SVG fallback 处理
    if (isSvg) {
        const fallbackDiv = modal.querySelector('.svg-viewer-fallback');
        const img = modal.querySelector('.viewer-svg');
        
        // 添加超时检测
        const timeoutId = setTimeout(() => {
            if (!img.complete || img.naturalWidth === 0) {
                loadSvgFallback(publicUrl, fallbackDiv, img);
            }
        }, 3000);
        
        img.onload = () => {
            clearTimeout(timeoutId);
            img.style.display = '';
            fallbackDiv.style.display = 'none';
        };
        
        img.onerror = () => {
            clearTimeout(timeoutId);
            loadSvgFallback(publicUrl, fallbackDiv, img);
        };
    }
    
    modal.querySelector('.close-viewer').onclick = () => modal.remove();
    modal.onclick = (e) => { if(e.target===modal) modal.remove(); };
}

function loadSvgFallback(url, fallbackDiv, img) {
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
                }
            }
        })
        .catch(() => {});
}

function showContextMenu(x, y, type) {
    hideContextMenu();
    const canUpload = hasUploadPerm();
    let items = '';
    if (type === 'file') {
        items = `<div class="context-menu-item" data-action="copy-url">复制公开链接</div>
            <div class="context-menu-item" data-action="view-props">查看图片属性</div>`;
        if (canUpload) {
            items += `<div class="context-menu-item" data-action="move">移动</div>
                <div class="context-menu-item" data-action="copy">复制</div>
                <div class="context-menu-item" data-action="delete">删除</div>`;
        }
    } else if (type === 'dir' && canUpload) {
        items = `<div class="context-menu-item" data-action="move">移动</div>
            <div class="context-menu-item" data-action="copy">复制</div>
            <div class="context-menu-item" data-action="delete">删除</div>`;
    }
    if (!items) return;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = items + `<div class="context-menu-divider"></div><div class="context-menu-item" data-action="cancel">取消</div>`;
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
            } else if(action==='view-props') showImageViewer(selectedItem.path);
            else if(action==='move') showMoveDialog(selectedItem.path);
            else if(action==='copy') showCopyDialog(selectedItem.path);
            else if(action==='delete'){
                if(await uiConfirm(`确定删除 ${selectedItem.path} 吗？`, { danger: true, confirmText: '删除' })){
                    await fetch(`${API_BASE}/delete`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:selectedItem.path})});
                    invalidateFilesListCache();
                    loadFiles(currentPath, { force: true });
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
    const base = normalizeCurrentPath(currentPath);
    const folderPath = base === '/' ? `/${name}` : `${base}/${name}`;
    const res = await fetch(`${API_BASE}/mkdir`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:folderPath})});
    if (res.ok) {
        uiToast('文件夹已创建', 'success');
        invalidateFilesListCache();
        loadFiles(folderPath);
    } else {
        const err = await res.json().catch(() => ({}));
        uiToast('创建失败' + (err.error ? '：' + err.error : ''), 'error');
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
    const res = await fetch(`${API_BASE}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath, targetDir: picked.targetDir, overwrite: picked.overwrite })
    });
    if (res.ok) {
        uiToast('移动成功', 'success');
        invalidateFilesListCache();
        loadFiles(currentPath, { force: true });
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
    const res = await fetch(`${API_BASE}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath, targetDir: picked.targetDir, overwrite: picked.overwrite })
    });
    if (res.ok) {
        uiToast('复制成功', 'success');
        invalidateFilesListCache();
        loadFiles(currentPath, { force: true });
    } else {
        const err = await res.json().catch(() => ({}));
        uiToast('复制失败' + (err.error ? '：' + err.error : ''), 'error');
    }
}

async function renderManagePage(){
    if(!currentUser || currentUser.role!=='admin'){ uiToast('无权限', 'error'); renderGalleryPage(); return; }
    const panelRes = await fetch(`${API_BASE}/manage-panel`);
    if (!panelRes.ok) { uiToast('加载失败', 'error'); renderGalleryPage(); return; }
    const { stats, settings, users } = await panelRes.json();
    currentSettings = settings;
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="app-bar">
            <div class="actions">
                <button class="btn btn-text" id="back-gallery">← 返回图库</button>
                <button class="btn btn-text" id="refresh-index">刷新索引</button>
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
                <h3>用户管理</h3>
                <button class="btn btn-outlined" id="add-user-btn">添加用户</button>
                <table class="user-table">
                    <thead><tr><th>用户名</th><th>昵称</th><th>角色</th><th>权限</th><th>操作</th></tr></thead>
                    <tbody id="user-list"></tbody>
                </table>
            </div>
        </div>
    `;
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
    document.querySelectorAll('[data-user-id][data-action="delete"]').forEach(btn=>{ btn.onclick=async()=>{ if(await uiConfirm('确定删除该用户？', { danger: true, confirmText: '删除' })){ await fetch(`${API_BASE}/user`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:btn.dataset.userId})}); renderManagePage(); } }; });
    document.querySelectorAll('.perm-edit-btn').forEach(btn=>{
        btn.onclick = async () => {
            const user = users.find(u => String(u.id) === btn.dataset.userId);
            if (!user) return;
            const perms = await showEditPermissionsDialog(user);
            if (!perms) return;
            const res = await fetch(`${API_BASE}/user`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: user.id, perm_upload: perms.perm_upload, perm_view: perms.perm_view })
            });
            if (res.ok) {
                uiToast('权限已更新', 'success');
                renderManagePage();
            } else {
                const err = await res.json().catch(() => ({}));
                uiToast('更新失败' + (err.error ? '：' + err.error : ''), 'error');
            }
        };
    });
    document.getElementById('back-gallery').onclick=()=>renderGalleryPage();
    document.getElementById('refresh-index').onclick = async () => {
        uiLoadingShow('更新中，请稍候');
        try {
            const res = await fetch(`${API_BASE}/refresh-index`, { method: 'POST' });
            if (res.ok) {
                await renderManagePage();
                uiToast('索引已刷新', 'success');
            } else {
                uiToast('刷新失败', 'error');
            }
        } catch {
            uiToast('刷新失败', 'error');
        } finally {
            uiLoadingHide();
        }
    };
    document.getElementById('export-settings').onclick=()=>window.location.href=`${API_BASE}/settings/export`;
    document.getElementById('import-settings').onclick=()=>{ const inp=document.createElement('input'); inp.type='file'; inp.accept='application/json'; inp.onchange=async(e)=>{ const file=e.target.files[0]; const text=await file.text(); const json=JSON.parse(text); await fetch(`${API_BASE}/settings/import`,{method:'POST',body:JSON.stringify(json)}); uiToast('导入成功', 'success'); renderManagePage(); }; inp.click(); };
    document.getElementById('update-profile').onclick=async()=>{ const nickname=document.getElementById('profile-nickname').value; const password=document.getElementById('profile-password').value; const body={nickname}; if(password) body.password=password; const res=await fetch(`${API_BASE}/user/profile`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if(res.ok){ const data=await res.json(); if(data.user) currentUser=data.user; uiToast('更新成功', 'success'); renderManagePage(); } else uiToast('更新失败', 'error'); };
    document.getElementById('save-settings').onclick=async()=>{ const newSettings={ site_title:document.getElementById('site-title').value, site_logo:document.getElementById('site-logo').value, site_bg:document.getElementById('site-bg').value, footer_html:document.getElementById('footer-html').value, r2_public_url:document.getElementById('r2-public-url').value }; await fetch(`${API_BASE}/settings`,{method:'PUT',body:JSON.stringify(newSettings)}); uiToast('设置已保存', 'success'); await loadSettings(); renderManagePage(); };
    document.getElementById('add-user-btn').onclick=showAddUserDialog;
}

async function showAddUserDialog() {
    const username = await uiPrompt('添加用户', { placeholder: '用户名' });
    if (!username) return;
    const password = await uiPrompt('添加用户', { message: `为用户 ${username} 设置密码`, inputType: 'password', placeholder: '密码' });
    if (!password) return;
    const role = await uiPrompt('添加用户', { message: '设置角色', defaultValue: 'guest', placeholder: 'admin 或 guest' });
    if (!role) return;
    await fetch(`${API_BASE}/users`, { method: 'POST', body: JSON.stringify({ username, password, role }) });
    uiToast('用户已添加', 'success');
    renderManagePage();
}

function escapeHtml(str){ if(!str) return ''; return str.replace(/[&<>]/g,function(m){if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }