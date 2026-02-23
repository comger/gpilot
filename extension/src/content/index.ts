// Content Script 入口 - 事件监听 + 脱敏 + 悬浮控制台
console.log('[G-Pilot] Content script loading...');
import './content.css';
import { applyMaskingRules, generateDOMFingerprint, getStableSelector, getXPath } from '../shared/utils';
import type { ActionType, MaskingRule, Session } from '../shared/types';

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
    // 同时检查最小化状态
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

        // 如果刚进入新页面，记录一次导航
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

            // 立即记录一次初始状态
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
            // 结束后不消失，而是展示历史清单
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

        case 'STEP_UPDATED':
            if (msg.payload?.stepCount !== undefined) {
                updateStepCounter(msg.payload.stepCount);
            }
            sendResponse({ ok: true });
            break;
    }
    return true; // 保持异步响应（如果某些 case 需要）
});

// ─────────────────────────────────────
// 事件捕获辅助：提取有意义的元素名称
// ─────────────────────────────────────
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
// 根据关键字推断操作目的
// ─────────────────────────────────────
// ─────────────────────────────────────
// 根据关键字及页面上下文推断操作目的（高度业务化）
// ─────────────────────────────────────
function inferActionPurpose(name: string, action: string, tagName: string, pageTitle: string, extraValue?: string): string {
    const n = name.toLowerCase();
    const p = pageTitle.toLowerCase();
    const cleanPageTitle = pageTitle.split('-')[0].split('_')[0].trim(); // 提取纯净页面名称

    // 基础业务动作识别
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

    // 结合页面标题进行语义增强
    if (actionVerb === '数据持久化存储') return `提交 ${cleanPageTitle} 相关业务数据`;
    if (actionVerb === '放弃操作或关闭窗口') return `关闭当前窗口或放弃 ${cleanPageTitle} 的编辑`;
    if (actionVerb === '数据精准检索') return `在 ${cleanPageTitle} 中执行内容检索`;
    if (actionVerb === '业务信息录入' && extraValue) return `在 ${cleanPageTitle} 录入信息为 "${extraValue}"`;
    if (actionVerb === '业务信息录入') return `完善 ${cleanPageTitle} 的明细内容`;
    if (actionVerb === '开启新业务录入') return `新增一条 ${cleanPageTitle} 业务记录`;
    if (actionVerb === '功能模块切换') return `进入 ${cleanPageTitle} 功能板块`;
    if (actionVerb === '查看详细业务信息') return `查看 ${cleanPageTitle} 的 ${name} 详情`;

    // 特殊处理：如果是 Tab 切换且没命中以上关键字
    if (tagName === 'tab' || (n && actionVerb === '')) {
        return `切换到 ${name} 视图以处理 ${cleanPageTitle} 业务`;
    }

    // 最终兜底：结合名称和页面标题
    if (name && name !== '未命名组件') {
        return `执行与 ${name} 相关的 ${cleanPageTitle} 业务交互`;
    }

    return `执行 ${cleanPageTitle} 的功能交互`;
}

// ─────────────────────────────────────
// 事件捕获辅助：提取高度语义化的操作说明
// ─────────────────────────────────────
function getElementFriendlyName(action: ActionType, el: Element, rawText: string, extra?: { inputValue?: string }): string {
    const pageName = document.title || '当前页面';
    const location = getElementLocation(el);

    // 自动追踪有意义的父级容器
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

    // 对于输入框，如果本身没名称，尝试找 label 或附近的文本
    if (!name && (targetEl.tagName.toLowerCase() === 'input' || targetEl.tagName.toLowerCase() === 'textarea')) {
        const id = targetEl.id;
        if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) name = label.textContent?.trim() || '';
        }
        if (!name) {
            // 尝试找前一个兄弟文本节点或父级容器的文本
            name = (targetEl as HTMLInputElement).placeholder || '';
        }
    }

    const finalTag = targetEl.tagName.toLowerCase();
    const type = (targetEl as HTMLInputElement).type;
    const role = targetEl.getAttribute('role');
    const purpose = inferActionPurpose(name, action, finalTag, pageName, extra?.inputValue);

    // 格式化名称
    let displayName = name || targetEl.id || '';
    if (displayName.length > 30) displayName = displayName.slice(0, 30) + '...';
    if (!displayName) displayName = '未命名组件';

    let componentType = '组件';
    let verb = '点击了';

    if (finalTag === 'button' || role === 'button') {
        componentType = '按钮';
        verb = '点击了';
    } else if (finalTag === 'a' || role === 'link') {
        componentType = '链接/菜单';
        verb = '点击了';
    } else if (role === 'tab' || targetEl.classList.contains('tab')) {
        componentType = '标签页';
        verb = '切换到';
    } else if (finalTag === 'input' || finalTag === 'textarea') {
        componentType = (type === 'checkbox' || type === 'radio') ? '单/多选框' : '输入框';
        verb = (type === 'checkbox' || type === 'radio') ? '点击了' : '在...中输入了内容';
    } else if (finalTag === 'select') {
        componentType = '下拉选择器';
        verb = '选择了';
    } else if (action === 'navigation') {
        return `在 ${pageName} 页面执行了页面导航操作，进入新业务模块，实现功能模块切换。`;
    }

    // 组装格式：在哪个页面的什么方位，点击了功能为XX的XXX组件，实现XXX功能。
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

    // 对于 navigation 和 scroll 等绑定在 body 上的事件，textContent 会非常庞大
    // 我们只需要提取一小部分作为标识即可
    let rawText = '';
    if (action === 'navigation') {
        rawText = `URL: ${location.href}`;
    } else if (tagName === 'body') {
        rawText = document.title || 'Page Body';
    } else {
        rawText = el.textContent?.trim() || ariaLabel || (el as HTMLInputElement).placeholder || '';
    }

    // 限制原始文本长度，防止超大 DOM 文本导致 JSON 序列化或脱敏正则崩溃
    if (rawText.length > 2000) {
        rawText = rawText.slice(0, 2000) + '...';
    }

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
    };

    // 优化：截图前隐藏插件 UI
    const uiElements = document.querySelectorAll('.gpilot-ui');
    uiElements.forEach(node => (node as HTMLElement).classList.add('gpilot-hide'));

    // 关键修正：给浏览器更充足的重绘时间 (100ms)，确保 captureVisibleTab 之前 UI 已完全消失
    setTimeout(() => {
        // 发送 step 给 background（由 background 补全截图并保存）
        safeSendMessage({
            type: 'STEP_CAPTURED',
            payload: {
                ...step,
                screenshot_width: window.innerWidth,
                screenshot_height: window.innerHeight
            },
        }).then(resp => {
            // 恢复显示 UI
            uiElements.forEach(node => (node as HTMLElement).classList.remove('gpilot-hide'));

            console.log(`[G-Pilot] Step saved response:`, resp);
            // 后端返回的 stepIndex 才是最权威的
            if (resp && resp.stepIndex !== undefined) {
                updateStepCounter(resp.stepIndex);
            }
        });
    });
}

// ─────────────────────────────────────
// 截图捕获（调用 chrome.tabs API）
// ─────────────────────────────────────
async function captureScreenshot(): Promise<string> {
    try {
        const dataURL = await safeSendMessage({ type: 'CAPTURE_SCREENSHOT' });
        return (dataURL as string) || '';
    } catch (e) {
        console.warn('[G-Pilot] captureScreenshot failed:', e);
        return '';
    }
}

// ─────────────────────────────────────
// 安全 sendMessage（处理 SW 被终止的情况）
// ─────────────────────────────────────
function safeSendMessage(msg: any): Promise<any> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(msg, (resp) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    const msg_str = err.message || '';
                    // 忽略由于页面导航或扩展重载导致的正常断连错误
                    if (msg_str.includes('Message channel closed') ||
                        msg_str.includes('Extension context invalidated') ||
                        msg_str.includes('Could not establish connection')) {
                        console.debug(`[G-Pilot] sendMessage suppressed info (${msg.type}):`, msg_str);
                    } else {
                        console.warn(`[G-Pilot] sendMessage error (${msg.type}):`, msg_str);
                    }
                    resolve(null);
                    return;
                }
                resolve(resp);
            });
        } catch (e: any) {
            if (e?.message?.includes('Extension context invalidated')) {
                // 扩展已更新或重载，当前脚本已失效
                return;
            }
            console.warn(`[G-Pilot] sendMessage exception (${msg.type}):`, e);
            resolve(null);
        }
    });
}

// ─────────────────────────────────────
// DOM 事件监听
// ─────────────────────────────────────
let lastKeyUpEl: Element | null = null;

document.addEventListener('click', (e) => {
    if (!isRecording || isPaused) return;
    const target = e.target as Element;

    // 如果处于标记脱敏模式，则拦截点击
    if (isMarkMode) {
        handleMarkClick(target, e);
        return;
    }

    // 忽略 G-Pilot 自身 UI
    if (target.closest('.gpilot-ui')) return;

    captureEvent('click', target);
}, true);

// Input 防抖（只在用户停止输入后捕获）
let inputTimer: ReturnType<typeof setTimeout>;
document.addEventListener('input', (e) => {
    if (!isRecording || isPaused) return;
    const target = e.target as HTMLInputElement;
    if (target.closest('.gpilot-ui')) return;
    lastKeyUpEl = target;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
        captureEvent('input', target, { inputValue: target.value });
    }, 800);
}, true);

document.addEventListener('change', (e) => {
    if (!isRecording || isPaused) return;
    const target = e.target as HTMLSelectElement;
    if (target.closest('.gpilot-ui')) return;
    if (target.tagName === 'SELECT') {
        captureEvent('select', target, { inputValue: target.options[target.selectedIndex]?.text });
    }
}, true);

// 页面导航捕获
let lastURL = location.href;
const navObserver = new MutationObserver(() => {
    if (location.href !== lastURL) {
        if (isRecording && !isPaused) {
            captureEvent('navigation', document.body, { inputValue: location.href });
        }
        lastURL = location.href;
    }
});
navObserver.observe(document.body, { subtree: true, childList: true });

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

function handleMarkClick(el: Element, e: MouseEvent) {
    // 关键修正：如果点击的是 G-Pilot 自身的 UI，不应视为脱敏目标，也不应拦截
    if (el.closest('.gpilot-ui')) {
        return;
    }

    e.preventDefault();
    e.stopPropagation();

    const originalText = el.textContent?.trim() || '';
    if (!originalText) return;

    // 弹出别名输入框
    showAliasInput(el as HTMLElement, originalText, (alias) => {
        // 立即替换 DOM 文本
        (el as HTMLElement).innerText = alias;
        el.classList.add('gpilot-masked');

        // 添加脱敏规则
        const rule: MaskingRule = {
            rule_type: 'exact',
            pattern: originalText,
            alias: alias,
            scope: 'session',
            is_active: true,
        };
        maskRules.push(rule);
        safeSendMessage({ type: 'MASKING_RULE_ADD', payload: rule });

        exitMarkMode();
    });
}

// ─────────────────────────────────────
// 悬浮控制台 UI（纯 DOM，轻量实现）
// ─────────────────────────────────────
let floatingConsole: HTMLElement | null = null;
let stepCounter: HTMLElement | null = null;
let miniStepCounter: HTMLElement | null = null;

function showFloatingConsole() {
    if (floatingConsole) return;

    floatingConsole = document.createElement('div');
    floatingConsole.className = `gpilot-ui gpilot-console ${isMinimized ? 'minimized' : ''}`;
    floatingConsole.innerHTML = `
    <!-- 小图标视图 -->
    <div class="gpilot-mini-icon">
      🚁
      <span id="gpilot-mini-count" class="gpilot-mini-badge">0</span>
    </div>

    <!-- 完整面板视图 -->
    <div class="gpilot-header">
      <span class="gpilot-logo">🚁 G-Pilot</span>
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

    // 拖拽支持
    makeDraggable(floatingConsole);

    // 最小化/展开逻辑
    floatingConsole.addEventListener('click', (e) => {
        if (isMinimized) {
            isMinimized = false;
            floatingConsole?.classList.remove('minimized');
            chrome.storage.local.set({ gpilot_ui_minimized: false });
        }
    });

    floatingConsole.querySelector('#gpilot-minimize')?.addEventListener('click', (e) => {
        e.stopPropagation();
        isMinimized = true;
        floatingConsole?.classList.add('minimized');
        chrome.storage.local.set({ gpilot_ui_minimized: true });
    });

    // 按钮事件
    floatingConsole.querySelector('#gpilot-pause')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isPaused) {
            safeSendMessage({ type: 'SESSION_PAUSE' });
        } else {
            safeSendMessage({ type: 'SESSION_RESUME' });
        }
    });

    floatingConsole.querySelector('#gpilot-mark')?.addEventListener('click', (e) => {
        e.stopPropagation();
        enterMarkMode();
    });

    floatingConsole.querySelector('#gpilot-stop')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const stopBtn = floatingConsole?.querySelector('#gpilot-stop') as HTMLButtonElement | null;
        if (stopBtn) { stopBtn.textContent = '停止中...'; stopBtn.disabled = true; }
        await safeSendMessage({ type: 'SESSION_STOP' });
    });
}

function hideFloatingConsole() {
    floatingConsole?.remove();
    floatingConsole = null;
    stepCounter = null;
}

async function showSessionHistory(projectId: string | null) {
    if (!floatingConsole) return;

    // 切换 UI 视图
    const mainContent = floatingConsole.querySelector('#gpilot-main-content') as HTMLElement;
    const historyContent = floatingConsole.querySelector('#gpilot-history-content') as HTMLElement;
    const statusArea = floatingConsole.querySelector('#gpilot-status-area') as HTMLElement;
    const listContainer = floatingConsole.querySelector('#gpilot-session-list') as HTMLElement;

    if (mainContent) mainContent.style.display = 'none';
    if (historyContent) historyContent.style.display = 'block';
    if (statusArea) statusArea.innerHTML = '<button id="gpilot-close-panel" style="background:none; border:none; color:white; cursor:pointer; font-size:18px;">×</button>';

    floatingConsole.querySelector('#gpilot-close-panel')?.addEventListener('click', () => {
        hideFloatingConsole();
    });

    if (!projectId) {
        if (listContainer) listContainer.innerHTML = '<div style="color:#999; text-align:center; padding:20px;">暂无项目信息</div>';
        return;
    }

    try {
        const resp = await safeSendMessage({ type: 'GET_PROJECT_SESSIONS', payload: { projectId } });
        const sessions: Session[] = Array.isArray(resp) ? resp : (resp?.data || []);

        if (listContainer) {
            if (sessions.length === 0) {
                listContainer.innerHTML = '<div style="color:#999; text-align:center; padding:20px;">暂无录制文件</div>';
            } else {
                listContainer.innerHTML = sessions.map(s => `
                    <div style="padding: 8px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center;">
                        <div style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;">
                            <div style="font-weight: 500; color: #333;">${s.title}</div>
                            <div style="font-size: 10px; color: #999;">${new Date(s.created_at).toLocaleDateString()}</div>
                        </div>
                        <div style="font-weight: bold; color: #667eea; font-size: 12px; white-space: nowrap;">
                            ${(s as any).step_count || 0} 步
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch (e) {
        if (listContainer) listContainer.innerHTML = '<div style="color:red; text-align:center; padding:20px;">加载失败</div>';
    }
}

function updateFloatingConsoleStatus() {
    const badge = floatingConsole?.querySelector('.gpilot-badge');
    const pauseBtn = floatingConsole?.querySelector('#gpilot-pause') as HTMLButtonElement;
    if (badge) {
        badge.textContent = isPaused ? '⏸ 已暂停' : '● 录制中';
        badge.className = `gpilot-badge ${isPaused ? 'paused' : 'recording'}`;
    }
    if (pauseBtn) {
        pauseBtn.textContent = isPaused ? '▶ 继续' : '⏸ 暂停';
    }
}

function updateStepCounter(count: number) {
    if (stepCounter) stepCounter.textContent = String(count);
    if (miniStepCounter) miniStepCounter.textContent = String(count);
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

// 别名输入弹窗
function showAliasInput(el: HTMLElement, originalText: string, onConfirm: (alias: string) => void) {
    const existing = document.getElementById('gpilot-alias-input');
    existing?.remove();

    const rect = el.getBoundingClientRect();
    const dialog = document.createElement('div');
    dialog.id = 'gpilot-alias-input';
    dialog.className = 'gpilot-ui gpilot-alias-dialog';
    dialog.style.cssText = `top:${rect.bottom + window.scrollY + 8}px;left:${rect.left + window.scrollX}px`;
    dialog.innerHTML = `
    <div class="gpilot-alias-label">🔒 将 "<em>${originalText.slice(0, 20)}</em>" 替换为：</div>
    <input id="gpilot-alias-text" type="text" placeholder="输入替换文本，如【某政务部门】" />
    <div class="gpilot-alias-actions">
      <button id="gpilot-alias-confirm" class="gpilot-btn">确认脱敏</button>
      <button id="gpilot-alias-cancel" class="gpilot-btn">取消</button>
    </div>
  `;
    document.body.appendChild(dialog);

    const input = dialog.querySelector('#gpilot-alias-text') as HTMLInputElement;
    input.focus();

    dialog.querySelector('#gpilot-alias-confirm')?.addEventListener('click', () => {
        const alias = input.value.trim();
        if (alias) {
            onConfirm(alias);
            dialog.remove();
        }
    });
    dialog.querySelector('#gpilot-alias-cancel')?.addEventListener('click', () => {
        dialog.remove();
        exitMarkMode();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') dialog.querySelector<HTMLButtonElement>('#gpilot-alias-confirm')?.click();
        if (e.key === 'Escape') dialog.querySelector<HTMLButtonElement>('#gpilot-alias-cancel')?.click();
    });
}

function makeDraggable(el: HTMLElement) {
    let ox = 0, oy = 0;
    const header = el.querySelector('.gpilot-header') as HTMLElement;
    if (!header) return;
    header.style.cursor = 'move';
    header.addEventListener('mousedown', (e: MouseEvent) => {
        ox = e.clientX - el.offsetLeft;
        oy = e.clientY - el.offsetTop;
        const onMove = (e: MouseEvent) => {
            el.style.left = `${e.clientX - ox}px`;
            el.style.top = `${e.clientY - oy}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}
