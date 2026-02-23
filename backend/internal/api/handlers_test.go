package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gpilot/backend/internal/api"
	"github.com/gpilot/backend/internal/config"
	"github.com/gpilot/backend/internal/db"
	"github.com/gpilot/backend/internal/service"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// ─────────────────────────────────────
// 测试辅助工具
// ─────────────────────────────────────

var testRouter *gin.Engine

func setupTestDB(t *testing.T) {
	t.Helper()
	var err error
	db.DB, err = gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("failed to open test DB: %v", err)
	}
	if err := db.DB.AutoMigrate(
		&db.Project{},
		&db.Session{},
		&db.RecordingStep{},
		&db.Screenshot{},
		&db.MaskingProfile{},
		&db.MaskingRule{},
		&db.GeneratedDocument{},
		&db.LLMProvider{},
	); err != nil {
		t.Fatalf("failed to migrate test DB: %v", err)
	}
}

func setupTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	setupTestDB(t)
	gin.SetMode(gin.TestMode)

	cfg := &config.LLMConfig{
		DefaultProvider: "rule-based",
		GeminiBaseURL:   "https://generativelanguage.googleapis.com/v1beta",
		GeminiModel:     "gemini-2.0-flash",
		ZhipuBaseURL:    "https://open.bigmodel.cn/api/paas/v4",
		ZhipuModel:      "glm-4v-flash",
		OllamaBaseURL:   "http://localhost:11434",
		OllamaModel:     "qwen2.5-vl:7b",
	}
	aiSvc := service.NewAIService(cfg)
	docSvc := service.NewDocService()
	api.SetServices(aiSvc, docSvc)

	return api.SetupRouter()
}

func doRequest(router *gin.Engine, method, path string, body interface{}) *httptest.ResponseRecorder {
	var reqBody *bytes.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		reqBody = bytes.NewReader(data)
	} else {
		reqBody = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, path, reqBody)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func parseBody(t *testing.T, w *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var result map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to parse response body: %v\nbody: %s", err, w.Body.String())
	}
	return result
}

func mustString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

// ─────────────────────────────────────
// 1. 健康检查测试
// ─────────────────────────────────────

func TestHealth(t *testing.T) {
	r := setupTestRouter(t)
	w := doRequest(r, "GET", "/health", nil)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	body := parseBody(t, w)
	if body["status"] != "ok" {
		t.Errorf("expected status=ok, got %v", body["status"])
	}
}

// ─────────────────────────────────────
// 2. 项目 CRUD 测试
// ─────────────────────────────────────

func TestProjectCRUD(t *testing.T) {
	r := setupTestRouter(t)

	// 创建项目
	t.Run("CreateProject_OK", func(t *testing.T) {
		w := doRequest(r, "POST", "/api/v1/projects", map[string]string{
			"name":        "政务大厅系统",
			"description": "市民服务中心操作流程",
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		body := parseBody(t, w)
		data := body["data"].(map[string]interface{})
		if data["name"] != "政务大厅系统" {
			t.Errorf("name mismatch: %v", data["name"])
		}
		if data["id"] == "" || data["id"] == nil {
			t.Error("expected non-empty id")
		}
		if data["template_type"] != "both" {
			t.Errorf("expected template_type=both, got %v", data["template_type"])
		}
	})

	// 缺少必填字段
	t.Run("CreateProject_MissingName", func(t *testing.T) {
		w := doRequest(r, "POST", "/api/v1/projects", map[string]string{
			"description": "没有名称",
		})
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})

	// 获取列表
	t.Run("GetProjects_ReturnsList", func(t *testing.T) {
		w := doRequest(r, "GET", "/api/v1/projects", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		body := parseBody(t, w)
		projects := body["data"].([]interface{})
		if len(projects) == 0 {
			t.Error("expected at least 1 project")
		}
		p := projects[0].(map[string]interface{})
		if _, ok := p["name"]; !ok {
			t.Error("project missing 'name' field (json tag issue?)")
		}
		if _, ok := p["description"]; !ok {
			t.Error("project missing 'description' field")
		}
	})

	// 获取单个项目
	t.Run("GetProject_ByID", func(t *testing.T) {
		// 先创建
		w1 := doRequest(r, "POST", "/api/v1/projects", map[string]string{
			"name": "Test Project ID",
		})
		d := parseBody(t, w1)["data"].(map[string]interface{})
		id := mustString(d["id"])

		w2 := doRequest(r, "GET", "/api/v1/projects/"+id, nil)
		if w2.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w2.Code)
		}
	})

	// 404
	t.Run("GetProject_NotFound", func(t *testing.T) {
		w := doRequest(r, "GET", "/api/v1/projects/nonexistent-id", nil)
		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", w.Code)
		}
	})
}

// ─────────────────────────────────────
// 3. Session 测试
// ─────────────────────────────────────

func TestSessionCRUD(t *testing.T) {
	r := setupTestRouter(t)

	// 先建项目
	w0 := doRequest(r, "POST", "/api/v1/projects", map[string]string{"name": "Session Test Project"})
	projectID := mustString(parseBody(t, w0)["data"].(map[string]interface{})["id"])

	var sessionID string

	t.Run("CreateSession_OK", func(t *testing.T) {
		w := doRequest(r, "POST", "/api/v1/sessions", map[string]string{
			"project_id": projectID,
			"title":      "用户登录流程",
			"target_url": "http://gov.example.com/login",
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		body := parseBody(t, w)
		data := body["data"].(map[string]interface{})
		sessionID = mustString(data["id"])
		if data["status"] != "recording" {
			t.Errorf("expected status=recording, got %v", data["status"])
		}
		if data["project_id"] != projectID {
			t.Errorf("project_id mismatch")
		}
	})

	t.Run("UpdateSessionStatus_Completed", func(t *testing.T) {
		w := doRequest(r, "PATCH", "/api/v1/sessions/"+sessionID+"/status", map[string]string{
			"status": "completed",
		})
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("GetSessions_ByProject", func(t *testing.T) {
		w := doRequest(r, "GET", "/api/v1/sessions?project_id="+projectID, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		data := parseBody(t, w)["data"].([]interface{})
		if len(data) == 0 {
			t.Error("expected at least 1 session")
		}
	})
}

// ─────────────────────────────────────
// 4. Step（步骤）测试
// ─────────────────────────────────────

func TestStepCRUD(t *testing.T) {
	r := setupTestRouter(t)

	// 建项目 + session
	w0 := doRequest(r, "POST", "/api/v1/projects", map[string]string{"name": "Step Test Project"})
	projectID := mustString(parseBody(t, w0)["data"].(map[string]interface{})["id"])

	w1 := doRequest(r, "POST", "/api/v1/sessions", map[string]string{
		"project_id": projectID,
		"title":      "采购申请",
	})
	sessionID := mustString(parseBody(t, w1)["data"].(map[string]interface{})["id"])

	t.Run("CreateStep_OK", func(t *testing.T) {
		w := doRequest(r, "POST", "/api/v1/sessions/"+sessionID+"/steps", map[string]interface{}{
			"action":          "click",
			"target_selector": "#submit-btn",
			"target_element":  "提交申请 (button#submit-btn)",
			"page_url":        "http://gov.example.com/apply",
			"page_title":      "采购申请页面",
			"masked_text":     "提交申请",
			"timestamp":       time.Now().UnixMilli(),
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		body := parseBody(t, w)
		data := body["data"].(map[string]interface{})
		if data["action"] != "click" {
			t.Errorf("action mismatch: %v", data["action"])
		}
		if data["step_index"] == nil || data["step_index"].(float64) < 1 {
			t.Errorf("step_index should be >=1, got %v", data["step_index"])
		}
	})

	t.Run("CreateStep_WithScreenshot", func(t *testing.T) {
		w := doRequest(r, "POST", "/api/v1/sessions/"+sessionID+"/steps", map[string]interface{}{
			"action":              "input",
			"target_element":      "申请单号输入框 (input#order-no)",
			"page_title":          "申请表单",
			"masked_text":         "【采购单号】",
			"is_masked":           true,
			"screenshot_data_url": "data:image/jpeg;base64,/9j/4AAQ",
			"screenshot_width":    1920,
			"screenshot_height":   1080,
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d", w.Code)
		}
		data := parseBody(t, w)["data"].(map[string]interface{})
		if data["is_masked"] != true {
			t.Error("expected is_masked=true")
		}
	})

	t.Run("GetSteps_ReturnsList", func(t *testing.T) {
		w := doRequest(r, "GET", "/api/v1/sessions/"+sessionID+"/steps", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		data := parseBody(t, w)["data"].([]interface{})
		if len(data) < 2 {
			t.Errorf("expected >=2 steps, got %d", len(data))
		}
		// 验证排序
		first := data[0].(map[string]interface{})
		if first["step_index"].(float64) != 1 {
			t.Errorf("expected first step_index=1, got %v", first["step_index"])
		}
	})
}

// ─────────────────────────────────────
// 5. VLM 提供商配置测试
// ─────────────────────────────────────

func TestLLMProviders(t *testing.T) {
	r := setupTestRouter(t)

	t.Run("GetProviderStatus_ReturnsAll", func(t *testing.T) {
		w := doRequest(r, "GET", "/api/v1/ai/providers/status", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		data := parseBody(t, w)["data"].([]interface{})
		if len(data) != 5 {
			t.Errorf("expected 5 providers, got %d", len(data))
		}
		// 验证字段
		first := data[0].(map[string]interface{})
		if _, ok := first["id"]; !ok {
			t.Error("provider missing 'id'")
		}
		if _, ok := first["available"]; !ok {
			t.Error("provider missing 'available'")
		}
	})

	t.Run("UpsertLLMProvider_CreateNew", func(t *testing.T) {
		w := doRequest(r, "PUT", "/api/v1/llm/providers", map[string]interface{}{
			"name":       "gemini",
			"api_key":    "AIza_test_key",
			"model":      "gemini-2.0-flash",
			"base_url":   "https://generativelanguage.googleapis.com/v1beta",
			"is_default": true,
		})
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		body := parseBody(t, w)
		if body["message"] != "saved" {
			t.Errorf("expected message=saved, got %v", body["message"])
		}
	})

	t.Run("UpsertLLMProvider_UpdateExisting", func(t *testing.T) {
		// 更新同一个 provider
		w := doRequest(r, "PUT", "/api/v1/llm/providers", map[string]interface{}{
			"name":    "gemini",
			"api_key": "AIza_new_key_updated",
			"model":   "gemini-2.5-flash",
		})
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		// 验证 provider status 已更新（gemini 应为 available=true）
		w2 := doRequest(r, "GET", "/api/v1/ai/providers/status", nil)
		statuses := parseBody(t, w2)["data"].([]interface{})
		for _, s := range statuses {
			st := s.(map[string]interface{})
			if st["id"] == "gemini" {
				if st["available"] != true {
					t.Error("gemini should be available after setting api_key")
				}
			}
		}
	})

	t.Run("UpsertLLMProvider_MissingName", func(t *testing.T) {
		w := doRequest(r, "PUT", "/api/v1/llm/providers", map[string]interface{}{
			"api_key": "some_key",
		})
		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", w.Code)
		}
	})
}

// ─────────────────────────────────────
// 6. 文档生成业务闭环测试
// ─────────────────────────────────────

func TestDocGenerationFlow(t *testing.T) {
	r := setupTestRouter(t)

	// Step 1: 创建项目
	w0 := doRequest(r, "POST", "/api/v1/projects", map[string]string{
		"name":        "政务大厅综合窗口",
		"description": "市民办理业务完整流程",
	})
	projectID := mustString(parseBody(t, w0)["data"].(map[string]interface{})["id"])
	t.Logf("✅ Created project: %s", projectID)

	// Step 2: 创建 Session
	w1 := doRequest(r, "POST", "/api/v1/sessions", map[string]string{
		"project_id": projectID,
		"title":      "市民营业执照申请流程",
		"target_url": "http://gov.example.com/bizlicense",
	})
	sessionID := mustString(parseBody(t, w1)["data"].(map[string]interface{})["id"])
	t.Logf("✅ Created session: %s", sessionID)

	// Step 3: 插入 5 个模拟操作步骤（含预置 AI 描述）
	mockSteps := []map[string]interface{}{
		{
			"action":         "navigation",
			"target_element": "浏览器地址栏",
			"page_title":     "政务大厅首页",
			"page_url":       "http://gov.example.com/",
			"masked_text":    "导航至政务大厅",
			"ai_description": "第1步：打开政务大厅首页，进入市民服务中心",
		},
		{
			"action":          "click",
			"target_selector": "#menu-bizlicense",
			"target_element":  "营业执照申请 (a#menu-bizlicense)",
			"page_title":      "政务大厅首页",
			"page_url":        "http://gov.example.com/",
			"masked_text":     "营业执照申请",
			"ai_description":  "第2步：点击导航菜单中的「营业执照申请」，进入申请入口",
		},
		{
			"action":          "input",
			"target_selector": "input#applicant-name",
			"target_element":  "申请人姓名 (input#applicant-name)",
			"page_title":      "营业执照申请表",
			"page_url":        "http://gov.example.com/bizlicense/apply",
			"masked_text":     "【申请人姓名】",
			"is_masked":       true,
			"ai_description":  "第3步：在「申请人姓名」字段填写申请人信息（已脱敏处理）",
		},
		{
			"action":          "click",
			"target_selector": "button#upload-license",
			"target_element":  "上传营业执照 (button#upload-license)",
			"page_title":      "营业执照申请表",
			"page_url":        "http://gov.example.com/bizlicense/apply",
			"masked_text":     "上传营业执照",
			"ai_description":  "第4步：点击「上传营业执照」按钮，选择本地证照文件",
		},
		{
			"action":          "click",
			"target_selector": "button#submit-apply",
			"target_element":  "提交申请 (button#submit-apply)",
			"page_title":      "营业执照申请表",
			"page_url":        "http://gov.example.com/bizlicense/apply",
			"masked_text":     "提交申请",
			"ai_description":  "第5步：确认填写无误后，点击「提交申请」完成营业执照申请提交",
		},
	}

	stepIDs := make([]string, 0, len(mockSteps))
	for i, stepData := range mockSteps {
		stepData["timestamp"] = time.Now().Add(time.Duration(i) * time.Second).UnixMilli()
		w := doRequest(r, "POST", "/api/v1/sessions/"+sessionID+"/steps", stepData)
		if w.Code != http.StatusCreated {
			t.Fatalf("failed to create step %d: %d %s", i+1, w.Code, w.Body.String())
		}
		sid := mustString(parseBody(t, w)["data"].(map[string]interface{})["id"])
		stepIDs = append(stepIDs, sid)

		// 如果有预置 ai_description，直接更新到 step（模拟 AI 已生成）
		if aiDesc, ok := stepData["ai_description"].(string); ok && aiDesc != "" {
			doRequest(r, "PATCH", "/api/v1/sessions/"+sessionID+"/steps/"+sid, map[string]interface{}{
				"ai_description": aiDesc,
			})
		}
	}
	t.Logf("✅ Created %d mock steps", len(stepIDs))

	// Step 4: 完成录制
	w3 := doRequest(r, "PATCH", "/api/v1/sessions/"+sessionID+"/status", map[string]string{
		"status": "completed",
	})
	if w3.Code != http.StatusOK {
		t.Fatalf("failed to mark session completed: %d", w3.Code)
	}

	// Step 5: 调用 DocService 直接生成文档（绕过 SSE，验证核心逻辑）
	docSvc := service.NewDocService()
	content, err := docSvc.BuildDocument(sessionID)
	if err != nil {
		t.Fatalf("BuildDocument failed: %v", err)
	}

	// 验证文档内容
	if content.SessionTitle != "市民营业执照申请流程" {
		t.Errorf("session title mismatch: %v", content.SessionTitle)
	}
	if content.ProjectName != "政务大厅综合窗口" {
		t.Errorf("project name mismatch: %v", content.ProjectName)
	}
	if len(content.BusinessView) == 0 {
		t.Fatal("business_view is empty!")
	}
	bizSteps := content.BusinessView[0].Steps
	if len(bizSteps) != 5 {
		t.Errorf("expected 5 steps in business_view, got %d", len(bizSteps))
	}
	// 验证 AI 描述已保存
	for i, s := range bizSteps {
		if s.Description == "" {
			t.Errorf("step %d has empty description", i+1)
		}
		if strings.Contains(s.Description, "第") {
			t.Logf("✅ Step %d: %s", i+1, s.Description[:min(len(s.Description), 50)])
		}
	}

	// Step 6: 保存文档到 DB
	doc, err := docSvc.SaveGeneratedDoc(sessionID, content)
	if err != nil {
		t.Fatalf("SaveGeneratedDoc failed: %v", err)
	}
	if doc.ID == "" {
		t.Error("saved doc has empty ID")
	}
	t.Logf("✅ Document saved, ID: %s", doc.ID)

	// Step 7: 生成 Markdown
	md := docSvc.GenerateMarkdown(content, "business")
	if md == "" {
		t.Fatal("GenerateMarkdown returned empty string")
	}
	if !strings.Contains(md, "市民营业执照申请流程") {
		t.Error("markdown missing session title")
	}
	if !strings.Contains(md, "### 第 1 步") || !strings.Contains(md, "### 第 5 步") {
		t.Errorf("markdown missing step headers\nMarkdown:\n%s", md[:min(len(md), 500)])
	}
	t.Logf("✅ Markdown generated (%d chars):\n%s", len(md), md[:min(len(md), 300)])

	// Step 8: 通过 API 获取文档
	w5 := doRequest(r, "GET", "/api/v1/documents/"+doc.ID, nil)
	if w5.Code != http.StatusOK {
		t.Fatalf("GetDocument failed: %d %s", w5.Code, w5.Body.String())
	}
	docData := parseBody(t, w5)["data"].(map[string]interface{})
	if docData["id"] != doc.ID {
		t.Errorf("doc id mismatch: %v", docData["id"])
	}
	t.Logf("✅ Document retrieved via API")
}

// ─────────────────────────────────────
// 7. 脱敏规则测试
// ─────────────────────────────────────

func TestMaskingRules(t *testing.T) {
	r := setupTestRouter(t)

	t.Run("GetDefaultRules", func(t *testing.T) {
		w := doRequest(r, "GET", "/api/v1/masking/defaults", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		data := parseBody(t, w)["data"].([]interface{})
		if len(data) < 3 {
			t.Errorf("expected >=3 default rules, got %d", len(data))
		}
	})

	t.Run("CreateMaskingProfile", func(t *testing.T) {
		w := doRequest(r, "POST", "/api/v1/masking/profiles", map[string]interface{}{
			"name": "政务标准脱敏规则集",
			"rules": []map[string]string{
				{"rule_type": "regex", "pattern": `1[3-9]\d{9}`, "alias": "【手机号】", "scope": "global"},
				{"rule_type": "regex", "pattern": `\d{17}[\dX]`, "alias": "【身份证】", "scope": "global"},
			},
		})
		if w.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
		}
		data := parseBody(t, w)["data"].(map[string]interface{})
		if data["name"] != "政务标准脱敏规则集" {
			t.Errorf("name mismatch: %v", data["name"])
		}
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
