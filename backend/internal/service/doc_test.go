package service_test

import (
	"strings"
	"testing"
	"time"

	"github.com/gpilot/backend/internal/db"
	"github.com/gpilot/backend/internal/service"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupDB(t *testing.T) {
	t.Helper()
	var err error
	db.DB, err = gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("open DB: %v", err)
	}
	db.DB.AutoMigrate(
		&db.Project{}, &db.Session{}, &db.RecordingStep{},
		&db.Screenshot{}, &db.GeneratedDocument{}, &db.LLMProvider{},
	)
}

// ─────────────────────────────────────
// DocService 测试
// ─────────────────────────────────────

// 构造测试数据：项目 + session + N个步骤
func seedSessionWithSteps(t *testing.T, stepCount int) (projectID, sessionID string) {
	t.Helper()
	proj := db.Project{Name: "测试项目", Description: "DocService 测试"}
	db.DB.Create(&proj)

	now := time.Now()
	sess := db.Session{
		ProjectID: proj.ID,
		Title:     "测试录制会话",
		TargetURL: "http://test.example.com",
		Status:    "completed",
		StartedAt: &now,
	}
	db.DB.Create(&sess)

	actions := []string{"navigation", "click", "input", "click", "click"}
	pages := []string{"首页", "登录页", "表单页", "确认页", "完成页"}
	descs := []string{
		"第1步：打开系统首页",
		"第2步：点击登录按钮",
		"第3步：填写用户名（已脱敏）",
		"第4步：点击确认提交",
		"第5步：查看提交成功提示",
	}

	for i := 0; i < stepCount; i++ {
		actionIdx := i % len(actions)
		step := db.RecordingStep{
			SessionID:     sess.ID,
			StepIndex:     i + 1,
			Timestamp:     time.Now().Add(time.Duration(i) * time.Second).UnixMilli(),
			Action:        actions[actionIdx],
			TargetElement: "测试元素 " + pages[actionIdx],
			PageTitle:     pages[actionIdx],
			PageURL:       "http://test.example.com/page" + string(rune('0'+i)),
			MaskedText:    "操作文本" + string(rune('A'+i)),
			AIDescription: descs[actionIdx],
		}
		db.DB.Create(&step)
	}
	return proj.ID, sess.ID
}

func TestBuildDocument_NormalFlow(t *testing.T) {
	setupDB(t)
	_, sessionID := seedSessionWithSteps(t, 5)

	svc := service.NewDocService()
	content, err := svc.BuildDocument(sessionID)
	if err != nil {
		t.Fatalf("BuildDocument error: %v", err)
	}

	// 验证基本字段
	if content.SessionTitle != "测试录制会话" {
		t.Errorf("session title: %v", content.SessionTitle)
	}
	if content.ProjectName != "测试项目" {
		t.Errorf("project name: %v", content.ProjectName)
	}
	if content.GeneratedAt == "" {
		t.Error("generated_at is empty")
	}

	// 验证业务视图和技术视图
	if len(content.BusinessView) == 0 {
		t.Fatal("business_view is empty!")
	}
	if len(content.TechnicalView) == 0 {
		t.Fatal("technical_view is empty!")
	}

	bizSteps := content.BusinessView[0].Steps
	techSteps := content.TechnicalView[0].Steps

	if len(bizSteps) != 5 {
		t.Errorf("expected 5 biz steps, got %d", len(bizSteps))
	}
	if len(techSteps) != 5 {
		t.Errorf("expected 5 tech steps, got %d", len(techSteps))
	}

	// 技术视图应包含 TechNote（xpath/css/action 信息）
	for i, s := range techSteps {
		if s.TechNote == "" {
			t.Errorf("step %d tech_note is empty", i+1)
		}
		if s.PageURL == "" {
			t.Errorf("step %d page_url missing in tech view", i+1)
		}
	}

	// 业务视图步骤按序排列
	for i, s := range bizSteps {
		if s.StepIndex != i+1 {
			t.Errorf("step %d has wrong step_index: %d", i+1, s.StepIndex)
		}
		if s.Description == "" {
			t.Errorf("step %d description is empty", i+1)
		}
	}

	t.Logf("✅ BusinessView[0].Title: %s", content.BusinessView[0].Title)
	t.Logf("✅ TechnicalView[0].Title: %s", content.TechnicalView[0].Title)
}

func TestBuildDocument_EmptySession(t *testing.T) {
	setupDB(t)
	_, sessionID := seedSessionWithSteps(t, 0) // 0个步骤

	svc := service.NewDocService()
	content, err := svc.BuildDocument(sessionID)
	if err != nil {
		t.Fatalf("BuildDocument error: %v", err)
	}
	// 空步骤时，sections 存在但 steps 为空
	if len(content.BusinessView) == 0 {
		t.Fatal("expected at least 1 section even with 0 steps")
	}
	if len(content.BusinessView[0].Steps) != 0 {
		t.Errorf("expected 0 steps, got %d", len(content.BusinessView[0].Steps))
	}
}

func TestBuildDocument_SessionNotFound(t *testing.T) {
	setupDB(t)
	svc := service.NewDocService()
	_, err := svc.BuildDocument("nonexistent-id-12345")
	if err == nil {
		t.Error("expected error for nonexistent session, got nil")
	}
}

func TestBuildDocument_WithScreenshots(t *testing.T) {
	setupDB(t)
	_, sessionID := seedSessionWithSteps(t, 3)

	// 补充截图到步骤
	var steps []db.RecordingStep
	db.DB.Where("session_id = ?", sessionID).Find(&steps)
	for _, s := range steps {
		sc := db.Screenshot{
			SessionID:  sessionID,
			StepID:     s.ID,
			DataURL:    "data:image/jpeg;base64,MOCK_BASE64_DATA",
			CapturedAt: time.Now().UnixMilli(),
			Width:      1920,
			Height:     1080,
		}
		db.DB.Create(&sc)
		db.DB.Model(&s).Update("screenshot_id", sc.ID)
	}

	svc := service.NewDocService()
	content, err := svc.BuildDocument(sessionID)
	if err != nil {
		t.Fatalf("BuildDocument error: %v", err)
	}

	// 验证截图被加载
	for i, s := range content.BusinessView[0].Steps {
		if s.ScreenshotURL == "" {
			t.Errorf("step %d missing screenshot_url", i+1)
		}
		if s.ScreenshotID == "" {
			t.Errorf("step %d missing screenshot_id", i+1)
		}
	}
}

func TestSaveGeneratedDoc(t *testing.T) {
	setupDB(t)
	_, sessionID := seedSessionWithSteps(t, 3)

	svc := service.NewDocService()
	content, _ := svc.BuildDocument(sessionID)
	doc, err := svc.SaveGeneratedDoc(sessionID, content)
	if err != nil {
		t.Fatalf("SaveGeneratedDoc error: %v", err)
	}

	if doc.ID == "" {
		t.Error("doc.ID is empty")
	}
	if doc.SessionID != sessionID {
		t.Errorf("session_id mismatch: %v", doc.SessionID)
	}
	if doc.BusinessView == "" {
		t.Error("business_view JSON is empty")
	}
	if doc.TechnicalView == "" {
		t.Error("technical_view JSON is empty")
	}
	if doc.Status != "draft" {
		t.Errorf("expected status=draft, got %v", doc.Status)
	}

	// 验证 session.generated_doc_id 被更新
	var sess db.Session
	db.DB.First(&sess, "id = ?", sessionID)
	if sess.GeneratedDocID != doc.ID {
		t.Errorf("session.generated_doc_id not updated: got %v, want %v", sess.GeneratedDocID, doc.ID)
	}
	t.Logf("✅ Doc saved: %s", doc.ID)
}

func TestGenerateMarkdown_BusinessView(t *testing.T) {
	setupDB(t)
	_, sessionID := seedSessionWithSteps(t, 3)

	svc := service.NewDocService()
	content, _ := svc.BuildDocument(sessionID)
	md := svc.GenerateMarkdown(content, "business")

	if md == "" {
		t.Fatal("markdown is empty")
	}
	checks := []string{
		"# 测试录制会话",
		"测试项目",
		"操作说明文档",
		"### 第 1 步",
	}
	for _, check := range checks {
		if !strings.Contains(md, check) {
			t.Errorf("markdown missing: %q", check)
		}
	}
	t.Logf("✅ Markdown (business view):\n%s", md)
}

func TestGenerateMarkdown_TechnicalView(t *testing.T) {
	setupDB(t)
	_, sessionID := seedSessionWithSteps(t, 2)

	svc := service.NewDocService()
	content, _ := svc.BuildDocument(sessionID)
	md := svc.GenerateMarkdown(content, "technical")

	if !strings.Contains(md, "技术参考文档") {
		t.Error("technical view markdown missing header")
	}
	if !strings.Contains(md, "元素：") {
		t.Error("technical view markdown missing element info")
	}
}

// ─────────────────────────────────────
// effectiveCfg 测试（DB 配置覆盖环境变量）
// ─────────────────────────────────────

func TestEffectiveCfg_DBOverridesEnv(t *testing.T) {
	setupDB(t)

	// 写入 DB 配置
	db.DB.Create(&db.LLMProvider{
		Name:      "gemini",
		APIKey:    "DB_GEMINI_KEY_XYZ",
		BaseURL:   "https://generativelanguage.googleapis.com/v1beta",
		Model:     "gemini-2.5-flash",
		IsActive:  true,
		IsDefault: false,
	})

	// 创建不含 Key 的服务（模拟环境变量里没有 Key）
	mockCfg := service.MockConfigForTest()
	aiSvc := service.NewAIService(&mockCfg)

	statuses := aiSvc.GetProvidersStatus()
	var geminiStatus *service.ProviderStatus
	for i, s := range statuses {
		if s.ID == "gemini" {
			geminiStatus = &statuses[i]
		}
	}
	if geminiStatus == nil {
		t.Fatal("gemini not found in statuses")
	}
	if !geminiStatus.Available {
		t.Error("gemini should be available after DB upsert (DB should override empty env var)")
	}
	t.Logf("✅ DB config correctly overrides env var for gemini")
}
