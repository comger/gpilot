package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gpilot/backend/internal/db"
)

// ─────────────────────────────────────
// Project
// ─────────────────────────────────────

func GetProjects(c *gin.Context) {
	var projects []db.Project
	db.DB.Preload("Sessions").Find(&projects)
	c.JSON(http.StatusOK, gin.H{"data": projects})
}

func CreateProject(c *gin.Context) {
	var req struct {
		Name             string `json:"name" binding:"required"`
		Description      string `json:"description"`
		TemplateType     string `json:"template_type"`
		MaskingProfileID string `json:"masking_profile_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.TemplateType == "" {
		req.TemplateType = "both"
	}
	project := db.Project{
		Name:             req.Name,
		Description:      req.Description,
		TemplateType:     req.TemplateType,
		MaskingProfileID: req.MaskingProfileID,
	}
	if err := db.DB.Create(&project).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": project})
}

func GetProject(c *gin.Context) {
	var project db.Project
	if err := db.DB.Preload("Sessions").First(&project, "id = ?", c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "project not found"})
		return
	}

	// 填充 sessions 的步骤统计
	for i := range project.Sessions {
		var count int64
		db.DB.Model(&db.RecordingStep{}).Where("session_id = ?", project.Sessions[i].ID).Count(&count)
		project.Sessions[i].StepCount = count
	}

	c.JSON(http.StatusOK, gin.H{"data": project})
}

func DeleteProject(c *gin.Context) {
	if err := db.DB.Delete(&db.Project{}, "id = ?", c.Param("id")).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// ─────────────────────────────────────
// Session
// ─────────────────────────────────────

func GetSessions(c *gin.Context) {
	projectID := c.Query("project_id")
	var sessions []db.Session
	q := db.DB.Order("created_at desc")
	if projectID != "" {
		q = q.Where("project_id = ?", projectID)
	}
	q.Find(&sessions)

	// 填充步骤统计
	for i := range sessions {
		var count int64
		db.DB.Model(&db.RecordingStep{}).Where("session_id = ?", sessions[i].ID).Count(&count)
		sessions[i].StepCount = count
	}

	c.JSON(http.StatusOK, gin.H{"data": sessions})
}

func CreateSession(c *gin.Context) {
	var req struct {
		ProjectID string `json:"project_id" binding:"required"`
		Title     string `json:"title" binding:"required"`
		TargetURL string `json:"target_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	now := time.Now()
	session := db.Session{
		ProjectID: req.ProjectID,
		Title:     req.Title,
		TargetURL: req.TargetURL,
		Status:    "recording",
		StartedAt: &now,
	}
	if err := db.DB.Create(&session).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": session})
}

func GetSession(c *gin.Context) {
	var session db.Session
	if err := db.DB.First(&session, "id = ?", c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": session})
}

func UpdateSessionStatus(c *gin.Context) {
	var req struct {
		Status string `json:"status" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var session db.Session
	if err := db.DB.First(&session, "id = ?", c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}

	updates := map[string]interface{}{"status": req.Status}
	if req.Status == "completed" {
		now := time.Now()
		updates["ended_at"] = &now
	}
	db.DB.Model(&session).Updates(updates)
	c.JSON(http.StatusOK, gin.H{"data": session})
}

func DeleteSession(c *gin.Context) {
	id := c.Param("id")
	db.DB.Delete(&db.RecordingStep{}, "session_id = ?", id)
	db.DB.Delete(&db.Screenshot{}, "session_id = ?", id)
	db.DB.Delete(&db.GeneratedDocument{}, "session_id = ?", id)
	db.DB.Delete(&db.Session{}, "id = ?", id)
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// ─────────────────────────────────────
// Step
// ─────────────────────────────────────

func GetSteps(c *gin.Context) {
	sessionID := c.Param("id")
	var steps []db.RecordingStep
	db.DB.Where("session_id = ?", sessionID).Order("step_index").Find(&steps)
	c.JSON(http.StatusOK, gin.H{"data": steps})
}

func CreateStep(c *gin.Context) {
	var req struct {
		SessionID      string `json:"session_id"`
		StepIndex      int    `json:"step_index"`
		Timestamp      int64  `json:"timestamp"`
		Action         string `json:"action" binding:"required"`
		TargetSelector string `json:"target_selector"`
		TargetXPath    string `json:"target_xpath"`
		TargetElement  string `json:"target_element"`
		AriaLabel      string `json:"aria_label"`
		MaskedText     string `json:"masked_text"`
		InputValue     string `json:"input_value"`
		PageURL        string `json:"page_url"`
		PageTitle      string `json:"page_title"`
		IsMasked       bool   `json:"is_masked"`
		DOMFingerprint string `json:"dom_fingerprint"`
		// 截图（base64）
		ScreenshotDataURL string `json:"screenshot_data_url"`
		ScreenshotWidth   int    `json:"screenshot_width"`
		ScreenshotHeight  int    `json:"screenshot_height"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	sessionID := c.Param("id")
	if req.SessionID == "" {
		req.SessionID = sessionID
	}

	// 自动计算步骤序号
	if req.StepIndex == 0 {
		var count int64
		db.DB.Model(&db.RecordingStep{}).Where("session_id = ?", sessionID).Count(&count)
		req.StepIndex = int(count) + 1
	}

	step := db.RecordingStep{
		SessionID:      sessionID,
		StepIndex:      req.StepIndex,
		Timestamp:      req.Timestamp,
		Action:         req.Action,
		TargetSelector: req.TargetSelector,
		TargetXPath:    req.TargetXPath,
		TargetElement:  req.TargetElement,
		AriaLabel:      req.AriaLabel,
		MaskedText:     req.MaskedText,
		InputValue:     req.InputValue,
		PageURL:        req.PageURL,
		PageTitle:      req.PageTitle,
		IsMasked:       req.IsMasked,
		DOMFingerprint: req.DOMFingerprint,
	}
	if err := db.DB.Create(&step).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 保存截图
	if req.ScreenshotDataURL != "" {
		screenshot := db.Screenshot{
			SessionID:  sessionID,
			StepID:     step.ID,
			CapturedAt: req.Timestamp,
			DataURL:    req.ScreenshotDataURL,
			Width:      req.ScreenshotWidth,
			Height:     req.ScreenshotHeight,
		}
		db.DB.Create(&screenshot)
		db.DB.Model(&step).Update("screenshot_id", screenshot.ID)
		step.ScreenshotID = screenshot.ID
	}

	c.JSON(http.StatusCreated, gin.H{"data": step})
}

func UpdateStep(c *gin.Context) {
	var req struct {
		AIDescription string `json:"ai_description"`
		IsEdited      *bool  `json:"is_edited"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	updates := map[string]interface{}{}
	if req.AIDescription != "" {
		updates["ai_description"] = req.AIDescription
	}
	if req.IsEdited != nil {
		updates["is_edited"] = *req.IsEdited
	}
	db.DB.Model(&db.RecordingStep{}).Where("id = ?", c.Param("stepId")).Updates(updates)
	c.JSON(http.StatusOK, gin.H{"message": "updated"})
}

// ─────────────────────────────────────
// Screenshot
// ─────────────────────────────────────

func GetScreenshot(c *gin.Context) {
	var screenshot db.Screenshot
	if err := db.DB.First(&screenshot, "id = ?", c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": screenshot})
}

// ─────────────────────────────────────
// Masking Profile & Rules
// ─────────────────────────────────────

func GetMaskingProfiles(c *gin.Context) {
	var profiles []db.MaskingProfile
	db.DB.Preload("Rules").Find(&profiles)
	c.JSON(http.StatusOK, gin.H{"data": profiles})
}

func CreateMaskingProfile(c *gin.Context) {
	var req struct {
		Name  string           `json:"name" binding:"required"`
		Rules []db.MaskingRule `json:"rules"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	profile := db.MaskingProfile{Name: req.Name}
	db.DB.Create(&profile)

	for _, rule := range req.Rules {
		rule.ProfileID = profile.ID
		db.DB.Create(&rule)
	}
	db.DB.Preload("Rules").First(&profile, "id = ?", profile.ID)
	c.JSON(http.StatusCreated, gin.H{"data": profile})
}

func AddMaskingRule(c *gin.Context) {
	var req struct {
		RuleType    string `json:"rule_type" binding:"required"`
		Pattern     string `json:"pattern" binding:"required"`
		Alias       string `json:"alias" binding:"required"`
		Scope       string `json:"scope"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	scope := req.Scope
	if scope == "" {
		scope = "session"
	}
	rule := db.MaskingRule{
		ProfileID:   c.Param("profileId"),
		RuleType:    req.RuleType,
		Pattern:     req.Pattern,
		Alias:       req.Alias,
		Scope:       scope,
		IsActive:    true,
		Description: req.Description,
	}
	db.DB.Create(&rule)
	c.JSON(http.StatusCreated, gin.H{"data": rule})
}

func GetDefaultMaskingRules(c *gin.Context) {
	// 内置默认规则（正则）
	defaults := []map[string]string{
		{"pattern": `1[3-9]\d{9}`, "alias": "【手机号】", "type": "regex", "description": "手机号码"},
		{"pattern": `\d{17}[\dX]`, "alias": "【身份证号】", "type": "regex", "description": "身份证号"},
		{"pattern": `[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`, "alias": "【邮箱】", "type": "regex", "description": "电子邮箱"},
		{"pattern": `\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}`, "alias": "【银行卡号】", "type": "regex", "description": "银行卡号"},
		{"pattern": `\d{6}`, "alias": "【邮政编码】", "type": "regex", "description": "邮政编码"},
	}
	c.JSON(http.StatusOK, gin.H{"data": defaults})
}
