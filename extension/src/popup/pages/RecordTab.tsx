import React, { useState, useEffect, useCallback } from 'react';
import type { RecordingState, Project, Session } from '../../shared/types';
import { apiGet, apiDelete } from '../../shared/utils';

interface Props {
    recordingState: RecordingState;
    onStateChange: (s: RecordingState) => void;
}

export default function RecordTab({ recordingState, onStateChange }: Props) {
    const [projects, setProjects] = useState<Project[]>([]);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [selectedProject, setSelectedProject] = useState('');
    const [sessionTitle, setSessionTitle] = useState('');
    const [stoppedSession, setStoppedSession] = useState<Session | null>(null);
    const [docStatus, setDocStatus] = useState<'idle' | 'generating' | 'done'>('idle');
    const [docProgress, setDocProgress] = useState(0);
    const [docProgressTotal, setDocProgressTotal] = useState(0);
    const [docId, setDocId] = useState('');
    const [error, setError] = useState('');
    const [stopping, setStopping] = useState(false);

    // 同步录制结束后切换到的 session
    const stoppedSessionId = stoppedSession?.id;

    useEffect(() => {
        apiGet<Project[]>('/projects').then(setProjects).catch(() => { });
    }, []);

    useEffect(() => {
        if (selectedProject) {
            apiGet<Session[]>(`/sessions?project_id=${selectedProject}`).then(setSessions).catch(() => { });
        }
    }, [selectedProject]);

    // 录制结束后，重新拉取 session 状态（确认 completed）
    useEffect(() => {
        if (stoppedSessionId) {
            const timer = setTimeout(() => {
                apiGet<Session>(`/sessions/${stoppedSessionId}`)
                    .then(s => setStoppedSession(s))
                    .catch(() => { });
            }, 800); // 等后端写入
            return () => clearTimeout(timer);
        }
    }, [stoppedSessionId]);

    // ─────────────────────────────────────
    // 录制控制
    // ─────────────────────────────────────
    const handleStartRecording = async () => {
        if (!selectedProject) { setError('请先选择项目'); return; }
        if (!sessionTitle.trim()) { setError('请填写本次录制标题'); return; }

        try {
            setError('');
            setStoppedSession(null);
            setDocStatus('idle');
            const [tab] = await (chrome.tabs.query({ active: true, currentWindow: true }) as Promise<chrome.tabs.Tab[]>);
            const targetUrl = tab?.url || '';

            const resp = await chrome.runtime.sendMessage({
                type: 'SESSION_START',
                payload: { projectId: selectedProject, title: sessionTitle.trim(), targetUrl },
            });

            if (chrome.runtime.lastError) {
                setError('无法连接录制服务，请刷新扩展');
                return;
            }

            if (resp?.sessionId) {
                onStateChange({
                    ...recordingState,
                    isRecording: true,
                    isPaused: false,
                    sessionId: resp.sessionId,
                    projectId: selectedProject,
                    stepCount: 0,
                });
                setSessionTitle('');
            } else {
                setError(resp?.error || '启动录制失败，请检查后端连接');
            }
        } catch (e: any) {
            setError(e.message || '启动录制失败');
        }
    };

    const handlePauseResume = async () => {
        try {
            if (recordingState.isPaused) {
                await chrome.runtime.sendMessage({ type: 'SESSION_RESUME' });
                onStateChange({ ...recordingState, isPaused: false });
            } else {
                await chrome.runtime.sendMessage({ type: 'SESSION_PAUSE' });
                onStateChange({ ...recordingState, isPaused: true });
            }
        } catch (e: any) {
            setError(e.message);
        }
    };

    const handleStop = async () => {
        if (stopping) return;
        setStopping(true);
        try {
            const currentSessionId = recordingState.sessionId; // 先保存，因为后续会清空

            // 等待 background 完成状态更新和 API 调用
            const resp = await chrome.runtime.sendMessage({ type: 'SESSION_STOP' });

            if (chrome.runtime.lastError) {
                setError('停止录制失败，请重试');
                setStopping(false);
                return;
            }

            // 更新 popup 状态（从 background 返回的最终状态）
            onStateChange({
                isRecording: false,
                isPaused: false,
                sessionId: null,
                projectId: null,
                stepCount: 0,
                maskRules: recordingState.maskRules,
            });

            // 保留 stoppedSession 供生成文档使用
            if (currentSessionId) {
                setStoppedSession({
                    id: currentSessionId,
                    project_id: recordingState.projectId || '',
                    title: '录制完成',
                    status: 'completed',
                    target_url: '',
                    created_at: new Date().toISOString(),
                });
                // 刷新 sessions 列表
                if (selectedProject) {
                    apiGet<Session[]>(`/sessions?project_id=${selectedProject}`).then(setSessions).catch(() => { });
                }
            }
        } catch (e: any) {
            setError(e.message || '停止录制失败');
        } finally {
            setStopping(false);
        }
    };

    // ─────────────────────────────────────
    // 文档生成
    // ─────────────────────────────────────
    const handleGenerateDoc = async () => {
        const sid = stoppedSession?.id;
        if (!sid) return;

        setDocStatus('generating');
        setDocProgress(0);
        setError('');

        const eventSource = new EventSource(`http://localhost:3210/api/v1/sessions/${sid}/generate`);

        eventSource.addEventListener('progress', (e) => {
            try {
                const data = JSON.parse(e.data);
                setDocProgress(data.current || 0);
                setDocProgressTotal(data.total || 0);
            } catch { }
        });

        eventSource.addEventListener('complete', (e) => {
            try {
                const data = JSON.parse(e.data);
                setDocId(data.doc_id);
            } catch { }
            setDocStatus('done');
            eventSource.close();
        });

        eventSource.onerror = () => {
            setDocStatus('idle');
            eventSource.close();
            setError('文档生成失败，请检查后端连接');
        };
    };

    const handleExportMd = () => {
        if (!docId) return;
        const url = `http://localhost:3210/api/v1/documents/${docId}/export?format=md&view=business`;
        chrome.downloads.download({ url, filename: 'gpilot-manual.md' });
    };

    const handleAddMaskRule = () => {
        const pattern = prompt('输入要脱敏的正则（或精确文本）：');
        if (!pattern) return;
        const alias = prompt('输入替换别名（如 【某单位名称】）：');
        if (!alias) return;
        chrome.runtime.sendMessage({
            type: 'MASKING_RULE_ADD',
            payload: { rule_type: 'exact', pattern, alias, scope: 'session', is_active: true },
        });
    };

    // ─────────────────────────────────────
    // UI: 未录制状态
    // ─────────────────────────────────────
    if (!recordingState.isRecording) {
        return (
            <div>
                {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

                <div className="card">
                    <div className="card-title">📁 选择项目</div>

                    {projects.length === 0 ? (
                        <div className="alert alert-warning">还没有项目，请先在「项目」标签创建</div>
                    ) : (
                        <div className="form-group">
                            <select
                                className="select"
                                value={selectedProject}
                                onChange={e => setSelectedProject(e.target.value)}
                            >
                                <option value="">-- 选择项目 --</option>
                                {projects.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {selectedProject && (
                        <div className="form-group">
                            <label className="label">本次录制标题</label>
                            <input
                                className="input"
                                type="text"
                                placeholder="如：用户登录 → 申请提交 → 提交成功"
                                value={sessionTitle}
                                onChange={e => setSessionTitle(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleStartRecording()}
                            />
                        </div>
                    )}

                    <button
                        className="btn btn-success btn-full"
                        onClick={handleStartRecording}
                        disabled={!selectedProject || !sessionTitle.trim()}
                    >
                        🔴 开始录制
                    </button>
                </div>

                {/* 刚结束的 session → 生成文档 */}
                {stoppedSession && (
                    <div className="card" style={{ borderColor: 'rgba(99,179,237,0.4)' }}>
                        <div className="card-title">📄 录制完成 — 生成文档</div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>
                            Session ID: {stoppedSession.id.slice(0, 8)}...
                        </div>

                        {docStatus === 'idle' && (
                            <button className="btn btn-primary btn-full" onClick={handleGenerateDoc}>
                                ✨ AI 生成操作手册
                            </button>
                        )}
                        {docStatus === 'generating' && (
                            <>
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                                    正在生成... {docProgress}/{docProgressTotal || '?'} 步骤
                                </div>
                                <div className="progress-wrap">
                                    <div className="progress-bar" style={{
                                        width: `${docProgressTotal > 0 ? Math.round((docProgress / docProgressTotal) * 100) : 10}%`
                                    }} />
                                </div>
                            </>
                        )}
                        {docStatus === 'done' && (
                            <div>
                                <div className="alert alert-success" style={{ marginBottom: 10 }}>✅ 文档生成完成！</div>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button className="btn btn-ghost" onClick={handleExportMd} style={{ flex: 1 }}>
                                        📥 Markdown
                                    </button>
                                    <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => {
                                        chrome.downloads.download({
                                            url: `http://localhost:3210/api/v1/documents/${docId}/export?format=json`,
                                            filename: 'gpilot-doc.json',
                                        });
                                    }}>
                                        📥 JSON
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* 最近的 sessions */}
                {sessions.length > 0 && selectedProject && !stoppedSession && (
                    <div className="card">
                        <div className="card-title">最近录制</div>
                        {sessions.slice(0, 4).map(s => (
                            <div key={s.id} className="list-item" style={{ cursor: 'default' }}>
                                <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => {
                                    setStoppedSession(s);
                                    setDocStatus('idle');
                                }}>
                                    <div className="list-item-title">{s.title}</div>
                                    <div className="list-item-sub">{new Date(s.created_at).toLocaleDateString('zh-CN')}</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span className={`badge ${s.status === 'completed' ? 'badge-success' : s.status === 'recording' ? 'badge-recording' : 'badge-idle'}`}>
                                        {s.status === 'completed' ? '完成' : s.status === 'recording' ? '录制中' : s.status}
                                    </span>
                                    <button
                                        className="btn btn-ghost"
                                        style={{ padding: '4px 8px', color: 'var(--danger)', borderColor: 'transparent' }}
                                        onClick={async () => {
                                            if (confirm('确定要删除这段录制记录吗？')) {
                                                try {
                                                    await apiDelete(`/sessions/${s.id}`);
                                                    setSessions(sessions.filter(item => item.id !== s.id));
                                                } catch (e: any) {
                                                    setError(e.message);
                                                }
                                            }
                                        }}
                                    >
                                        🗑
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // ─────────────────────────────────────
    // UI: 录制进行中
    // ─────────────────────────────────────
    return (
        <div>
            {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}

            <div className="card" style={{ borderColor: recordingState.isPaused ? 'rgba(237,137,54,0.4)' : 'rgba(72,187,120,0.4)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span className={`badge ${recordingState.isPaused ? 'badge-paused' : 'badge-recording'}`}>
                        {recordingState.isPaused ? '⏸ 已暂停' : '● 录制中'}
                    </span>
                    <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent)' }}>
                        {recordingState.stepCount}
                    </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center', marginBottom: 14 }}>
                    已捕获步骤数
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button className="btn btn-ghost" style={{ flex: 1 }} onClick={handlePauseResume}>
                        {recordingState.isPaused ? '▶ 继续' : '⏸ 暂停'}
                    </button>
                    <button
                        className="btn btn-danger"
                        style={{ flex: 1, opacity: stopping ? 0.6 : 1 }}
                        onClick={handleStop}
                        disabled={stopping}
                    >
                        {stopping ? '停止中...' : '⏹ 停止录制'}
                    </button>
                </div>
            </div>

            {/* 脱敏控制 */}
            <div className="card">
                <div className="card-title">🔒 隐私脱敏</div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button
                        className="btn btn-purple"
                        style={{ flex: 1 }}
                        onClick={() => {
                            chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                                if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'MARK_MODE_ENTER' });
                            });
                        }}
                    >
                        🎯 即点即脱敏
                    </button>
                    <button className="btn btn-ghost" style={{ flex: 1 }} onClick={handleAddMaskRule}>
                        ＋ 添加规则
                    </button>
                </div>
                {recordingState.maskRules.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                        <div className="label">已生效规则（{recordingState.maskRules.length}条）</div>
                        {recordingState.maskRules.map((r, i) => (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
                                <span><span className="tag">{r.rule_type}</span> {r.pattern.slice(0, 20)}</span>
                                <span style={{ color: 'var(--purple)' }}>→ {r.alias}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="alert alert-info">
                💡 在目标页面操作，步骤会自动捕获并脱敏。停止录制后即可生成文档。
            </div>
        </div>
    );
}
