// G-Pilot 共享类型定义

export type ActionType = 'click' | 'input' | 'select' | 'drag' | 'navigation' | 'scroll' | 'hover';
export type SessionStatus = 'idle' | 'recording' | 'paused' | 'completed' | 'generating' | 'exported';
export type MessageType =
    | 'SESSION_START'
    | 'SESSION_PAUSE'
    | 'SESSION_RESUME'
    | 'SESSION_STOP'
    | 'STEP_CAPTURED'
    | 'CAPTURE_SCREENSHOT'
    | 'MASKING_RULE_ADD'
    | 'MASKING_APPLY_ALL'
    | 'STATE_SYNC_REQUEST'
    | 'STATE_SYNC_RESPONSE'
    | 'FLOATING_CONSOLE_SHOW'
    | 'FLOATING_CONSOLE_HIDE'
    | 'MARK_MODE_ENTER'
    | 'MARK_MODE_EXIT';

// 后端 API 根地址
export const API_BASE = 'http://localhost:3210/api/v1';

export interface ExtMessage<T = unknown> {
    type: MessageType;
    payload?: T;
    requestId?: string;
}

export interface Project {
    id: string;
    name: string;
    description?: string;
    template_type: 'business' | 'technical' | 'both';
    created_at: string;
    sessions?: Session[];
}

export interface Session {
    id: string;
    project_id: string;
    title: string;
    status: SessionStatus;
    started_at?: string;
    ended_at?: string;
    target_url: string;
    generated_doc_id?: string;
    created_at: string;
}

export interface RecordingStep {
    id: string;
    session_id: string;
    step_index: number;
    timestamp: number;
    action: ActionType;
    target_selector: string;
    target_xpath: string;
    target_element: string;
    aria_label?: string;
    masked_text: string;
    input_value?: string;
    page_url: string;
    page_title: string;
    screenshot_id?: string;
    ai_description?: string;
    is_edited: boolean;
    is_masked: boolean;
    dom_fingerprint?: string;
}

export interface MaskingRule {
    id?: string;
    rule_type: 'regex' | 'exact' | 'element_click';
    pattern: string;
    alias: string;
    scope: 'global' | 'session';
    is_active: boolean;
    description?: string;
}

export interface RecordingState {
    isRecording: boolean;
    isPaused: boolean;
    sessionId: string | null;
    projectId: string | null;
    stepCount: number;
    maskRules: MaskingRule[];
}
