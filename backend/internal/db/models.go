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
	ID        string `gorm:"primaryKey;type:text"`
	CreatedAt time.Time
	UpdatedAt time.Time
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
	Name             string `gorm:"not null"`
	Description      string
	MaskingProfileID string
	TemplateType     string    `gorm:"default:'both'"` // business|technical|both
	Sessions         []Session `gorm:"foreignKey:ProjectID"`
}

// ─────────────────────────────────────
// Session 录制会话
// ─────────────────────────────────────
type Session struct {
	Base
	ProjectID      string `gorm:"not null;index"`
	Title          string `gorm:"not null"`
	Status         string `gorm:"default:'idle'"` // idle|recording|paused|completed|generating|exported
	StartedAt      *time.Time
	EndedAt        *time.Time
	TargetURL      string
	GeneratedDocID string
	Steps          []RecordingStep `gorm:"foreignKey:SessionID"`
}

// ─────────────────────────────────────
// RecordingStep 操作步骤
// ─────────────────────────────────────
type RecordingStep struct {
	Base
	SessionID      string `gorm:"not null;index"`
	StepIndex      int    `gorm:"not null"`
	Timestamp      int64
	Action         string `gorm:"not null"` // click|input|select|drag|navigation|scroll|hover
	TargetSelector string
	TargetXPath    string
	TargetElement  string
	AriaLabel      string
	MaskedText     string
	InputValue     string
	PageURL        string
	PageTitle      string
	ScreenshotID   string
	AIDescription  string
	AINotes        string
	IsEdited       bool   `gorm:"default:false"`
	IsMasked       bool   `gorm:"default:false"`
	DOMFingerprint string `gorm:"index"`
}

// ─────────────────────────────────────
// Screenshot 截图（存 base64 dataUrl）
// ─────────────────────────────────────
type Screenshot struct {
	Base
	SessionID     string `gorm:"not null;index"`
	StepID        string `gorm:"not null;index"`
	CapturedAt    int64
	DataURL       string `gorm:"type:text"` // base64（已脱敏）
	Width         int
	Height        int
	MaskedRegions string `gorm:"type:text"` // JSON
	IsRawDeleted  bool   `gorm:"default:false"`
}

// ─────────────────────────────────────
// MaskingProfile 脱敏规则集
// ─────────────────────────────────────
type MaskingProfile struct {
	Base
	Name  string        `gorm:"not null"`
	Rules []MaskingRule `gorm:"foreignKey:ProfileID"`
}

// MaskingRule 脱敏规则
type MaskingRule struct {
	Base
	ProfileID   string `gorm:"not null;index"`
	RuleType    string `gorm:"not null"` // regex|exact|element_click
	Pattern     string `gorm:"not null"`
	Alias       string `gorm:"not null"`
	Scope       string `gorm:"default:'session'"` // global|session
	IsActive    bool   `gorm:"default:true"`
	Description string
}

// ─────────────────────────────────────
// GeneratedDocument 生成的文档
// ─────────────────────────────────────
type GeneratedDocument struct {
	Base
	SessionID     string `gorm:"not null;index"`
	ProjectID     string `gorm:"not null;index"`
	Status        string `gorm:"default:'draft'"` // draft|reviewed|exported
	BusinessView  string `gorm:"type:text"`       // JSON
	TechnicalView string `gorm:"type:text"`       // JSON
}

// ─────────────────────────────────────
// LLMProvider 已配置的模型提供商
// ─────────────────────────────────────
type LLMProvider struct {
	Base
	Name      string `gorm:"not null"` // gemini|zhipu|ollama|openrouter|openai
	APIKey    string
	BaseURL   string
	Model     string
	IsDefault bool `gorm:"default:false"`
	IsActive  bool `gorm:"default:true"`
}
