package db

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ─────────────────────────────────────
// 基础模型（所有表共用）
// ─────────────────────────────────────
type Base struct {
	ID        string    `gorm:"primaryKey;type:text" json:"id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (b *Base) BeforeCreate(tx *gorm.DB) error {
	if b.ID == "" {
		b.ID = uuid.New().String()
	}
	return nil
}

// ─────────────────────────────────────
// Project 项目
// ─────────────────────────────────────
type Project struct {
	Base
	Name             string    `gorm:"not null"              json:"name"`
	Description      string    `                             json:"description"`
	MaskingProfileID string    `                             json:"masking_profile_id,omitempty"`
	TemplateType     string    `gorm:"default:'both'"        json:"template_type"`
	Sessions         []Session `gorm:"foreignKey:ProjectID"  json:"sessions,omitempty"`
}

// ─────────────────────────────────────
// Session 录制会话
// ─────────────────────────────────────
type Session struct {
	Base
	ProjectID      string          `gorm:"not null;index"             json:"project_id"`
	Title          string          `gorm:"not null"                   json:"title"`
	Status         string          `gorm:"default:'idle'"             json:"status"`
	StartedAt      *time.Time      `                                  json:"started_at,omitempty"`
	EndedAt        *time.Time      `                                  json:"ended_at,omitempty"`
	TargetURL      string          `                                  json:"target_url"`
	GeneratedDocID string          `                                  json:"generated_doc_id,omitempty"`
	Steps          []RecordingStep `gorm:"foreignKey:SessionID"       json:"steps,omitempty"`
}

// ─────────────────────────────────────
// RecordingStep 操作步骤
// ─────────────────────────────────────
type RecordingStep struct {
	Base
	SessionID      string `gorm:"not null;index"  json:"session_id"`
	StepIndex      int    `gorm:"not null"        json:"step_index"`
	Timestamp      int64  `                       json:"timestamp"`
	Action         string `gorm:"not null"        json:"action"`
	TargetSelector string `                       json:"target_selector"`
	TargetXPath    string `                       json:"target_xpath"`
	TargetElement  string `                       json:"target_element"`
	AriaLabel      string `                       json:"aria_label,omitempty"`
	MaskedText     string `                       json:"masked_text"`
	InputValue     string `                       json:"input_value,omitempty"`
	PageURL        string `                       json:"page_url"`
	PageTitle      string `                       json:"page_title"`
	ScreenshotID   string `                       json:"screenshot_id,omitempty"`
	AIDescription  string `                       json:"ai_description,omitempty"`
	AINotes        string `                       json:"ai_notes,omitempty"`
	IsEdited       bool   `gorm:"default:false"   json:"is_edited"`
	IsMasked       bool   `gorm:"default:false"   json:"is_masked"`
	DOMFingerprint string `gorm:"index"           json:"dom_fingerprint,omitempty"`
}

// ─────────────────────────────────────
// Screenshot 截图（存 base64 dataUrl）
// ─────────────────────────────────────
type Screenshot struct {
	Base
	SessionID     string `gorm:"not null;index"  json:"session_id"`
	StepID        string `gorm:"not null;index"  json:"step_id"`
	CapturedAt    int64  `                       json:"captured_at"`
	DataURL       string `gorm:"type:text"       json:"data_url"`
	Width         int    `                       json:"width"`
	Height        int    `                       json:"height"`
	MaskedRegions string `gorm:"type:text"       json:"masked_regions,omitempty"`
	IsRawDeleted  bool   `gorm:"default:false"   json:"is_raw_deleted"`
}

// ─────────────────────────────────────
// MaskingProfile 脱敏规则集
// ─────────────────────────────────────
type MaskingProfile struct {
	Base
	Name  string        `gorm:"not null"                json:"name"`
	Rules []MaskingRule `gorm:"foreignKey:ProfileID"    json:"rules,omitempty"`
}

// MaskingRule 脱敏规则
type MaskingRule struct {
	Base
	ProfileID   string `gorm:"not null;index"  json:"profile_id"`
	RuleType    string `gorm:"not null"        json:"rule_type"`
	Pattern     string `gorm:"not null"        json:"pattern"`
	Alias       string `gorm:"not null"        json:"alias"`
	Scope       string `gorm:"default:'session'" json:"scope"`
	IsActive    bool   `gorm:"default:true"    json:"is_active"`
	Description string `                       json:"description,omitempty"`
}

// ─────────────────────────────────────
// GeneratedDocument 生成的文档
// ─────────────────────────────────────
type GeneratedDocument struct {
	Base
	SessionID     string `gorm:"not null;index"  json:"session_id"`
	ProjectID     string `gorm:"not null;index"  json:"project_id"`
	Status        string `gorm:"default:'draft'" json:"status"`
	BusinessView  string `gorm:"type:text"       json:"business_view"`
	TechnicalView string `gorm:"type:text"       json:"technical_view"`
}

// ─────────────────────────────────────
// LLMProvider 已配置的模型提供商
// ─────────────────────────────────────
type LLMProvider struct {
	Base
	Name      string `gorm:"not null"        json:"name"`
	APIKey    string `                       json:"-"` // 不输出密钥
	BaseURL   string `                       json:"base_url"`
	Model     string `                       json:"model"`
	IsDefault bool   `gorm:"default:false"   json:"is_default"`
	IsActive  bool   `gorm:"default:true"    json:"is_active"`
}
