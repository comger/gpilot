import React, { useState, useEffect } from 'react';

interface ProviderStatus {
    id: string;
    name: string;
    available: boolean;
    is_free: boolean;
    reason: string;
}

interface ProviderConfig {
    name: string;
    displayName: string;
    apiKeyLabel: string;
    apiKeyPlaceholder: string;
    defaultModel: string;
    defaultBaseURL: string;
    docLink: string;
    isFree: boolean;
    priority: number;
}

const PROVIDERS: ProviderConfig[] = [
    {
        name: 'ollama',
        displayName: 'Ollama 本地',
        apiKeyLabel: '无需 API Key',
        apiKeyPlaceholder: '',
        defaultModel: 'qwen2.5-vl:7b',
        defaultBaseURL: 'http://localhost:11434',
        docLink: 'https://ollama.com',
        isFree: true,
        priority: 1,
    },
    {
        name: 'zhipu',
        displayName: '智谱 GLM-4V-Flash',
        apiKeyLabel: 'ZHIPU API Key',
        apiKeyPlaceholder: '从 open.bigmodel.cn 获取免费 Key',
        defaultModel: 'glm-4v-flash',
        defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
        docLink: 'https://open.bigmodel.cn',
        isFree: true,
        priority: 2,
    },
    {
        name: 'gemini',
        displayName: 'Google Gemini 2.0 Flash',
        apiKeyLabel: 'GEMINI API Key',
        apiKeyPlaceholder: '从 aistudio.google.com 获取免费 Key',
        defaultModel: 'gemini-2.0-flash',
        defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
        docLink: 'https://aistudio.google.com/apikey',
        isFree: true,
        priority: 3,
    },
    {
        name: 'openrouter',
        displayName: 'OpenRouter Qwen2.5-VL',
        apiKeyLabel: 'OPENROUTER API Key',
        apiKeyPlaceholder: '从 openrouter.ai 获取',
        defaultModel: 'qwen/qwen2.5-vl-72b-instruct:free',
        defaultBaseURL: 'https://openrouter.ai/api/v1',
        docLink: 'https://openrouter.ai',
        isFree: true,
        priority: 4,
    },
    {
        name: 'openai',
        displayName: 'OpenAI GPT-4o (付费)',
        apiKeyLabel: 'OPENAI API Key',
        apiKeyPlaceholder: '从 platform.openai.com 获取（付费）',
        defaultModel: 'gpt-4o-mini',
        defaultBaseURL: 'https://api.openai.com/v1',
        docLink: 'https://platform.openai.com',
        isFree: false,
        priority: 5,
    },
];

export default function SettingsTab() {
    const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
    const [selected, setSelected] = useState<ProviderConfig | null>(null);
    const [apiKey, setApiKey] = useState('');
    const [baseURL, setBaseURL] = useState('');
    const [model, setModel] = useState('');
    const [isDefault, setIsDefault] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saving, setSaving] = useState(false);
    const [backendOk, setBackendOk] = useState<boolean | null>(null);

    useEffect(() => {
        fetch('http://localhost:3210/health')
            .then(r => r.ok ? fetch('http://localhost:3210/api/v1/ai/providers/status') : Promise.reject())
            .then(r => r.json())
            .then(data => { setStatuses(data.data || []); setBackendOk(true); })
            .catch(() => setBackendOk(false));
    }, []);

    const handleSelect = (p: ProviderConfig) => {
        setSelected(p);
        setApiKey('');
        setBaseURL(p.defaultBaseURL);
        setModel(p.defaultModel);
        setIsDefault(false);
        setSaved(false);
    };

    const handleSave = async () => {
        if (!selected) return;
        setSaving(true);
        try {
            await fetch('http://localhost:3210/api/v1/llm/providers', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: selected.name,
                    api_key: apiKey,
                    base_url: baseURL,
                    model,
                    is_default: isDefault,
                }),
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
            // 刷新状态
            const r = await fetch('http://localhost:3210/api/v1/ai/providers/status');
            const d = await r.json();
            setStatuses(d.data || []);
        } catch { }
        setSaving(false);
    };

    const getStatus = (name: string) => statuses.find(s => s.id === name);

    if (selected) {
        return (
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setSelected(null)}>
                        ← 返回
                    </button>
                    <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{selected.displayName}</div>
                        <span className={`badge ${selected.isFree ? 'badge-free' : 'badge-paused'}`}>
                            {selected.isFree ? '免费' : '付费'}
                        </span>
                    </div>
                </div>

                {selected.name !== 'ollama' && (
                    <div className="alert alert-info" style={{ marginBottom: 12 }}>
                        📎 <a href={selected.docLink} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                            前往 {selected.docLink.replace('https://', '')} 获取 API Key
                        </a>
                    </div>
                )}

                {selected.name === 'ollama' && (
                    <div className="alert alert-info" style={{ marginBottom: 12 }}>
                        📦 本地模型，需要先安装 Ollama 并运行：<br />
                        <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4 }}>
                            ollama pull {selected.defaultModel}
                        </code>
                    </div>
                )}

                <div className="card">
                    {selected.name !== 'ollama' && (
                        <div className="form-group">
                            <label className="label">{selected.apiKeyLabel}</label>
                            <input
                                className="input"
                                type="password"
                                placeholder={selected.apiKeyPlaceholder}
                                value={apiKey}
                                onChange={e => setApiKey(e.target.value)}
                            />
                        </div>
                    )}
                    <div className="form-group">
                        <label className="label">Base URL</label>
                        <input className="input" type="text" value={baseURL} onChange={e => setBaseURL(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label className="label">模型名称</label>
                        <input className="input" type="text" value={model} onChange={e => setModel(e.target.value)} />
                    </div>
                    <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                            id="is-default"
                            type="checkbox"
                            checked={isDefault}
                            onChange={e => setIsDefault(e.target.checked)}
                            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
                        />
                        <label htmlFor="is-default" style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                            设为默认 VLM 提供商
                        </label>
                    </div>

                    {saved && <div className="alert alert-success" style={{ marginBottom: 10 }}>✅ 配置已保存</div>}
                    <button className="btn btn-primary btn-full" onClick={handleSave} disabled={saving || !backendOk}>
                        {saving ? '保存中...' : '💾 保存配置'}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div>
            {backendOk === false && (
                <div className="alert alert-error" style={{ marginBottom: 14 }}>
                    ⚠️ 后端服务未连接。请先启动后端：<br />
                    <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: 4 }}>
                        cd backend && go run cmd/server/main.go
                    </code>
                </div>
            )}

            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>⚡ VLM 路由配置</span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>免费优先策略</span>
            </div>

            <div className="alert alert-info" style={{ marginBottom: 12 }}>
                🔗 系统按优先级自动选择可用的免费 VLM，无需付费 API 即可完整使用
            </div>

            {PROVIDERS.map(p => {
                const st = getStatus(p.name);
                return (
                    <div
                        key={p.name}
                        className="list-item"
                        style={{ borderColor: st?.available ? 'rgba(72,187,120,0.3)' : 'transparent' }}
                        onClick={() => handleSelect(p)}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{
                                width: 24, height: 24, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: p.isFree ? 'rgba(99,179,237,0.15)' : 'rgba(237,137,54,0.15)',
                                fontSize: 11, fontWeight: 700,
                                color: p.isFree ? 'var(--accent)' : 'var(--warning)',
                            }}>
                                {p.priority}
                            </div>
                            <div>
                                <div className="list-item-title" style={{ fontSize: 12 }}>{p.displayName}</div>
                                <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                                    <span className={`badge ${p.isFree ? 'badge-free' : 'badge-paused'}`} style={{ fontSize: 10 }}>
                                        {p.isFree ? '免费' : '付费'}
                                    </span>
                                    {st && (
                                        <span className={`badge ${st.available ? 'badge-success' : 'badge-idle'}`} style={{ fontSize: 10 }}>
                                            {st.available ? '✓ 已配置' : '未配置'}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>配置 →</span>
                    </div>
                );
            })}
        </div>
    );
}
