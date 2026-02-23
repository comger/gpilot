// Service Worker (Background) - G-Pilot 消息路由中枢
import type { ExtMessage, RecordingState, MaskingRule } from '../shared/types';
import { API_BASE } from '../shared/types';

// 全局录制状态（Service Worker 内存中）
const state: RecordingState = {
    isRecording: false,
    isPaused: false,
    sessionId: null,
    projectId: null,
    stepCount: 0,
    maskRules: [],
};

// ─────────────────────────────────────
// 消息路由
// ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true; // 异步响应
});

async function handleMessage(msg: ExtMessage): Promise<unknown> {
    switch (msg.type) {
        case 'SESSION_START': {
            const { projectId, title, targetUrl } = msg.payload as any;
            const res = await fetch(`${API_BASE}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_id: projectId, title, target_url: targetUrl }),
            });
            const data = await res.json();
            const session = data.data;
            state.sessionId = session.id;
            state.projectId = projectId;
            state.isRecording = true;
            state.isPaused = false;
            state.stepCount = 0;
            await chrome.storage.local.set({ recordingState: state });
            // 通知所有 content scripts 开始录制
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { type: 'SESSION_START', payload: { sessionId: session.id, maskRules: state.maskRules } });
            }
            return { sessionId: session.id };
        }

        case 'SESSION_PAUSE': {
            state.isPaused = true;
            await chrome.storage.local.set({ recordingState: state });
            await updateSessionStatus(state.sessionId!, 'paused');
            broadcastToActiveTab({ type: 'SESSION_PAUSE' });
            return { ok: true };
        }

        case 'SESSION_RESUME': {
            state.isPaused = false;
            await chrome.storage.local.set({ recordingState: state });
            await updateSessionStatus(state.sessionId!, 'recording');
            broadcastToActiveTab({ type: 'SESSION_RESUME' });
            return { ok: true };
        }

        case 'SESSION_STOP': {
            const stoppedSessionId = state.sessionId;
            state.isRecording = false;
            state.isPaused = false;
            // 先完成 API 更新，再清空 sessionId
            if (stoppedSessionId) {
                try {
                    await updateSessionStatus(stoppedSessionId, 'completed');
                } catch (e) {
                    console.warn('[G-Pilot] Failed to update session status:', e);
                }
            }
            state.sessionId = null;
            state.stepCount = 0;
            await chrome.storage.local.set({ recordingState: state });
            // 通知 content script 隐藏悬浮控制台
            broadcastToActiveTab({ type: 'SESSION_STOP' });
            return { ok: true, stoppedSessionId };
        }

        case 'STEP_CAPTURED': {
            if (!state.isRecording || state.isPaused) return { ok: false };
            const payload = msg.payload as any;
            // 截图捕获由 content script 传来（已脱敏）
            const tab = await getCurrentTab();
            if (!tab?.id) return { ok: false };

            const stepRes = await fetch(`${API_BASE}/sessions/${state.sessionId}/steps`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, session_id: state.sessionId }),
            });
            const stepData = await stepRes.json();
            state.stepCount++;
            await chrome.storage.local.set({ recordingState: state });
            return { stepId: stepData.data?.id, stepIndex: state.stepCount };
        }

        case 'MASKING_RULE_ADD': {
            const rule = msg.payload as MaskingRule;
            state.maskRules.push(rule);
            await chrome.storage.local.set({ recordingState: state });
            // 通知 content script 更新规则
            broadcastToActiveTab({ type: 'MASKING_RULE_ADD', payload: rule });
            return { ok: true };
        }

        case 'STATE_SYNC_REQUEST': {
            return state;
        }

        default:
            return { error: 'unknown message type' };
    }
}

// ─────────────────────────────────────
// 辅助方法
// ─────────────────────────────────────
async function updateSessionStatus(sessionId: string, status: string) {
    await fetch(`${API_BASE}/sessions/${sessionId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
    });
}

async function getCurrentTab(): Promise<chrome.tabs.Tab | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
}

async function broadcastToActiveTab(msg: ExtMessage) {
    const tab = await getCurrentTab();
    if (tab?.id) {
        try {
            chrome.tabs.sendMessage(tab.id, msg);
        } catch { }
    }
}

// 扩展安装时设置初始状态
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ recordingState: { ...state } });
    console.log('[G-Pilot] Extension installed, backend at', API_BASE);
});
