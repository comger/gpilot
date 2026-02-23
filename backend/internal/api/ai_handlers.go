package api

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gpilot/backend/internal/db"
	"github.com/gpilot/backend/internal/service"
)

var aiSvc *service.AIService
var docSvc *service.DocService

func SetServices(ai *service.AIService, doc *service.DocService) {
	aiSvc = ai
	docSvc = doc
}

// GetProvidersStatus VLM 提供商状态查询
func GetProvidersStatus(c *gin.Context) {
	statuses := aiSvc.GetProvidersStatus()
	c.JSON(http.StatusOK, gin.H{"data": statuses})
}

// GenerateStepDescription 单步骤 AI 描述生成（同步）
func GenerateStepDescription(c *gin.Context) {
	stepID := c.Param("stepId")
	var step db.RecordingStep
	if err := db.DB.First(&step, "id = ?", stepID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "step not found"})
		return
	}

	var screenshot db.Screenshot
	var screenshotB64 string
	if step.ScreenshotID != "" {
		db.DB.First(&screenshot, "id = ?", step.ScreenshotID)
		screenshotB64 = screenshot.DataURL
	}

	req := service.VLMRequest{
		StepAction:    step.Action,
		TargetElement: step.TargetElement,
		PageURL:       step.PageURL,
		PageTitle:     step.PageTitle,
		MaskedText:    step.MaskedText,
		ScreenshotB64: screenshotB64,
	}

	resp, err := aiSvc.GenerateStepDescription(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 保存描述到步骤
	db.DB.Model(&step).Update("ai_description", resp.Description)

	c.JSON(http.StatusOK, gin.H{
		"description": resp.Description,
		"provider":    resp.Provider,
		"is_free":     resp.UsedFree,
	})
}

// GenerateDoc 为整个 session 批量生成文档（SSE 流式进度）
func GenerateDoc(c *gin.Context) {
	sessionID := c.Param("id")

	var session db.Session
	if err := db.DB.First(&session, "id = ?", sessionID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	// 设置 SSE 响应头
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	progressCh := make(chan service.DocGenerateProgress, 20)

	go func() {
		_ = aiSvc.GenerateDocForSession(sessionID, progressCh)
	}()

	for progress := range progressCh {
		data, _ := json.Marshal(progress)
		c.SSEvent("progress", string(data))
		c.Writer.Flush()

		if progress.Done {
			// 生成文档内容并保存
			content, err := docSvc.BuildDocument(sessionID)
			if err == nil {
				doc, err := docSvc.SaveGeneratedDoc(sessionID, content)
				if err == nil {
					db.DB.Model(&session).Update("status", "completed")
					finalData, _ := json.Marshal(map[string]string{"doc_id": doc.ID})
					c.SSEvent("complete", string(finalData))
					c.Writer.Flush()
				}
			}
			break
		}
	}
}

// GetDocument 获取已生成的文档
func GetDocument(c *gin.Context) {
	var doc db.GeneratedDocument
	if err := db.DB.First(&doc, "id = ?", c.Param("docId")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "document not found"})
		return
	}

	var bizView, techView interface{}
	_ = json.Unmarshal([]byte(doc.BusinessView), &bizView)
	_ = json.Unmarshal([]byte(doc.TechnicalView), &techView)

	c.JSON(http.StatusOK, gin.H{
		"data": map[string]interface{}{
			"id":             doc.ID,
			"session_id":     doc.SessionID,
			"project_id":     doc.ProjectID,
			"status":         doc.Status,
			"created_at":     doc.CreatedAt,
			"business_view":  bizView,
			"technical_view": techView,
		},
	})
}

// ExportDocument 导出文档（md/json）
func ExportDocument(c *gin.Context) {
	docID := c.Param("docId")
	format := c.Query("format") // md|json
	viewType := c.Query("view") // business|technical|both

	if format == "" {
		format = "md"
	}
	if viewType == "" {
		viewType = "business"
	}

	var session db.Session
	if err := db.DB.First(&session, "generated_doc_id = ?", docID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "doc not found"})
		return
	}

	content, err := docSvc.BuildDocument(session.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	switch format {
	case "md":
		md := docSvc.GenerateMarkdown(content, viewType)
		c.Header("Content-Disposition", `attachment; filename="manual.md"`)
		c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(md))
	case "json":
		c.JSON(http.StatusOK, gin.H{"data": content})
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported format"})
	}
}

// ─────────────────────────────────────
// LLM Provider Config CRUD
// ─────────────────────────────────────

func GetLLMProviders(c *gin.Context) {
	var providers []db.LLMProvider
	db.DB.Find(&providers)
	// 不返回 API Key（安全）
	type safeProvider struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Model     string `json:"model"`
		BaseURL   string `json:"base_url"`
		HasAPIKey bool   `json:"has_api_key"`
		IsDefault bool   `json:"is_default"`
		IsActive  bool   `json:"is_active"`
	}
	var safe []safeProvider
	for _, p := range providers {
		safe = append(safe, safeProvider{
			ID:        p.ID,
			Name:      p.Name,
			Model:     p.Model,
			BaseURL:   p.BaseURL,
			HasAPIKey: p.APIKey != "",
			IsDefault: p.IsDefault,
			IsActive:  p.IsActive,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": safe})
}

func UpsertLLMProvider(c *gin.Context) {
	var req struct {
		Name      string `json:"name" binding:"required"`
		APIKey    string `json:"api_key"`
		BaseURL   string `json:"base_url"`
		Model     string `json:"model"`
		IsDefault bool   `json:"is_default"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var provider db.LLMProvider
	if err := db.DB.First(&provider, "name = ?", req.Name).Error; err != nil {
		// 新建
		provider = db.LLMProvider{
			Name:      req.Name,
			APIKey:    req.APIKey,
			BaseURL:   req.BaseURL,
			Model:     req.Model,
			IsDefault: req.IsDefault,
			IsActive:  true,
		}
		db.DB.Create(&provider)
	} else {
		// 更新
		updates := map[string]interface{}{
			"is_default": req.IsDefault,
			"is_active":  true,
		}
		if req.APIKey != "" {
			updates["api_key"] = req.APIKey
		}
		if req.BaseURL != "" {
			updates["base_url"] = req.BaseURL
		}
		if req.Model != "" {
			updates["model"] = req.Model
		}
		db.DB.Model(&provider).Updates(updates)
	}

	if req.IsDefault {
		db.DB.Model(&db.LLMProvider{}).Where("name != ?", req.Name).Update("is_default", false)
	}

	c.JSON(http.StatusOK, gin.H{"message": "saved", "id": provider.ID})
}
