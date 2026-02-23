// Service Worker (Background) - G-Pilot 消息路由中枢
import type { ExtMessage, RecordingState, MaskingRule } from '../shared/types';
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
            console.log('[G-Pilot] State restored from storage:', state.isRecording ? 'recording' : 'idle');
        }
    } catch (e) {
        console.warn('[G-Pilot] Failed to restore state:', e);
    }
}

// 立即恢复状态
restoreState();

// ─────────────────────────────────────
// 消息路由
// ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
    handleMessage(msg)
        .then(sendResponse)
        .catch(err => {
            console.warn('[G-Pilot] Message handler error:', err);
            sendResponse({ error: String(err) });
        });
    return true; // 保持异步响应通道
});

async function handleMessage(msg: ExtMessage): Promise<unknown> {
    switch (msg.type) {
        case 'SESSION_START': {
            const { projectId, title, targetUrl } = msg.payload as any;

            let session: any;
            try {
                const res = await fetch(`${API_BASE}/sessions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ project_id: projectId, title, target_url: targetUrl }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                session = data.data;
            } catch (e) {
                return { error: `后端连接失败: ${e}，请确认 http://localhost:3210 已启动` };
            }

            state.sessionId = session.id;
            state.projectId = projectId;
            state.isRecording = true;
            state.isPaused = false;
            state.stepCount = 0;
            await chrome.storage.local.set({ recordingState: { ...state } });

            // 通知当前 tab 的 content script 开始录制
            await sendToActiveTab({ type: 'SESSION_START', payload: { sessionId: session.id, maskRules: state.maskRules } });
            return { sessionId: session.id };
        }

        case 'SESSION_PAUSE': {
            state.isPaused = true;
            await chrome.storage.local.set({ recordingState: { ...state } });
            if (state.sessionId) await safeUpdateSessionStatus(state.sessionId, 'paused');
            await sendToActiveTab({ type: 'SESSION_PAUSE' });
            return { ok: true };
        }

        case 'SESSION_RESUME': {
            state.isPaused = false;
            await chrome.storage.local.set({ recordingState: { ...state } });
            if (state.sessionId) await safeUpdateSessionStatus(state.sessionId, 'recording');
            await sendToActiveTab({ type: 'SESSION_RESUME' });
            return { ok: true };
        }

        case 'SESSION_STOP': {
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
            await sendToActiveTab({ type: 'SESSION_STOP' });
            return { ok: true, stoppedSessionId };
        }

        case 'STEP_CAPTURED': {
            if (!state.isRecording || state.isPaused || !state.sessionId) return { ok: false };
            const payload = msg.payload as any;

            // 截图逻辑移到 background 处理，更稳健
            let screenshotDataURL = payload.screenshot_data_url || '';
            if (!screenshotDataURL) {
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id && tab.windowId) {
                        screenshotDataURL = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
                    }
                } catch (e) {
                    console.warn('[G-Pilot] Screenshot failed during step capture:', e);
                }
            }

            try {
                const stepRes = await fetch(`${API_BASE}/sessions/${state.sessionId}/steps`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...payload,
                        session_id: state.sessionId,
                        screenshot_data_url: screenshotDataURL
                    }),
                });
                if (!stepRes.ok) throw new Error(`HTTP ${stepRes.status}`);
                const stepData = await stepRes.json();
                state.stepCount++;
                await chrome.storage.local.set({ recordingState: { ...state } });
                return { stepId: stepData.data?.id, stepIndex: state.stepCount };
            } catch (e) {
                console.warn('[G-Pilot] Failed to save step:', e);
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
