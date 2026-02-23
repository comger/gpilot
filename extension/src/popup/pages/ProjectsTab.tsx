import React, { useState, useEffect } from 'react';
import type { Project, Session } from '../../shared/types';
import { apiGet, apiPost } from '../../shared/utils';

export default function ProjectsTab() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProject, setSelectedProject] = useState<Project | null>(null);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [showNew, setShowNew] = useState(false);
    const [newName, setNewName] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newTemplate, setNewTemplate] = useState<'business' | 'technical' | 'both'>('both');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const loadProjects = async () => {
        try {
            const ps = await apiGet<Project[]>('/projects');
            setProjects(ps);
        } catch {
            setError('加载项目失败，请检查后端连接');
        }
    };

    useEffect(() => { loadProjects(); }, []);

    useEffect(() => {
        if (selectedProject) {
            apiGet<Session[]>(`/sessions?project_id=${selectedProject.id}`).then(setSessions).catch(() => { });
        }
    }, [selectedProject]);

    const handleCreate = async () => {
        if (!newName.trim()) { setError('请填写项目名称'); return; }
        setLoading(true);
        try {
            await apiPost('/projects', { name: newName.trim(), description: newDesc, template_type: newTemplate });
            setNewName('');
            setNewDesc('');
            setShowNew(false);
            setError('');
            await loadProjects();
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    if (selectedProject) {
        return (
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <button
                        className="btn btn-ghost"
                        style={{ padding: '5px 10px', fontSize: 12 }}
                        onClick={() => setSelectedProject(null)}
                    >
                        ← 返回
                    </button>
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{selectedProject.name}</div>
                        {selectedProject.description && (
                            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{selectedProject.description}</div>
                        )}
                    </div>
                </div>

                <div className="card">
                    <div className="card-title">录制历史（{sessions.length}）</div>
                    {sessions.length === 0 ? (
                        <div className="empty">
                            <div className="empty-icon">🎙</div>
                            <div className="empty-text">该项目还没有录制记录</div>
                        </div>
                    ) : (
                        sessions.map(s => (
                            <div key={s.id} className="list-item">
                                <div>
                                    <div className="list-item-title">{s.title}</div>
                                    <div className="list-item-sub">
                                        {new Date(s.created_at).toLocaleString('zh-CN')}
                                        {s.target_url && ` · ${new URL(s.target_url).hostname}`}
                                    </div>
                                </div>
                                <span className={`badge ${s.status === 'completed' ? 'badge-success'
                                        : s.status === 'recording' ? 'badge-recording'
                                            : 'badge-idle'
                                    }`}>
                                    {s.status === 'completed' ? '已完成' : s.status === 'recording' ? '录制中' : s.status}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        );
    }

    return (
        <div>
            {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>我的项目（{projects.length}）</span>
                <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setShowNew(!showNew)}>
                    {showNew ? '✕ 取消' : '＋ 新建'}
                </button>
            </div>

            {showNew && (
                <div className="card" style={{ borderColor: 'rgba(99, 179, 237, 0.4)' }}>
                    <div className="card-title">创建新项目</div>
                    <div className="form-group">
                        <label className="label">项目名称 *</label>
                        <input className="input" type="text" placeholder="如：XX 行政服务平台" value={newName} onChange={e => setNewName(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label className="label">描述（选填）</label>
                        <input className="input" type="text" placeholder="简短描述这个项目" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label className="label">文档模板类型</label>
                        <select className="select" value={newTemplate} onChange={e => setNewTemplate(e.target.value as any)}>
                            <option value="both">业务 + 技术双视图</option>
                            <option value="business">仅业务视图</option>
                            <option value="technical">仅技术视图</option>
                        </select>
                    </div>
                    <button className="btn btn-success btn-full" onClick={handleCreate} disabled={loading}>
                        {loading ? '创建中...' : '✓ 创建项目'}
                    </button>
                </div>
            )}

            {projects.length === 0 && !showNew ? (
                <div className="empty">
                    <div className="empty-icon">📁</div>
                    <div className="empty-text">还没有项目，点击「新建」开始</div>
                </div>
            ) : (
                projects.map(p => (
                    <div key={p.id} className="list-item" onClick={() => setSelectedProject(p)}>
                        <div>
                            <div className="list-item-title">{p.name}</div>
                            <div className="list-item-sub">
                                {p.description || '暂无描述'} ·
                                <span className="tag" style={{ marginLeft: 4 }}>{p.template_type}</span>
                            </div>
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            {p.sessions?.length ?? 0} 次录制
                        </span>
                    </div>
                ))
            )}
        </div>
    );
}
