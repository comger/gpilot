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
	cfg    *config.LLMConfig
	client *http.Client
}

func NewAIService(cfg *config.LLMConfig) *AIService {
	return &AIService{
		cfg:    cfg,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

// GenerateStepDescription 为操作步骤生成自然语言描述（免费优先）
func (s *AIService) GenerateStepDescription(req VLMRequest) (*VLMResponse, error) {
	// 免费优先路由链
	chain := []struct {
		name    string
		fn      func(VLMRequest) (string, error)
		isFree  bool
		enabled bool
	}{
		{"ollama", s.callOllama, true, s.isOllamaAvailable()},
		{"zhipu", s.callZhipu, true, s.cfg.ZhipuAPIKey != ""},
		{"gemini", s.callGemini, true, s.cfg.GeminiAPIKey != ""},
		{"openrouter", s.callOpenRouter, true, s.cfg.OpenRouterAPIKey != ""},
		{"openai", s.callOpenAI, false, s.cfg.OpenAIAPIKey != ""},
	}

	for _, provider := range chain {
		if !provider.enabled {
			continue
		}
		desc, err := provider.fn(req)
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
func (s *AIService) callGemini(req VLMRequest) (string, error) {
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
		// 去掉 data:image/png;base64, 前缀
		imgData := req.ScreenshotB64
		if idx := strings.Index(imgData, ","); idx != -1 {
			imgData = imgData[idx+1:]
		}
		parts = append(parts, Part{InlineData: &InlineData{MimeType: "image/png", Data: imgData}})
	}

	body := GeminiReq{
		Contents:         []Content{{Parts: parts}},
		GenerationConfig: GenConfig{MaxOutputTokens: 256, Temperature: 0.2},
	}

	url := fmt.Sprintf("%s/models/%s:generateContent?key=%s",
		s.cfg.GeminiBaseURL, s.cfg.GeminiModel, s.cfg.GeminiAPIKey)

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
func (s *AIService) callZhipu(req VLMRequest) (string, error) {
	return s.callOpenAICompatible(
		s.cfg.ZhipuBaseURL+"/chat/completions",
		s.cfg.ZhipuModel,
		s.cfg.ZhipuAPIKey,
		req,
	)
}

// ─────────────────────────────────────────────────────────────
// OpenRouter + Qwen2.5-VL（免费配额）
// ─────────────────────────────────────────────────────────────
func (s *AIService) callOpenRouter(req VLMRequest) (string, error) {
	return s.callOpenAICompatible(
		s.cfg.OpenRouterBaseURL+"/chat/completions",
		s.cfg.OpenRouterModel,
		s.cfg.OpenRouterAPIKey,
		req,
	)
}

// ─────────────────────────────────────────────────────────────
// OpenAI（付费，最低优先级）
// ─────────────────────────────────────────────────────────────
func (s *AIService) callOpenAI(req VLMRequest) (string, error) {
	return s.callOpenAICompatible(
		s.cfg.OpenAIBaseURL+"/chat/completions",
		s.cfg.OpenAIModel,
		s.cfg.OpenAIAPIKey,
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
func (s *AIService) callOllama(req VLMRequest) (string, error) {
	type OllamaReq struct {
		Model  string   `json:"model"`
		Prompt string   `json:"prompt"`
		Images []string `json:"images,omitempty"`
		Stream bool     `json:"stream"`
	}

	body := OllamaReq{
		Model:  s.cfg.OllamaModel,
		Prompt: s.buildPrompt(req),
		Stream: false,
	}

	if req.ScreenshotB64 != "" {
		imgData := req.ScreenshotB64
		if idx := strings.Index(imgData, ","); idx != -1 {
			imgData = imgData[idx+1:]
		}
		// 验证是有效的 base64
		if _, err := base64.StdEncoding.DecodeString(imgData[:min(len(imgData), 100)]); err == nil {
			body.Images = []string{imgData}
		}
	}

	data, _ := json.Marshal(body)
	resp, err := s.client.Post(s.cfg.OllamaBaseURL+"/api/generate", "application/json", bytes.NewReader(data))
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

func (s *AIService) isOllamaAvailable() bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(s.cfg.OllamaBaseURL + "/api/tags")
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
	return []ProviderStatus{
		{
			ID:        "ollama",
			Name:      "Ollama 本地 (完全免费)",
			Available: s.isOllamaAvailable(),
			IsFree:    true,
			Reason:    "需要本地安装 Ollama 并运行 " + s.cfg.OllamaModel,
		},
		{
			ID:        "zhipu",
			Name:      "智谱 GLM-4V-Flash (免费)",
			Available: s.cfg.ZhipuAPIKey != "",
			IsFree:    true,
			Reason:    "需要配置 ZHIPU_API_KEY",
		},
		{
			ID:        "gemini",
			Name:      "Google Gemini 2.0 Flash (免费层)",
			Available: s.cfg.GeminiAPIKey != "",
			IsFree:    true,
			Reason:    "需要配置 GEMINI_API_KEY（https://aistudio.google.com）",
		},
		{
			ID:        "openrouter",
			Name:      "OpenRouter Qwen2.5-VL (免费配额)",
			Available: s.cfg.OpenRouterAPIKey != "",
			IsFree:    true,
			Reason:    "需要配置 OPENROUTER_API_KEY",
		},
		{
			ID:        "openai",
			Name:      "OpenAI GPT-4o-mini (付费)",
			Available: s.cfg.OpenAIAPIKey != "",
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
