// Content Script 入口 - 事件监听 + 脱敏 + 悬浮控制台
console.log('[G-Pilot] Content script loading...');
import './content.css';
import { applyMaskingRules, generateDOMFingerprint, getStableSelector, getXPath } from '../shared/utils';
import type { ActionType, MaskingRule, Session, MessageType } from '../shared/types';

// ─────────────────────────────────────
// 状态
// ─────────────────────────────────────
let isRecording = false;
let isPaused = false;
let sessionId: string | null = null;
let maskRules: MaskingRule[] = [];
let isMarkMode = false;
let isMinimized = false;

// ─────────────────────────────────────
// 同步状态（防止刷新页面后状态丢失）
// ─────────────────────────────────────
async function syncStateWithBackground() {
    const stored = await chrome.storage.local.get('gpilot_ui_minimized');
    isMinimized = !!stored.gpilot_ui_minimized;

    const state = await safeSendMessage({ type: 'STATE_SYNC_REQUEST' });
    if (state && state.isRecording) {
        isRecording = true;
        isPaused = state.isPaused;
        sessionId = state.sessionId;
        maskRules = state.maskRules ?? [];
        showFloatingConsole();
        updateStepCounter(state.stepCount || 0);
        updateFloatingConsoleStatus();

        if (isRecording && !isPaused) {
            captureEvent('navigation', document.body, { inputValue: location.href });
        }
    }
}

syncStateWithBackground();

// ─────────────────────────────────────
// 接收 background 消息
// ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    console.log(`[G-Pilot] Received message: ${msg.type}`, msg.payload);
    switch (msg.type) {
        case 'SESSION_START':
            isRecording = true;
            isPaused = false;
            sessionId = msg.payload?.sessionId;
            maskRules = msg.payload?.maskRules ?? [];
            showFloatingConsole();
            updateStepCounter(0);
            captureEvent('navigation', document.body, { inputValue: location.href });
            sendResponse({ ok: true });
            break;
        case 'SESSION_PAUSE':
            isPaused = true;
            updateFloatingConsoleStatus();
            sendResponse({ ok: true });
            break;
        case 'SESSION_RESUME':
            isPaused = false;
            updateFloatingConsoleStatus();
            sendResponse({ ok: true });
            break;
        case 'SESSION_STOP':
            isRecording = false;
            isPaused = false;
            const stoppedProject = sessionId ? (msg.payload as any)?.projectId || null : null;
            sessionId = null;
            showSessionHistory(stoppedProject);
            sendResponse({ ok: true });
            break;
        case 'MASKING_RULE_ADD':
            maskRules.push(msg.payload);
            sendResponse({ ok: true });
            break;
        case 'MARK_MODE_ENTER':
            enterMarkMode();
            sendResponse({ ok: true });
            break;
        case 'MARK_MODE_EXIT':
            exitMarkMode();
            sendResponse({ ok: true });
            break;
        case 'PICK_MODE_ENTER':
            enterPickMode();
            sendResponse({ ok: true });
            break;
        case 'PICK_MODE_EXIT':
            exitPickMode();
            sendResponse({ ok: true });
            break;
        case 'STEP_UPDATED':
            if (msg.payload?.stepCount !== undefined) {
                updateStepCounter(msg.payload.stepCount);
            }
            sendResponse({ ok: true });
            break;
    }
    return true;
});

// ─────────────────────────────────────
// 页面区域方位识别
// ─────────────────────────────────────
function getElementLocation(el: Element): string {
    if (el.closest('header, #header, .header, .top-bar, .navbar-fixed-top')) return '页头导航区';
    if (el.closest('aside, nav, .sidebar, #sidebar, .left-menu, .ant-layout-sider')) return '侧边导航栏';
    if (el.closest('footer, #footer, .footer')) return '页脚区域';
    if (el.closest('.toolbar, .action-bar, .btn-toolbar, .ant-space')) return '操作工具栏';
    if (el.closest('.modal, .dialog, .ant-modal, .el-dialog')) return '弹窗对话框';
    if (el.closest('table, .grid, .list, .ant-table')) return '数据列表区';
    if (el.closest('form, .ant-form, .el-form')) return '表单填写区';
    return '页面中心区';
}

// ─────────────────────────────────────
// 根据关键字及页面上下文推断操作目的
// ─────────────────────────────────────
function inferActionPurpose(name: string, action: string, tagName: string, pageTitle: string, extraValue?: string): string {
    const n = name.toLowerCase();
    const cleanPageTitle = pageTitle.split('-')[0].split('_')[0].trim();
    let actionVerb = '';
    if (n.includes('保存') || n.includes('提交') || n.includes('确定') || n.includes('ok') || n.includes('save') || n.includes('submit')) {
        actionVerb = '数据持久化存储';
    } else if (n.includes('取消') || n.includes('关闭') || n.includes('返回') || n.includes('close') || n.includes('cancel')) {
        actionVerb = '放弃操作或关闭窗口';
    } else if (n.includes('新增') || n.includes('创建') || n.includes('添加') || n.includes('add') || n.includes('create')) {
        actionVerb = '开启新业务录入';
    } else if (n.includes('删除') || n.includes('移出') || n.includes('清空') || n.includes('delete') || n.includes('remove')) {
        actionVerb = '移除冗余数据';
    } else if (n.includes('搜索') || n.includes('查询') || n.includes('filter') || n.includes('search')) {
        actionVerb = '数据精准检索';
    } else if (n.includes('下载') || n.includes('导出') || n.includes('download') || n.includes('export')) {
        actionVerb = '获取数据报表';
    } else if (n.includes('编辑') || n.includes('修改') || n.includes('edit') || n.includes('modify')) {
        actionVerb = '调整业务信息';
    } else if (n.includes('审核') || n.includes('审批')) {
        actionVerb = '业务合规性校验';
    } else if (n.includes('状态') || n.includes('详情') || n.includes('查看') || n.includes('view') || n.includes('detail')) {
        actionVerb = '查看详细业务信息';
    } else if (action === 'input' || tagName === 'input' || tagName === 'textarea') {
        actionVerb = '业务信息录入';
    } else if (action === 'select' || tagName === 'select') {
        actionVerb = '业务参数配置';
    } else if (action === 'navigation') {
        actionVerb = '功能模块切换';
    }

    if (actionVerb === '数据持久化存储') return `提交 ${cleanPageTitle} 相关业务数据`;
    if (actionVerb === '放弃操作或关闭窗口') return `关闭当前窗口或放弃 ${cleanPageTitle} 的编辑`;
    if (actionVerb === '数据精准检索') return `在 ${cleanPageTitle} 中执行内容检索`;
    if (actionVerb === '业务信息录入' && extraValue) return `在 ${cleanPageTitle} 录入信息为 "${extraValue}"`;
    if (actionVerb === '业务信息录入') return `完善 ${cleanPageTitle} 的明细内容`;
    if (actionVerb === '开启新业务录入') return `新增一条 ${cleanPageTitle} 业务记录`;
    if (actionVerb === '功能模块切换') return `进入 ${cleanPageTitle} 功能板块`;
    if (actionVerb === '查看详细业务信息') return `查看 ${cleanPageTitle} 的 ${name} 详情`;
    if (tagName === 'tab' || (n && actionVerb === '')) return `切换到 ${name} 视图以处理 ${cleanPageTitle} 业务`;
    if (name && name !== '未命名组件') return `执行与 ${name} 相关的 ${cleanPageTitle} 业务交互`;
    return `执行 ${cleanPageTitle} 的功能交互`;
}

// ─────────────────────────────────────
// 事件捕获辅助：提取高度语义化的操作说明
// ─────────────────────────────────────
function getElementFriendlyName(action: ActionType, el: Element, rawText: string, extra?: { inputValue?: string }): string {
    const pageName = document.title || '当前页面';
    const location = getElementLocation(el);
    let targetEl = el;
    let name = rawText.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';

    if (!name && el.parentElement) {
        const p = el.parentElement;
        const pTag = p.tagName.toLowerCase();
        if (pTag === 'button' || pTag === 'a' || p.getAttribute('role') === 'button' || p.classList.contains('ant-btn') || p.classList.contains('el-button')) {
            targetEl = p;
            name = p.textContent?.trim() || p.getAttribute('aria-label') || p.getAttribute('title') || '';
        }
    }

    if (!name && (targetEl.tagName.toLowerCase() === 'input' || targetEl.tagName.toLowerCase() === 'textarea')) {
        const id = targetEl.id;
        if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) name = label.textContent?.trim() || '';
        }
        if (!name) name = (targetEl as HTMLInputElement).placeholder || '';
    }

    const finalTag = targetEl.tagName.toLowerCase();
    const type = (targetEl as HTMLInputElement).type;
    const role = targetEl.getAttribute('role');
    const purpose = inferActionPurpose(name, action, finalTag, pageName, extra?.inputValue);

    let displayName = name || targetEl.id || '';
    if (displayName.length > 30) displayName = displayName.slice(0, 30) + '...';
    if (!displayName) displayName = '未命名组件';

    let componentType = '组件';
    let verb = '点击了';
    if (finalTag === 'button' || role === 'button') { componentType = '按钮'; verb = '点击了'; }
    else if (finalTag === 'a' || role === 'link') { componentType = '链接/菜单'; verb = '点击了'; }
    else if (role === 'tab' || targetEl.classList.contains('tab')) { componentType = '标签页'; verb = '切换到'; }
    else if (finalTag === 'input' || finalTag === 'textarea') {
        componentType = (type === 'checkbox' || type === 'radio') ? '单/多选框' : '输入框';
        verb = (type === 'checkbox' || type === 'radio') ? '点击了' : '在...中输入了内容';
    } else if (finalTag === 'select') { componentType = '下拉选择器'; verb = '选择了'; }
    else if (action === 'navigation') return `在 ${pageName} 页面执行了页面导航操作，进入新业务模块，实现功能模块切换。`;

    const actionDesc = verb === '在...中输入了内容'
        ? `在功能为 ${displayName} 的 ${componentType} 中录入了业务信息`
        : `${verb}功能为 ${displayName} 的 ${componentType}`;

    return `在 ${pageName} 页面的 ${location}，${actionDesc}，实现 ${purpose}。`;
}

// ─────────────────────────────────────
// 事件捕获
// ─────────────────────────────────────
function captureEvent(action: ActionType, el: Element, extra?: { inputValue?: string }) {
    if (!isRecording || isPaused) return;

    console.log(`[G-Pilot] Capturing event: ${action}`, el);
    const ariaLabel = el.getAttribute('aria-label') || '';
    const tagName = el.tagName.toLowerCase();

    let rawText = '';
    if (action === 'navigation') rawText = `URL: ${location.href}`;
    else if (tagName === 'body') rawText = document.title || 'Page Body';
    else rawText = el.textContent?.trim() || ariaLabel || (el as HTMLInputElement).placeholder || '';

    if (rawText.length > 2000) rawText = rawText.slice(0, 2000) + '...';

    const maskedText = applyMaskingRules(rawText, maskRules);
    const inputVal = extra?.inputValue ? applyMaskingRules(extra.inputValue, maskRules) : '';
    const stepDescription = getElementFriendlyName(action, el, rawText, extra);

    const step = {
        action,
        target_selector: getStableSelector(el),
        target_xpath: getXPath(el),
        target_element: stepDescription,
        aria_label: ariaLabel,
        masked_text: maskedText,
        input_value: inputVal,
        page_url: location.href,
        page_title: document.title,
        timestamp: Date.now(),
        is_masked: maskedText !== rawText,
        dom_fingerprint: generateDOMFingerprint(action, ariaLabel, tagName, rawText),
        element_rect: (action !== 'navigation' && tagName !== 'body') ? (el.getBoundingClientRect ? el.getBoundingClientRect() : null) : null,
    };

    const uiElements = document.querySelectorAll('.gpilot-ui');
    uiElements.forEach(node => (node as HTMLElement).classList.add('gpilot-hide'));

    setTimeout(() => {
        safeSendMessage({
            type: 'STEP_CAPTURED',
            payload: { ...step, screenshot_width: window.innerWidth, screenshot_height: window.innerHeight },
        }).then(resp => {
            uiElements.forEach(node => (node as HTMLElement).classList.remove('gpilot-hide'));
            if (resp && resp.stepIndex !== undefined) updateStepCounter(resp.stepIndex);
        });
    }, 100);
}

// ─────────────────────────────────────
// 安全 sendMessage
// ─────────────────────────────────────
function safeSendMessage(msg: any): Promise<any> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(msg, (resp) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    resolve(null);
                    return;
                }
                resolve(resp);
            });
        } catch (e: any) {
            resolve(null);
        }
    });
}

// ─────────────────────────────────────
// 即点即脱敏模式
// ─────────────────────────────────────
function enterMarkMode() {
    isMarkMode = true;
    document.body.style.cursor = 'crosshair';
    showMarkModeOverlay();
}

function exitMarkMode() {
    isMarkMode = false;
    document.body.style.cursor = '';
    hideMarkModeOverlay();
}

function showMarkModeOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'gpilot-mark-overlay';
    overlay.className = 'gpilot-ui';
    overlay.innerHTML = `
    <div class="gpilot-mark-tip">
      🎯 <strong>标记脱敏模式</strong> — 点击页面上的敏感文本
      <button id="gpilot-cancel-mark">取消</button>
    </div>
  `;
    document.body.appendChild(overlay);
    overlay.querySelector('#gpilot-cancel-mark')?.addEventListener('click', exitMarkMode);
}

function hideMarkModeOverlay() {
    document.getElementById('gpilot-mark-overlay')?.remove();
}

// ─────────────────────────────────────
// 截图区域拾取模式
// ─────────────────────────────────────
let isPickMode = false;
function enterPickMode() {
    isPickMode = true;
    document.body.style.cursor = 'crosshair';
    showPickModeOverlay();
}

function exitPickMode() {
    isPickMode = false;
    document.body.style.cursor = '';
    const overlay = document.getElementById('gpilot-pick-overlay');
    if (overlay) {
        overlay.dispatchEvent(new CustomEvent('gpilot-cleanup'));
        overlay.remove();
    }
}

function showPickModeOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'gpilot-pick-overlay';
    overlay.className = 'gpilot-ui gpilot-pick-mask';
    overlay.innerHTML = `
        <div class="gpilot-pick-tip">
            📐 <strong>拾取截图主区域</strong> — 拖拽鼠标选择一个矩形区域，或点击一次选择整个容器
            <div style="margin-top: 8px;">
                <button id="gpilot-pick-reset">重置为全屏</button>
                <button id="gpilot-pick-cancel">取消</button>
            </div>
        </div>
        <div id="gpilot-pick-selector" class="gpilot-pick-selector"></div>
    `;
    document.body.appendChild(overlay);

    const selector = overlay.querySelector('#gpilot-pick-selector') as HTMLElement;
    let startX = 0, startY = 0, isDragging = false;

    const onMouseDown = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.gpilot-pick-tip')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        selector.style.display = 'block';
        selector.style.left = `${startX}px`;
        selector.style.top = `${startY}px`;
        selector.style.width = '0px';
        selector.style.height = '0px';
    };

    const onMouseMove = (e: MouseEvent) => {
        if (!isDragging) return;
        const width = Math.abs(e.clientX - startX);
        const height = Math.abs(e.clientY - startY);
        selector.style.width = `${width}px`;
        selector.style.height = `${height}px`;
        selector.style.left = `${Math.min(e.clientX, startX)}px`;
        selector.style.top = `${Math.min(e.clientY, startY)}px`;
    };

    const onMouseUp = async () => {
        if (!isDragging) return;
        isDragging = false;
        const rect = selector.getBoundingClientRect();
        if (rect.width > 5 && rect.height > 5) {
            const area = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
            await chrome.storage.local.set({ screenshotArea: area });
            await safeSendMessage({ type: 'STATE_SYNC_REQUEST' });
            exitPickMode();
        }
    };

    overlay.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    overlay.querySelector('#gpilot-pick-reset')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await chrome.storage.local.remove('screenshotArea');
        await safeSendMessage({ type: 'STATE_SYNC_REQUEST' });
        exitPickMode();
    });
    overlay.querySelector('#gpilot-pick-cancel')?.addEventListener('click', (e) => {
        e.stopPropagation();
        exitPickMode();
    });

    overlay.addEventListener('gpilot-cleanup', () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    });
}

function handleMarkClick(el: Element, e: MouseEvent) {
    if (el.closest('.gpilot-ui')) return;
    e.preventDefault(); e.stopPropagation();
    const originalText = el.textContent?.trim() || '';
    if (!originalText) return;
    showAliasInput(el as HTMLElement, originalText, (alias) => {
        (el as HTMLElement).innerText = alias;
        el.classList.add('gpilot-masked');
        const rule: MaskingRule = { rule_type: 'exact', pattern: originalText, alias: alias, scope: 'session', is_active: true };
        maskRules.push(rule);
        safeSendMessage({ type: 'MASKING_RULE_ADD', payload: rule });
        exitMarkMode();
    });
}

// ─────────────────────────────────────
// DOM 事件监听
// ─────────────────────────────────────
document.addEventListener('click', (e) => {
    if (!isRecording || isPaused) return;
    const target = e.target as Element;
    if (isMarkMode) { handleMarkClick(target, e); return; }
    if (target.closest('.gpilot-ui')) return;
    captureEvent('click', target);
}, true);

let inputTimer: any;
document.addEventListener('input', (e) => {
    if (!isRecording || isPaused) return;
    const target = e.target as HTMLInputElement;
    if (target.closest('.gpilot-ui')) return;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { captureEvent('input', target, { inputValue: target.value }); }, 800);
}, true);

document.addEventListener('change', (e) => {
    if (!isRecording || isPaused) return;
    const target = e.target as HTMLSelectElement;
    if (target.closest('.gpilot-ui')) return;
    if (target.tagName === 'SELECT') captureEvent('select', target, { inputValue: target.options[target.selectedIndex]?.text });
}, true);

let lastURL = location.href;
const navObserver = new MutationObserver(() => {
    if (location.href !== lastURL) {
        if (isRecording && !isPaused) captureEvent('navigation', document.body, { inputValue: location.href });
        lastURL = location.href;
    }
});
navObserver.observe(document.body, { subtree: true, childList: true });

// ─────────────────────────────────────
// UI 辅助
// ─────────────────────────────────────
let floatingConsole: HTMLElement | null = null;
let stepCounter: HTMLElement | null = null;
let miniStepCounter: HTMLElement | null = null;

function showFloatingConsole() {
    if (floatingConsole) return;
    floatingConsole = document.createElement('div');
    floatingConsole.className = `gpilot-ui gpilot-console ${isMinimized ? 'minimized' : ''}`;
    floatingConsole.innerHTML = `
    <div class="gpilot-mini-icon">🚁<span id="gpilot-mini-count" class="gpilot-mini-badge">0</span></div>
    <div class="gpilot-header"><span class="gpilot-logo">🚁 G-Pilot</span>
      <div id="gpilot-status-area" style="display: flex; align-items: center; gap: 8px;">
        <span class="gpilot-badge recording">● 录制中</span>
        <button id="gpilot-minimize" class="gpilot-minimize-btn" title="最小化">一</button>
      </div>
    </div>
    <div id="gpilot-main-content">
      <div class="gpilot-body">
        <div class="gpilot-steps">步骤：<span id="gpilot-step-count">0</span></div>
        <div class="gpilot-actions">
          <button id="gpilot-pause" class="gpilot-btn">⏸ 暂停</button>
          <button id="gpilot-mark" class="gpilot-btn gpilot-btn-mark">🎯 标记脱敏</button>
          <button id="gpilot-pick" class="gpilot-btn" title="设置截图区域">📐 拾取区域</button>
          <button id="gpilot-stop" class="gpilot-btn gpilot-btn-stop">⏹ 停止</button>
        </div>
      </div>
    </div>
    <div id="gpilot-history-content" style="display:none; max-height: 250px; overflow-y: auto; padding: 10px;">
        <div style="font-size: 13px; font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom: 4px;">录制清单</div>
        <div id="gpilot-session-list" style="font-size: 12px;">正在加载清单...</div>
    </div>
    `;
    document.body.appendChild(floatingConsole);
    stepCounter = floatingConsole.querySelector('#gpilot-step-count');
    miniStepCounter = floatingConsole.querySelector('#gpilot-mini-count');
    makeDraggable(floatingConsole);
    floatingConsole.addEventListener('click', () => { if (isMinimized) { isMinimized = false; floatingConsole?.classList.remove('minimized'); chrome.storage.local.set({ gpilot_ui_minimized: false }); } });
    floatingConsole.querySelector('#gpilot-minimize')?.addEventListener('click', (e) => { e.stopPropagation(); isMinimized = true; floatingConsole?.classList.add('minimized'); chrome.storage.local.set({ gpilot_ui_minimized: true }); });
    floatingConsole.querySelector('#gpilot-pause')?.addEventListener('click', (e) => { e.stopPropagation(); if (!isPaused) safeSendMessage({ type: 'SESSION_PAUSE' }); else safeSendMessage({ type: 'SESSION_RESUME' }); });
    floatingConsole.querySelector('#gpilot-mark')?.addEventListener('click', (e) => { e.stopPropagation(); enterMarkMode(); });
    floatingConsole.querySelector('#gpilot-pick')?.addEventListener('click', (e) => { e.stopPropagation(); enterPickMode(); });
    floatingConsole.querySelector('#gpilot-stop')?.addEventListener('click', async (e) => { e.stopPropagation(); const btn = floatingConsole?.querySelector('#gpilot-stop') as HTMLButtonElement; if (btn) { btn.textContent = '停止中...'; btn.disabled = true; } await safeSendMessage({ type: 'SESSION_STOP' }); });
}

function updateFloatingConsoleStatus() {
    const badge = floatingConsole?.querySelector('.gpilot-badge');
    const pauseBtn = floatingConsole?.querySelector('#gpilot-pause') as HTMLButtonElement;
    if (badge) {
        badge.textContent = isPaused ? '⏸ 已暂停' : '● 录制中';
        badge.className = `gpilot-badge ${isPaused ? 'paused' : 'recording'}`;
    }
    if (pauseBtn) pauseBtn.textContent = isPaused ? '▶ 继续' : '⏸ 暂停';
}
function updateStepCounter(count: number) { if (stepCounter) stepCounter.textContent = String(count); if (miniStepCounter) miniStepCounter.textContent = String(count); }
function makeDraggable(el: HTMLElement) {
    let ox = 0, oy = 0; const h = el.querySelector('.gpilot-header') as HTMLElement;
    if (!h) return; h.style.cursor = 'move';
    h.addEventListener('mousedown', (e: MouseEvent) => {
        ox = e.clientX - el.offsetLeft; oy = e.clientY - el.offsetTop;
        const m = (e: MouseEvent) => { el.style.left = `${e.clientX - ox}px`; el.style.top = `${e.clientY - oy}px`; el.style.right = 'auto'; el.style.bottom = 'auto'; };
        const u = () => { document.removeEventListener('mousemove', m); document.removeEventListener('mouseup', u); };
        document.addEventListener('mousemove', m); document.addEventListener('mouseup', u);
    });
}
function showSessionHistory(pId: string | null) {
    if (!floatingConsole) return;
    const main = floatingConsole.querySelector('#gpilot-main-content') as HTMLElement;
    const hist = floatingConsole.querySelector('#gpilot-history-content') as HTMLElement;
    const status = floatingConsole.querySelector('#gpilot-status-area') as HTMLElement;
    const list = floatingConsole.querySelector('#gpilot-session-list') as HTMLElement;
    if (main) main.style.display = 'none'; if (hist) hist.style.display = 'block';
    if (status) status.innerHTML = '<button id="gpilot-close-panel" style="background:none; border:none; color:white; cursor:pointer; font-size:18px;">×</button>';
    floatingConsole.querySelector('#gpilot-close-panel')?.addEventListener('click', () => { floatingConsole?.remove(); floatingConsole = null; });
    if (!pId) { if (list) list.innerHTML = '暂无项目信息'; return; }
    safeSendMessage({ type: 'GET_PROJECT_SESSIONS', payload: { projectId: pId } }).then(resp => {
        const sessions = Array.isArray(resp) ? resp : (resp?.data || []);
        if (list) list.innerHTML = sessions.map((s: any) => `<div style="padding:8px; border-bottom:1px solid #f0f0f0;">${s.title}</div>`).join('');
    });
}
function showAliasInput(el: HTMLElement, oText: string, onC: (a: string) => void) {
    const rect = el.getBoundingClientRect();
    const d = document.createElement('div');
    d.id = 'gpilot-alias-input'; d.className = 'gpilot-ui gpilot-alias-dialog';
    d.style.cssText = `top:${rect.bottom + window.scrollY + 8}px;left:${rect.left + window.scrollX}px`;
    d.innerHTML = `<div>🔒 将 "${oText.slice(0, 20)}" 替换为：</div><input type="text" /><button id="c">确认</button>`;
    document.body.appendChild(d);
    d.querySelector('#c')?.addEventListener('click', () => { const a = d.querySelector('input')?.value; if (a) onC(a); d.remove(); });
}
