// Service Worker (Background) - G-Pilot 消息路由中枢
import type { ExtMessage, RecordingState, MaskingRule, MessageType } from '../shared/types';
import { API_BASE } from '../shared/types';

// ─────────────────────────────────────
// 全局录制状态（Service Worker 内存中）
// ─────────────────────────────────────
const state: RecordingState = {
    isRecording: false,
    isPaused: false,
    sessionId: null,
    projectId: null,
    stepCount: 0,
    maskRules: [],
};

// Service Worker 启动时，从 storage 恢复状态
// （MV3 Service Worker 可能被 Chrome 随时终止，重启后内存清空）
let isInitialized = false;
const initializationPromise = restoreState();

async function restoreState() {
    try {
        const stored = await chrome.storage.local.get('recordingState');
        if (stored.recordingState) {
            const s = stored.recordingState as RecordingState;
            state.isRecording = s.isRecording ?? false;
            state.isPaused = s.isPaused ?? false;
            state.sessionId = s.sessionId ?? null;
            state.projectId = s.projectId ?? null;
            state.stepCount = s.stepCount ?? 0;
            state.maskRules = s.maskRules ?? [];
            console.log('[G-Pilot] State restored from storage:', state);
        }
        isInitialized = true;
    } catch (e) {
        console.warn('[G-Pilot] Failed to restore state:', e);
    }
}

// ─────────────────────────────────────
// 消息路由
// ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
    (async () => {
        await initializationPromise;
        try {
            const resp = await handleMessage(msg);
            sendResponse(resp);
        } catch (err) {
            console.warn('[G-Pilot] Message handler error:', err);
            sendResponse({ error: String(err) });
        }
    })();
    return true; // 保持异步响应通道
});

async function handleMessage(msg: ExtMessage): Promise<unknown> {
    switch (msg.type) {
        case 'SESSION_START': {
            const { projectId, title, targetUrl } = msg.payload as any;
            console.log(`[G-Pilot] Starting session for project: ${projectId}, title: ${title}`);

            let session: any;
            try {
                const url = `${API_BASE}/sessions`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ project_id: projectId, title, target_url: targetUrl }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                const data = await res.json();
                session = data.data;
                console.log(`[G-Pilot] Session created:`, session);
            } catch (e) {
                console.error(`[G-Pilot] Failed to create session:`, e);
                return { error: `后端连接失败: ${e}，请确认 ${API_BASE} 已启动且可访问` };
            }

            state.sessionId = session.id;
            state.projectId = projectId;
            state.isRecording = true;
            state.isPaused = false;
            state.stepCount = 0;

            // 持久化项目 ID 和录制状态
            await chrome.storage.local.set({
                recordingState: { ...state },
                lastProjectId: projectId
            });

            // 通知当前 tab 的 content script 开始录制
            await sendToActiveTab({ type: 'SESSION_START', payload: { sessionId: session.id, maskRules: state.maskRules } });
            return { sessionId: session.id };
        }

        case 'SESSION_PAUSE': {
            console.log(`[G-Pilot] Pausing session: ${state.sessionId}`);
            state.isPaused = true;
            await chrome.storage.local.set({ recordingState: { ...state } });
            if (state.sessionId) await safeUpdateSessionStatus(state.sessionId, 'paused');
            await sendToActiveTab({ type: 'SESSION_PAUSE' });
            return { ok: true };
        }

        case 'SESSION_RESUME': {
            console.log(`[G-Pilot] Resuming session: ${state.sessionId}`);
            state.isPaused = false;
            await chrome.storage.local.set({ recordingState: { ...state } });
            if (state.sessionId) await safeUpdateSessionStatus(state.sessionId, 'recording');
            await sendToActiveTab({ type: 'SESSION_RESUME' });
            return { ok: true };
        }

        case 'SESSION_STOP': {
            console.log(`[G-Pilot] Stopping session: ${state.sessionId}`);
            const stoppedSessionId = state.sessionId;
            state.isRecording = false;
            state.isPaused = false;

            // 先完成 API 更新，再清空 sessionId
            if (stoppedSessionId) {
                await safeUpdateSessionStatus(stoppedSessionId, 'completed');
            }
            state.sessionId = null;
            state.stepCount = 0;
            await chrome.storage.local.set({ recordingState: { ...state } });

            // 通知 content script（可能已不在了，忽略错误）
            await sendToActiveTab({ type: 'SESSION_STOP', payload: { projectId: state.projectId } });
            return { ok: true, stoppedSessionId, projectId: state.projectId };
        }

        case 'STEP_CAPTURED': {
            if (!state.isRecording || state.isPaused || !state.sessionId) {
                console.warn(`[G-Pilot] Step capture ignored. recording:${state.isRecording}, paused:${state.isPaused}, sessionId:${state.sessionId}`);
                return { ok: false, reason: 'not_recording_or_paused' };
            }
            const payload = msg.payload as any;
            console.log(`[G-Pilot] Step captured: ${payload.action}, target: ${payload.target_element}`);

            let screenshotDataURL = payload.screenshot_data_url || '';
            if (!screenshotDataURL) {
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id && tab.windowId) {
                        screenshotDataURL = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
                    }
                } catch (e) {
                    console.warn('[G-Pilot] Screenshot failed during step capture:', e);
                }
            }

            // 处理截图：裁剪和绘制红框
            if (screenshotDataURL) {
                try {
                    screenshotDataURL = await processScreenshot(
                        screenshotDataURL,
                        state.screenshotArea,
                        payload.element_rect,
                        payload.screenshot_width,
                        payload.screenshot_height
                    );
                } catch (e) {
                    console.warn('[G-Pilot] Screenshot processing failed:', e);
                }
            }

            try {
                const url = `${API_BASE}/sessions/${state.sessionId}/steps`;
                const stepRes = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...payload,
                        session_id: state.sessionId,
                        screenshot_data_url: screenshotDataURL
                    }),
                });
                if (!stepRes.ok) throw new Error(`HTTP ${stepRes.status}: ${await stepRes.text()}`);
                const stepData = await stepRes.json();

                state.stepCount++;
                console.log(`[G-Pilot] Step saved. Current count: ${state.stepCount}`);
                await chrome.storage.local.set({ recordingState: { ...state } });

                const updateMsg = {
                    type: 'STEP_UPDATED' as MessageType,
                    payload: { stepCount: state.stepCount }
                };

                sendToActiveTab(updateMsg).catch(() => { });
                chrome.runtime.sendMessage(updateMsg).catch(() => { });

                return { stepId: stepData.data?.id, stepIndex: state.stepCount };
            } catch (e) {
                console.error('[G-Pilot] Failed to save step:', e);
                return { ok: false, error: String(e) };
            }
        }

        case 'CAPTURE_SCREENSHOT': {
            // content script 无法直接截图，委托给 background
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab?.id) return '';
                const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
                return dataUrl;
            } catch (e) {
                console.warn('[G-Pilot] Screenshot failed:', e);
                return '';
            }
        }

        case 'MASKING_RULE_ADD': {
            const rule = msg.payload as MaskingRule;
            state.maskRules.push(rule);
            await chrome.storage.local.set({ recordingState: { ...state } });
            await sendToActiveTab({ type: 'MASKING_RULE_ADD', payload: rule });
            return { ok: true };
        }

        case 'GET_PROJECT_SESSIONS': {
            const { projectId } = msg.payload as any;
            try {
                const res = await fetch(`${API_BASE}/sessions?project_id=${projectId}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                return data; // 返回 sessions 数组
            } catch (e) {
                console.error('[G-Pilot] Failed to fetch sessions:', e);
                return [];
            }
        }

        case 'STATE_SYNC_REQUEST': {
            return { ...state };
        }

        default:
            return { error: `unknown message type: ${(msg as any).type}` };
    }
}

// ─────────────────────────────────────
// 安全发送到 content script（忽略"接收端不存在"错误）
// ─────────────────────────────────────
async function sendToActiveTab(msg: ExtMessage): Promise<void> {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;

        // 跳过不支持 content script 的页面（chrome://, about:, pdf 等）
        const url = tab.url || '';
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
            url.startsWith('about:') || url.startsWith('edge://') ||
            url === '' || url === 'about:blank') {
            return;
        }

        await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e: any) {
        // "Receiving end does not exist" 是正常情况（content script 未注入或页面已关闭）
        if (e?.message?.includes('Receiving end does not exist') ||
            e?.message?.includes('Could not establish connection')) {
            return; // 静默忽略
        }
        console.warn('[G-Pilot] sendToActiveTab error:', e);
    }
}

// ─────────────────────────────────────
// 安全更新 session 状态
// ─────────────────────────────────────
async function safeUpdateSessionStatus(sessionId: string, status: string): Promise<void> {
    try {
        await fetch(`${API_BASE}/sessions/${sessionId}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
        });
    } catch (e) {
        console.warn('[G-Pilot] Failed to update session status:', e);
    }
}

// ─────────────────────────────────────
// 扩展安装/更新时初始化
// ─────────────────────────────────────
// ─────────────────────────────────────
// 截图处理：裁剪 + 绘制交互红框
// ─────────────────────────────────────
async function processScreenshot(dataUrl: string, area?: any, elementRect?: any, originalWidth?: number, originalHeight?: number): Promise<string> {
    if (!area && !elementRect) return dataUrl;

    try {
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);

        // 计算物理像素与 CSS 像素的缩放比例 (DPR)
        let scale = 1;
        if (originalWidth && originalWidth > 0) {
            scale = bitmap.width / originalWidth;
        }

        let targetX = 0, targetY = 0, targetW = bitmap.width, targetH = bitmap.height;

        if (area) {
            // area 使用的是 CSS 像素，需要乘以 scale 转换为物理像素
            targetX = area.x * scale;
            targetY = area.y * scale;
            targetW = area.width * scale;
            targetH = area.height * scale;

            // 防止越界
            targetX = Math.max(0, Math.min(targetX, bitmap.width));
            targetY = Math.max(0, Math.min(targetY, bitmap.height));
            targetW = Math.min(targetW, bitmap.width - targetX);
            targetH = Math.min(targetH, bitmap.height - targetY);
        }

        const canvas = new OffscreenCanvas(targetW, targetH);
        const ctx = canvas.getContext('2d');
        if (!ctx) return dataUrl;

        // 绘制裁剪后的原图
        ctx.drawImage(bitmap, targetX, targetY, targetW, targetH, 0, 0, targetW, targetH);

        // 如果有元素位置，绘制红框
        if (elementRect) {
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = Math.max(2, 3 * scale); // 根据 DPI 调整线宽

            // 坐标转换：(CSS 坐标 * scale) - 裁剪起始物理坐标
            const rx = (elementRect.left * scale) - targetX;
            const ry = (elementRect.top * scale) - targetY;
            const rw = elementRect.width * scale;
            const rh = elementRect.height * scale;

            // 绘制红框，稍微扩大一点范围以覆盖边缘
            const padding = 2 * scale;
            ctx.strokeRect(rx - padding, ry - padding, rw + padding * 2, rh + padding * 2);
        }

        const newBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(newBlob);
        });
    } catch (e) {
        console.error('[G-Pilot] processScreenshot error:', e);
        return dataUrl;
    }
}

chrome.runtime.onInstalled.addListener(async () => {
    await chrome.storage.local.set({
        recordingState: {
            isRecording: false, isPaused: false,
            sessionId: null, projectId: null,
            stepCount: 0, maskRules: [],
        }
    });
    console.log('[G-Pilot] Extension installed/updated. Backend:', API_BASE);
});
