// API 请求封装工具
import { API_BASE } from '../types';

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return json.data ?? json;
}

export async function apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const json = await res.json();
    return json.data ?? json;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const json = await res.json();
    return json.data ?? json;
}

// DOM 指纹生成（用于知识图谱跨录制去重）
export function generateDOMFingerprint(
    action: string,
    ariaLabel: string,
    tagName: string,
    text: string
): string {
    const str = [action, ariaLabel, tagName, text.slice(0, 30)].join('|');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash.toString(36);
}

// XPath 生成（稳定化处理）
export function getXPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
        let idx = 1;
        let sib = node.previousSibling;
        while (sib) {
            if (sib.nodeType === Node.ELEMENT_NODE && (sib as Element).tagName === node.tagName) idx++;
            sib = sib.previousSibling;
        }
        parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
        node = node.parentElement;
    }
    return '/' + parts.join('/');
}

// 获取稳定 CSS 选择器
export function getStableSelector(el: Element): string {
    if (el.id) return `#${el.id}`;
    if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
    if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`;
    // fallback: tagName + classes
    const classes = Array.from(el.classList).slice(0, 2).join('.');
    return classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
}

// 应用脱敏规则到文本
export function applyMaskingRules(
    text: string,
    rules: Array<{ rule_type: string; pattern: string; alias: string; is_active: boolean }>
): string {
    let result = text;
    for (const rule of rules) {
        if (!rule.is_active) continue;
        if (rule.rule_type === 'regex') {
            try {
                const re = new RegExp(rule.pattern, 'g');
                result = result.replace(re, rule.alias);
            } catch { }
        } else if (rule.rule_type === 'exact') {
            result = result.split(rule.pattern).join(rule.alias);
        }
    }
    return result;
}
