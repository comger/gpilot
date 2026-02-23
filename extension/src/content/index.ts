// Content Script 入口 - 事件监听 + 脱敏 + 悬浮控制台
import { applyMaskingRules, generateDOMFingerprint, getStableSelector, getXPath } from '../shared/utils';
import type { ActionType, MaskingRule } from '../shared/types';

// ─────────────────────────────────────
// 状态
// ─────────────────────────────────────
let isRecording = false;
let isPaused = false;
let sessionId: string | null = null;
let maskRules: MaskingRule[] = [];
let isMarkMode = false;

// ─────────────────────────────────────
// 接收 background 消息
// ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
        case 'SESSION_START':
            isRecording = true;
            isPaused = false;
            sessionId = msg.payload?.sessionId;
            maskRules = msg.payload?.maskRules ?? [];
            showFloatingConsole();
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
            sessionId = null;
            hideFloatingConsole();
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
    }
    return true;
});

// ─────────────────────────────────────
// 事件捕获
// ─────────────────────────────────────
function captureEvent(action: ActionType, el: Element, extra?: { inputValue?: string }) {
    if (!isRecording || isPaused) return;

    const ariaLabel = el.getAttribute('aria-label') || '';
    const tagName = el.tagName.toLowerCase();
    const rawText = el.textContent?.trim() || ariaLabel || (el as HTMLInputElement).placeholder || '';
    const maskedText = applyMaskingRules(rawText, maskRules);
    const inputVal = extra?.inputValue ? applyMaskingRules(extra.inputValue, maskRules) : '';

    const step = {
        action,
        target_selector: getStableSelector(el),
        target_xpath: getXPath(el),
        target_element: `${rawText.slice(0, 40)} (${tagName}${el.id ? '#' + el.id : ''})`,
        aria_label: ariaLabel,
        masked_text: maskedText,
        input_value: inputVal,
        page_url: location.href,
        page_title: document.title,
        timestamp: Date.now(),
        is_masked: maskedText !== rawText,
        dom_fingerprint: generateDOMFingerprint(action, ariaLabel, tagName, rawText),
    };

    // 截图（在发送 step 前先捕获当前视口）
    captureScreenshot().then(screenshotDataURL => {
        safeSendMessage({
            type: 'STEP_CAPTURED',
            payload: { ...step, screenshot_data_url: screenshotDataURL, screenshot_width: window.innerWidth, screenshot_height: window.innerHeight },
        }).then(resp => {
            if (resp?.stepIndex) updateStepCounter(resp.stepIndex);
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
    } catch {
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
                if (chrome.runtime.lastError) {
                    // SW 被终止或接收端不存在 → 静默忽略
                    resolve(null);
                    return;
                }
                resolve(resp);
            });
        } catch (e) {
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

function showFloatingConsole() {
    if (floatingConsole) return;

    floatingConsole = document.createElement('div');
    floatingConsole.className = 'gpilot-ui gpilot-console';
    floatingConsole.innerHTML = `
    <div class="gpilot-header">
      <span class="gpilot-logo">🚁 G-Pilot</span>
      <span class="gpilot-badge recording">● 录制中</span>
    </div>
    <div class="gpilot-body">
      <div class="gpilot-steps">步骤：<span id="gpilot-step-count">0</span></div>
      <div class="gpilot-actions">
        <button id="gpilot-pause" class="gpilot-btn">⏸ 暂停</button>
        <button id="gpilot-mark" class="gpilot-btn gpilot-btn-mark">🎯 标记脱敏</button>
        <button id="gpilot-stop" class="gpilot-btn gpilot-btn-stop">⏹ 停止</button>
      </div>
    </div>
  `;

    document.body.appendChild(floatingConsole);
    stepCounter = floatingConsole.querySelector('#gpilot-step-count');

    // 拖拽支持
    makeDraggable(floatingConsole);

    // 按钮事件
    floatingConsole.querySelector('#gpilot-pause')?.addEventListener('click', () => {
        if (!isPaused) {
            safeSendMessage({ type: 'SESSION_PAUSE' });
        } else {
            safeSendMessage({ type: 'SESSION_RESUME' });
        }
    });

    floatingConsole.querySelector('#gpilot-mark')?.addEventListener('click', () => {
        enterMarkMode();
    });

    floatingConsole.querySelector('#gpilot-stop')?.addEventListener('click', async () => {
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
