import React, { useState, useEffect, useRef } from 'react';
import RecordTab from './pages/RecordTab';
import ProjectsTab from './pages/ProjectsTab';
import SettingsTab from './pages/SettingsTab';
import type { RecordingState } from '../shared/types';

type TabKey = 'record' | 'projects' | 'settings';

const TABS: { key: TabKey; label: string; icon: string }[] = [
    { key: 'record', label: '录制', icon: '🎙' },
    { key: 'projects', label: '项目', icon: '📁' },
    { key: 'settings', label: '设置', icon: '⚙️' },
];

const DEFAULT_STATE: RecordingState = {
    isRecording: false,
    isPaused: false,
    sessionId: null,
    projectId: null,
    stepCount: 0,
    maskRules: [],
};

export default function App() {
    const [activeTab, setActiveTab] = useState<TabKey>('record');
    const [recordingState, setRecordingState] = useState<RecordingState>(DEFAULT_STATE);
    const [backendOk, setBackendOk] = useState<boolean | null>(null);

    // 标记是否由 popup 主动触发状态变更（防止轮询立即覆盖）
    const localUpdateRef = useRef(false);

    // ─── 从 background 同步状态 ───
    useEffect(() => {
        const syncFromBackground = () => {
            // 如果刚刚由本地操作触发更新，跳过一次同步
            if (localUpdateRef.current) {
                localUpdateRef.current = false;
                return;
            }
            chrome.runtime.sendMessage({ type: 'STATE_SYNC_REQUEST' }, (resp) => {
                if (chrome.runtime.lastError) return;
                if (resp && typeof resp === 'object' && 'isRecording' in resp) {
                    setRecordingState(resp as RecordingState);
                }
            });
        };

        // 立即同步一次
        syncFromBackground();

        // 每 1.5s 轮询（录制中时步骤计数需要更新）
        const timer = setInterval(syncFromBackground, 1500);
        return () => clearInterval(timer);
    }, []);

    // ─── 处理 popup 触发的状态变更 ───
    const handleStateChange = (s: RecordingState) => {
        localUpdateRef.current = true; // 跳过下次轮询
        setRecordingState(s);
    };

    // ─── 检查后端 ───
    useEffect(() => {
        const check = () => {
            fetch('http://localhost:3210/health')
                .then(r => setBackendOk(r.ok))
                .catch(() => setBackendOk(false));
        };
        check();
        const t = setInterval(check, 10000);
        return () => clearInterval(t);
    }, []);

    return (
        <div className="app">
            {/* Header */}
            <div className="header">
                <div className="header-brand">
                    <span className="header-logo">🚁</span>
                    <div>
                        <div className="header-title">G-Pilot</div>
                        <div className="header-sub">智能政务助手</div>
                    </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    {recordingState.isRecording ? (
                        recordingState.isPaused
                            ? <span className="badge badge-paused">⏸ 已暂停</span>
                            : <span className="badge badge-recording">● {recordingState.stepCount}步</span>
                    ) : (
                        <span className="badge badge-idle">○ 待机</span>
                    )}
                    <span style={{
                        fontSize: 10,
                        color: backendOk ? 'var(--success)' : backendOk === false ? 'var(--danger)' : 'var(--text-secondary)'
                    }}>
                        {backendOk === null ? '连接中...' : backendOk ? '✓ 后端在线' : '✗ 后端离线'}
                    </span>
                </div>
            </div>

            {/* Backend offline warning */}
            {backendOk === false && (
                <div className="alert alert-warning" style={{ margin: '8px 14px 0', borderRadius: 8 }}>
                    ⚠️ 后端未启动，请先运行：
                    <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 4px', borderRadius: 3, display: 'block', marginTop: 4 }}>
                        cd backend && go run cmd/server/main.go
                    </code>
                </div>
            )}

            {/* Tabs */}
            <div className="tabs">
                {TABS.map(t => (
                    <div
                        key={t.key}
                        className={`tab ${activeTab === t.key ? 'active' : ''}`}
                        onClick={() => setActiveTab(t.key)}
                    >
                        {t.icon} {t.label}
                    </div>
                ))}
            </div>

            {/* Content */}
            <div className="content">
                {activeTab === 'record' && (
                    <RecordTab
                        recordingState={recordingState}
                        onStateChange={handleStateChange}
                    />
                )}
                {activeTab === 'projects' && <ProjectsTab />}
                {activeTab === 'settings' && <SettingsTab />}
            </div>
        </div>
    );
}
