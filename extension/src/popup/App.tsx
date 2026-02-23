import React, { useState, useEffect } from 'react';
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

export default function App() {
    const [activeTab, setActiveTab] = useState<TabKey>('record');
    const [recordingState, setRecordingState] = useState<RecordingState>({
        isRecording: false,
        isPaused: false,
        sessionId: null,
        projectId: null,
        stepCount: 0,
        maskRules: [],
    });
    const [backendOk, setBackendOk] = useState<boolean | null>(null);

    // 同步 background 录制状态
    useEffect(() => {
        const syncState = () => {
            chrome.runtime.sendMessage({ type: 'STATE_SYNC_REQUEST' }, (resp) => {
                if (resp && !chrome.runtime.lastError) {
                    setRecordingState(resp as RecordingState);
                }
            });
        };
        syncState();
        const timer = setInterval(syncState, 2000);
        return () => clearInterval(timer);
    }, []);

    // 检查后端连通性
    useEffect(() => {
        fetch('http://localhost:3210/health')
            .then(r => setBackendOk(r.ok))
            .catch(() => setBackendOk(false));
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
                            : <span className="badge badge-recording">● 录制中 {recordingState.stepCount}步</span>
                    ) : (
                        <span className="badge badge-idle">○ 待机</span>
                    )}
                    <span style={{ fontSize: 10, color: backendOk ? 'var(--success)' : backendOk === false ? 'var(--danger)' : 'var(--text-secondary)' }}>
                        {backendOk === null ? '连接中...' : backendOk ? '✓ 后端在线' : '✗ 后端离线'}
                    </span>
                </div>
            </div>

            {/* Backend offline warning */}
            {backendOk === false && (
                <div className="alert alert-warning" style={{ margin: '8px 14px 0', borderRadius: 8 }}>
                    ⚠️ 后端未启动，请先运行 <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 4px', borderRadius: 3 }}>go run cmd/server/main.go</code>
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
                        onStateChange={setRecordingState}
                    />
                )}
                {activeTab === 'projects' && <ProjectsTab />}
                {activeTab === 'settings' && <SettingsTab />}
            </div>
        </div>
    );
}
