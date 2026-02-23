package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gpilot/backend/internal/db"
)

// DocService 文档生成服务
type DocService struct{}

func NewDocService() *DocService { return &DocService{} }

// DocStep 文档步骤
type DocStep struct {
	StepIndex     int    `json:"step_index"`
	Action        string `json:"action"`
	Description   string `json:"description"`
	TechNote      string `json:"tech_note,omitempty"`
	ScreenshotID  string `json:"screenshot_id"`
	ScreenshotURL string `json:"screenshot_url,omitempty"` // base64 data URL
	PageURL       string `json:"page_url,omitempty"`
	PageTitle     string `json:"page_title"`
	IsEdited      bool   `json:"is_edited"`
}

// DocSection 文档章节
type DocSection struct {
	SectionIndex int       `json:"section_index"`
	Title        string    `json:"title"`
	Steps        []DocStep `json:"steps"`
}

// GeneratedDocContent 文档内容
type GeneratedDocContent struct {
	SessionTitle  string       `json:"session_title"`
	ProjectName   string       `json:"project_name"`
	GeneratedAt   string       `json:"generated_at"`
	BusinessView  []DocSection `json:"business_view"`
	TechnicalView []DocSection `json:"technical_view"`
}

// BuildDocument 聚合 steps 构建双视图文档
func (s *DocService) BuildDocument(sessionID string) (*GeneratedDocContent, error) {
	var session db.Session
	if err := db.DB.First(&session, "id = ?", sessionID).Error; err != nil {
		return nil, fmt.Errorf("session not found: %w", err)
	}

	var project db.Project
	db.DB.First(&project, "id = ?", session.ProjectID)

	var steps []db.RecordingStep
	db.DB.Where("session_id = ?", sessionID).Order("step_index").Find(&steps)

	// 加载截图
	screenshotMap := make(map[string]string)
	var screenshots []db.Screenshot
	db.DB.Where("session_id = ?", sessionID).Find(&screenshots)
	for _, sc := range screenshots {
		screenshotMap[sc.StepID] = sc.DataURL
	}

	// 构建业务视图 steps
	bizSteps := make([]DocStep, 0, len(steps))
	techSteps := make([]DocStep, 0, len(steps))

	for _, step := range steps {
		desc := step.AIDescription
		if desc == "" {
			desc = step.TargetElement
		}
		if desc == "" {
			desc = fmt.Sprintf("在 [%s] 页面执行 %s 操作", step.PageTitle, step.Action)
		}

		bizStep := DocStep{
			StepIndex:     step.StepIndex,
			Action:        step.Action,
			Description:   desc,
			ScreenshotID:  step.ScreenshotID,
			ScreenshotURL: screenshotMap[step.ID],
			PageTitle:     step.PageTitle,
			IsEdited:      step.IsEdited,
		}
		bizSteps = append(bizSteps, bizStep)

		techStep := bizStep
		techStep.PageURL = step.PageURL
		techStep.TechNote = fmt.Sprintf(
			"元素：%s\nXPath：%s\nCSS：%s\nAction：%s",
			step.TargetElement, step.TargetXPath, step.TargetSelector, step.Action,
		)
		techSteps = append(techSteps, techStep)
	}

	content := &GeneratedDocContent{
		SessionTitle: session.Title,
		ProjectName:  project.Name,
		GeneratedAt:  time.Now().Format("2006-01-02 15:04:05"),
		BusinessView: []DocSection{
			{SectionIndex: 1, Title: session.Title + " - 操作说明", Steps: bizSteps},
		},
		TechnicalView: []DocSection{
			{SectionIndex: 1, Title: session.Title + " - 技术参考", Steps: techSteps},
		},
	}

	return content, nil
}

// SaveGeneratedDoc 保存生成的文档到数据库
func (s *DocService) SaveGeneratedDoc(sessionID string, content *GeneratedDocContent) (*db.GeneratedDocument, error) {
	bizJSON, _ := json.Marshal(content.BusinessView)
	techJSON, _ := json.Marshal(content.TechnicalView)

	var session db.Session
	db.DB.First(&session, "id = ?", sessionID)

	doc := &db.GeneratedDocument{
		SessionID:     sessionID,
		ProjectID:     session.ProjectID,
		Status:        "draft",
		BusinessView:  string(bizJSON),
		TechnicalView: string(techJSON),
	}

	if err := db.DB.Create(doc).Error; err != nil {
		return nil, err
	}

	// 更新 session 的 generated_doc_id
	db.DB.Model(&session).Update("generated_doc_id", doc.ID)

	return doc, nil
}

// GenerateMarkdown 生成 Markdown 格式
func (s *DocService) GenerateMarkdown(content *GeneratedDocContent, viewType string) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("# %s\n\n", content.SessionTitle))
	sb.WriteString(fmt.Sprintf("> 项目：%s  \n> 生成时间：%s\n\n---\n\n", content.ProjectName, content.GeneratedAt))

	var sections []DocSection
	if viewType == "technical" {
		sections = content.TechnicalView
		sb.WriteString("## 技术参考文档\n\n")
	} else {
		sections = content.BusinessView
		sb.WriteString("## 操作说明文档\n\n")
	}

	for _, section := range sections {
		sb.WriteString(fmt.Sprintf("## %s\n\n", section.Title))
		for _, step := range section.Steps {
			sb.WriteString(fmt.Sprintf("### 第 %d 步\n\n", step.StepIndex))
			sb.WriteString(fmt.Sprintf("%s\n\n", step.Description))
			if step.TechNote != "" {
				sb.WriteString(fmt.Sprintf("```\n%s\n```\n\n", step.TechNote))
			}
			if step.ScreenshotURL != "" {
				sb.WriteString(fmt.Sprintf("![步骤%d截图](%s)\n\n", step.StepIndex, step.ScreenshotURL))
			}
			sb.WriteString("---\n\n")
		}
	}

	return sb.String()
}
