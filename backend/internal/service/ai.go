package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gpilot/backend/internal/config"
	"github.com/gpilot/backend/internal/db"
)

// MockConfigForTest 返回空配置（用于测试：让 DB 配置覆盖空环境变量）
func MockConfigForTest() config.LLMConfig {
	return config.LLMConfig{
		GeminiBaseURL:     "https://generativelanguage.googleapis.com/v1beta",
		GeminiModel:       "gemini-2.0-flash",
		ZhipuBaseURL:      "https://open.bigmodel.cn/api/paas/v4",
		ZhipuModel:        "glm-4v-flash",
		OllamaBaseURL:     "http://localhost:11434",
		OllamaModel:       "qwen2.5-vl:7b",
		OpenRouterBaseURL: "https://openrouter.ai/api/v1",
		OpenAIBaseURL:     "https://api.openai.com/v1",
	}
}

// VLMRequest 统一的 VLM 请求
type VLMRequest struct {
	StepAction    string
	TargetElement string
	PageURL       string
	PageTitle     string
	MaskedText    string
	ScreenshotB64 string // base64 PNG，已脱敏
}

// VLMResponse 统一的 VLM 响应
type VLMResponse struct {
	Description string
	Provider    string
	UsedFree    bool
}

// AIService AI 调度服务（免费优先路由）
type AIService struct {
	cfg    *config.LLMConfig // 环境变量默认配置（就算 DB 没有记录也能工作）
	client *http.Client
}

func NewAIService(cfg *config.LLMConfig) *AIService {
	return &AIService{
		cfg:    cfg,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

// effectiveCfg 每次调用时从 DB 动态加载，当前 DB 配置优先于环境变量
func (s *AIService) effectiveCfg() *config.LLMConfig {
	// 拷贝环境变量默认配置
	cfg := *s.cfg

	// 从 DB 对应到配置字段的映射
	apply := func(name string, setFn func(p db.LLMProvider)) {
		var p db.LLMProvider
		if err := db.DB.Where("name = ? AND is_active = ?", name, true).First(&p).Error; err == nil {
			setFn(p)
		}
	}

	apply("gemini", func(p db.LLMProvider) {
		if p.APIKey != "" {
			cfg.GeminiAPIKey = p.APIKey
		}
		if p.BaseURL != "" {
			cfg.GeminiBaseURL = p.BaseURL
		}
		if p.Model != "" {
			cfg.GeminiModel = p.Model
		}
	})
	apply("zhipu", func(p db.LLMProvider) {
		if p.APIKey != "" {
			cfg.ZhipuAPIKey = p.APIKey
		}
		if p.BaseURL != "" {
			cfg.ZhipuBaseURL = p.BaseURL
		}
		if p.Model != "" {
			cfg.ZhipuModel = p.Model
		}
	})
	apply("ollama", func(p db.LLMProvider) {
		if p.BaseURL != "" {
			cfg.OllamaBaseURL = p.BaseURL
		}
		if p.Model != "" {
			cfg.OllamaModel = p.Model
		}
	})
	apply("openrouter", func(p db.LLMProvider) {
		if p.APIKey != "" {
			cfg.OpenRouterAPIKey = p.APIKey
		}
		if p.BaseURL != "" {
			cfg.OpenRouterBaseURL = p.BaseURL
		}
		if p.Model != "" {
			cfg.OpenRouterModel = p.Model
		}
	})
	apply("openai", func(p db.LLMProvider) {
		if p.APIKey != "" {
			cfg.OpenAIAPIKey = p.APIKey
		}
		if p.BaseURL != "" {
			cfg.OpenAIBaseURL = p.BaseURL
		}
		if p.Model != "" {
			cfg.OpenAIModel = p.Model
		}
	})

	return &cfg
}

// GenerateStepDescription 为操作步骤生成自然语言描述（免费优先）
func (s *AIService) GenerateStepDescription(req VLMRequest) (*VLMResponse, error) {
	// 每次调用时动态加载最新 DB 配置，实现“保存即生效”
	eff := s.effectiveCfg()

	// 免费优先路由链
	chain := []struct {
		name    string
		fn      func(VLMRequest, *config.LLMConfig) (string, error)
		isFree  bool
		enabled bool
	}{
		{"ollama", s.callOllama, true, s.isOllamaAvailableWithCfg(eff)},
		{"zhipu", s.callZhipu, true, eff.ZhipuAPIKey != ""},
		{"gemini", s.callGemini, true, eff.GeminiAPIKey != ""},
		{"openrouter", s.callOpenRouter, true, eff.OpenRouterAPIKey != ""},
		{"openai", s.callOpenAI, false, eff.OpenAIAPIKey != ""},
	}

	for _, provider := range chain {
		if !provider.enabled {
			continue
		}
		desc, err := provider.fn(req, eff)
		if err != nil {
			// 降级到下一个
			continue
		}
		return &VLMResponse{
			Description: desc,
			Provider:    provider.name,
			UsedFree:    provider.isFree,
		}, nil
	}

	// 所有 VLM 失败时，使用规则生成纯文本描述
	return &VLMResponse{
		Description: s.ruleBasedDescription(req),
		Provider:    "rule-based",
		UsedFree:    true,
	}, nil
}

// ─────────────────────────────────────────────────────────────
// Prompt 构建（仅含脱敏后的影子数据）
// ─────────────────────────────────────────────────────────────
func (s *AIService) buildPrompt(req VLMRequest) string {
	return fmt.Sprintf(`你是政务软件操作手册编写助手。根据以下截图和操作信息，用一句简洁的中文描述当前步骤。
格式：第N步：[动作] [目标]，[预期效果]（不要重复格式字样本身）

操作信息：
- 操作类型：%s
- 目标元素：%s
- 页面标题：%s
- 相关文本：%s

请直接输出描述内容，不要解释，不要重复格式说明。`, req.StepAction, req.TargetElement, req.PageTitle, req.MaskedText)
}

// ─────────────────────────────────────────────────────────────
// Gemini 2.0 Flash 适配器（免费层）
// ─────────────────────────────────────────────────────────────
func (s *AIService) callGemini(req VLMRequest, cfg *config.LLMConfig) (string, error) {
	type InlineData struct {
		MimeType string `json:"mime_type"`
		Data     string `json:"data"`
	}
	type Part struct {
		Text       string      `json:"text,omitempty"`
		InlineData *InlineData `json:"inline_data,omitempty"`
	}
	type Content struct {
		Parts []Part `json:"parts"`
	}
	type GenConfig struct {
		MaxOutputTokens int     `json:"maxOutputTokens"`
		Temperature     float64 `json:"temperature"`
	}
	type GeminiReq struct {
		Contents         []Content `json:"contents"`
		GenerationConfig GenConfig `json:"generationConfig"`
	}

	parts := []Part{{Text: s.buildPrompt(req)}}
	if req.ScreenshotB64 != "" {
		imgData := req.ScreenshotB64
		if idx := strings.Index(imgData, ","); idx != -1 {
			imgData = imgData[idx+1:]
		}
		parts = append(parts, Part{InlineData: &InlineData{MimeType: "image/jpeg", Data: imgData}})
	}

	body := GeminiReq{
		Contents:         []Content{{Parts: parts}},
		GenerationConfig: GenConfig{MaxOutputTokens: 256, Temperature: 0.2},
	}

	url := fmt.Sprintf("%s/models/%s:generateContent?key=%s",
		cfg.GeminiBaseURL, cfg.GeminiModel, cfg.GeminiAPIKey)

	return s.doGeminiRequest(url, body)
}

func (s *AIService) doGeminiRequest(url string, body interface{}) (string, error) {
	data, _ := json.Marshal(body)
	resp, err := s.client.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("gemini status %d", resp.StatusCode)
	}

	var result struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Candidates) == 0 || len(result.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("empty gemini response")
	}
	return strings.TrimSpace(result.Candidates[0].Content.Parts[0].Text), nil
}

// ─────────────────────────────────────────────────────────────
// 智谱 GLM-4V-Flash 适配器（兼容 OpenAI 接口，免费）
// ─────────────────────────────────────────────────────────────
func (s *AIService) callZhipu(req VLMRequest, cfg *config.LLMConfig) (string, error) {
	return s.callOpenAICompatible(
		cfg.ZhipuBaseURL+"/chat/completions",
		cfg.ZhipuModel,
		cfg.ZhipuAPIKey,
		req,
	)
}

// ─────────────────────────────────────────────────────────────
// OpenRouter + Qwen2.5-VL（免费配额）
// ─────────────────────────────────────────────────────────────
func (s *AIService) callOpenRouter(req VLMRequest, cfg *config.LLMConfig) (string, error) {
	return s.callOpenAICompatible(
		cfg.OpenRouterBaseURL+"/chat/completions",
		cfg.OpenRouterModel,
		cfg.OpenRouterAPIKey,
		req,
	)
}

// ─────────────────────────────────────────────────────────────
// OpenAI（付费，最低优先级）
// ─────────────────────────────────────────────────────────────
func (s *AIService) callOpenAI(req VLMRequest, cfg *config.LLMConfig) (string, error) {
	return s.callOpenAICompatible(
		cfg.OpenAIBaseURL+"/chat/completions",
		cfg.OpenAIModel,
		cfg.OpenAIAPIKey,
		req,
	)
}

// callOpenAICompatible 通用 OpenAI-compatible 接口调用
func (s *AIService) callOpenAICompatible(url, model, apiKey string, req VLMRequest) (string, error) {
	type ImageURL struct {
		URL    string `json:"url"`
		Detail string `json:"detail,omitempty"`
	}
	type ContentPart struct {
		Type     string    `json:"type"`
		Text     string    `json:"text,omitempty"`
		ImageURL *ImageURL `json:"image_url,omitempty"`
	}
	type Message struct {
		Role    string        `json:"role"`
		Content []ContentPart `json:"content"`
	}
	type OpenAIReq struct {
		Model     string    `json:"model"`
		Messages  []Message `json:"messages"`
		MaxTokens int       `json:"max_tokens"`
	}

	userParts := []ContentPart{{Type: "text", Text: s.buildPrompt(req)}}
	if req.ScreenshotB64 != "" {
		userParts = append(userParts, ContentPart{
			Type:     "image_url",
			ImageURL: &ImageURL{URL: req.ScreenshotB64, Detail: "high"},
		})
	}

	body := OpenAIReq{
		Model: model,
		Messages: []Message{
			{
				Role:    "user",
				Content: userParts,
			},
		},
		MaxTokens: 256,
	}

	data, _ := json.Marshal(body)
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := s.client.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("api status %d: %s", resp.StatusCode, string(b))
	}

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if len(result.Choices) == 0 {
		return "", fmt.Errorf("empty response")
	}
	return strings.TrimSpace(result.Choices[0].Message.Content), nil
}

// ─────────────────────────────────────────────────────────────
// Ollama 本地适配器（完全免费）
// ─────────────────────────────────────────────────────────────
func (s *AIService) callOllama(req VLMRequest, cfg *config.LLMConfig) (string, error) {
	type OllamaReq struct {
		Model  string   `json:"model"`
		Prompt string   `json:"prompt"`
		Images []string `json:"images,omitempty"`
		Stream bool     `json:"stream"`
	}

	body := OllamaReq{
		Model:  cfg.OllamaModel,
		Prompt: s.buildPrompt(req),
		Stream: false,
	}

	if req.ScreenshotB64 != "" {
		imgData := req.ScreenshotB64
		if idx := strings.Index(imgData, ","); idx != -1 {
			imgData = imgData[idx+1:]
		}
		if _, err := base64.StdEncoding.DecodeString(imgData[:min(len(imgData), 100)]); err == nil {
			body.Images = []string{imgData}
		}
	}

	data, _ := json.Marshal(body)
	resp, err := s.client.Post(cfg.OllamaBaseURL+"/api/generate", "application/json", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("ollama status %d", resp.StatusCode)
	}

	var result struct {
		Response string `json:"response"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Response), nil
}

func (s *AIService) isOllamaAvailableWithCfg(cfg *config.LLMConfig) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(cfg.OllamaBaseURL + "/api/tags")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// ruleBasedDescription 纯规则生成（兜底，无需 AI）
func (s *AIService) ruleBasedDescription(req VLMRequest) string {
	actionMap := map[string]string{
		"click":      "点击",
		"input":      "输入",
		"select":     "选择",
		"drag":       "拖拽",
		"navigation": "导航至",
		"scroll":     "滚动",
		"hover":      "悬停在",
	}
	action := actionMap[req.StepAction]
	if action == "" {
		action = req.StepAction
	}
	if req.MaskedText != "" {
		return fmt.Sprintf("在[%s]页面，%s[%s]", req.PageTitle, action, req.MaskedText)
	}
	return fmt.Sprintf("在[%s]页面，%s %s", req.PageTitle, action, req.TargetElement)
}

// ─────────────────────────────────────────────────────────────
// VLM 提供商状态查询
// ─────────────────────────────────────────────────────────────
type ProviderStatus struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
	IsFree    bool   `json:"is_free"`
	Reason    string `json:"reason,omitempty"`
}

func (s *AIService) GetProvidersStatus() []ProviderStatus {
	eff := s.effectiveCfg()
	return []ProviderStatus{
		{
			ID:        "ollama",
			Name:      "Ollama 本地 (完全免费)",
			Available: s.isOllamaAvailableWithCfg(eff),
			IsFree:    true,
			Reason:    "需要本地安装 Ollama 并运行 " + eff.OllamaModel,
		},
		{
			ID:        "zhipu",
			Name:      "智谰 GLM-4V-Flash (免费)",
			Available: eff.ZhipuAPIKey != "",
			IsFree:    true,
			Reason:    "需要配置 ZHIPU_API_KEY",
		},
		{
			ID:        "gemini",
			Name:      "Google Gemini 2.0 Flash (免费层)",
			Available: eff.GeminiAPIKey != "",
			IsFree:    true,
			Reason:    "需要配置 GEMINI_API_KEY（https://aistudio.google.com）",
		},
		{
			ID:        "openrouter",
			Name:      "OpenRouter Qwen2.5-VL (免费配额)",
			Available: eff.OpenRouterAPIKey != "",
			IsFree:    true,
			Reason:    "需要配置 OPENROUTER_API_KEY",
		},
		{
			ID:        "openai",
			Name:      "OpenAI GPT-4o-mini (付费)",
			Available: eff.OpenAIAPIKey != "",
			IsFree:    false,
			Reason:    "付费服务，需配置 OPENAI_API_KEY",
		},
	}
}

// ─────────────────────────────────────────────────────────────
// GenerateDocument 批量为 session 所有 steps 生成描述
// ─────────────────────────────────────────────────────────────
type DocGenerateProgress struct {
	Current int
	Total   int
	StepID  string
	Done    bool
	Error   string
}

func (s *AIService) GenerateDocForSession(sessionID string, progressCh chan<- DocGenerateProgress) error {
	var steps []db.RecordingStep
	if err := db.DB.Where("session_id = ?", sessionID).Order("step_index").Find(&steps).Error; err != nil {
		return err
	}

	total := len(steps)
	for i, step := range steps {
		// 加载截图
		var screenshot db.Screenshot
		var screenshotB64 string
		if step.ScreenshotID != "" {
			db.DB.Where("id = ?", step.ScreenshotID).First(&screenshot)
			screenshotB64 = screenshot.DataURL
		}

		req := VLMRequest{
			StepAction:    step.Action,
			TargetElement: step.TargetElement,
			PageURL:       step.PageURL,
			PageTitle:     step.PageTitle,
			MaskedText:    step.MaskedText,
			ScreenshotB64: screenshotB64,
		}

		resp, err := s.GenerateStepDescription(req)
		if err != nil {
			progressCh <- DocGenerateProgress{Current: i + 1, Total: total, StepID: step.ID, Error: err.Error()}
			continue
		}

		// 更新步骤描述
		db.DB.Model(&step).Update("ai_description", resp.Description)

		progressCh <- DocGenerateProgress{Current: i + 1, Total: total, StepID: step.ID}
	}

	progressCh <- DocGenerateProgress{Done: true, Total: total}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
