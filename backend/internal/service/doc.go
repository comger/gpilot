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

	// 构建业务视图 steps (支持按区域合并所有连续操作)
	bizSteps := make([]DocStep, 0, len(steps))
	techSteps := make([]DocStep, 0, len(steps))

	type stepContext struct {
		location string
		compName string
		purpose  string
		verb     string
	}

	parseStep := func(t string, action string) stepContext {
		ctx := stepContext{location: "页面区域", compName: "组件", purpose: "业务交互"}

		// 提取位置
		const locAnchor = "页面的 "
		if idx := strings.Index(t, locAnchor); idx != -1 {
			sub := t[idx+len(locAnchor):]
			if endIdx := strings.Index(sub, "，"); endIdx != -1 {
				ctx.location = strings.TrimSpace(sub[:endIdx])
			}
		}

		// 提取组件名
		const compAnchor = "功能为 "
		if idx := strings.Index(t, compAnchor); idx != -1 {
			sub := t[idx+len(compAnchor):]
			if endIdx := strings.Index(sub, " 的"); endIdx != -1 {
				ctx.compName = strings.TrimSpace(sub[:endIdx])
			}
		}

		// 提取目的
		const purposeAnchor = "实现 "
		if idx := strings.Index(t, purposeAnchor); idx != -1 {
			sub := t[idx+len(purposeAnchor):]
			ctx.purpose = strings.TrimRight(strings.TrimSpace(sub), "。")
		}

		// 提取动词 - 优先从语义描述中提取，其次根据 action 兜底
		if strings.Contains(t, "录入了") {
			ctx.verb = "录入"
		} else if strings.Contains(t, "切换到") {
			ctx.verb = "切换到"
		} else if strings.Contains(t, "选择了") {
			ctx.verb = "选择"
		} else if strings.Contains(t, "点击了") {
			ctx.verb = "点击"
		} else {
			switch action {
			case "click":
				ctx.verb = "点击"
			case "input":
				ctx.verb = "录入"
			case "select":
				ctx.verb = "选择"
			default:
				ctx.verb = "操作"
			}
		}
		return ctx
	}

	var currentGroup []db.RecordingStep

	flushGroup := func() {
		if len(currentGroup) == 0 {
			return
		}

		first := currentGroup[0]
		last := currentGroup[len(currentGroup)-1]

		var desc string
		if len(currentGroup) == 1 {
			desc = first.AIDescription
			if desc == "" {
				desc = first.TargetElement
			}
		} else {
			// 聚合描述生成
			actions := []string{}
			lastPurpose := ""
			firstCtx := parseStep(first.TargetElement, first.Action)

			for _, s := range currentGroup {
				ctx := parseStep(s.TargetElement, s.Action)
				actions = append(actions, fmt.Sprintf("%s 【%s】", ctx.verb, ctx.compName))
				lastPurpose = ctx.purpose
			}

			desc = fmt.Sprintf("在 %s 页面的 %s，依次 %s，最终实现 %s。",
				first.PageTitle, firstCtx.location, strings.Join(actions, "、"), lastPurpose)
		}

		if desc == "" {
			desc = fmt.Sprintf("在 [%s] 页面执行 %s 操作", first.PageTitle, first.Action)
		}

		bizStep := DocStep{
			StepIndex:     first.StepIndex,
			Action:        first.Action,
			Description:   desc,
			ScreenshotID:  last.ScreenshotID,
			ScreenshotURL: screenshotMap[last.ID],
			PageTitle:     first.PageTitle,
			IsEdited:      first.IsEdited,
		}
		bizSteps = append(bizSteps, bizStep)

		// 技术视图暂不合并，保持原始细节
		for _, s := range currentGroup {
			tStep := DocStep{
				StepIndex:     s.StepIndex,
				Action:        s.Action,
				Description:   s.TargetElement,
				ScreenshotID:  s.ScreenshotID,
				ScreenshotURL: screenshotMap[s.ID],
				PageTitle:     s.PageTitle,
				PageURL:       s.PageURL,
				TechNote: fmt.Sprintf(
					"元素：%s\nXPath：%s\nCSS：%s\nAction：%s",
					s.TargetElement, s.TargetXPath, s.TargetSelector, s.Action,
				),
			}
			techSteps = append(techSteps, tStep)
		}

		currentGroup = nil
	}

	for _, step := range steps {
		if len(currentGroup) > 0 {
			prev := currentGroup[0]
			ctxPrev := parseStep(prev.TargetElement, prev.Action)
			ctxCurr := parseStep(step.TargetElement, step.Action)

			// 合并条件：同一页面 且 同一位置
			canMerge := step.PageTitle == prev.PageTitle && ctxCurr.location == ctxPrev.location

			if !canMerge {
				flushGroup()
			}
		}
		currentGroup = append(currentGroup, step)
	}
	flushGroup()

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
