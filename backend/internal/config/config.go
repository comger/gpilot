package config

import (
	"os"
)

// Config 全局配置
type Config struct {
	Server  ServerConfig
	DB      DBConfig
	LLM     LLMConfig
}

type ServerConfig struct {
	Port string
	Mode string // "debug" | "release"
}

type DBConfig struct {
	Path string
}

// LLMConfig 免费优先的多模态 API 配置
type LLMConfig struct {
	// 首选免费 Provider（按优先级）
	DefaultProvider string // "gemini" | "zhipu" | "ollama" | "openrouter" | "openai"

	// Google Gemini 2.0 Flash (免费层: 1500 RPD, 15 RPM)
	GeminiAPIKey string
	GeminiModel  string
	GeminiBaseURL string

	// 智谱 GLM-4V-Flash (免费: 100万 Token/天)
	ZhipuAPIKey  string
	ZhipuModel   string
	ZhipuBaseURL string

	// Ollama 本地 (完全免费)
	OllamaBaseURL string
	OllamaModel   string

	// OpenRouter (Qwen2.5-VL 免费配额)
	OpenRouterAPIKey string
	OpenRouterModel  string
	OpenRouterBaseURL string

	// OpenAI (付费，用户自配)
	OpenAIAPIKey  string
	OpenAIModel   string
	OpenAIBaseURL string
}

// Load 加载配置（优先读取环境变量，否则使用默认值）
func Load() *Config {
	cfg := &Config{
		Server: ServerConfig{
			Port: getEnv("PORT", "3210"),
			Mode: getEnv("GIN_MODE", "debug"),
		},
		DB: DBConfig{
			Path: getEnv("DB_PATH", "./gpilot.db"),
		},
		LLM: LLMConfig{
			// 默认使用 Gemini 免费层
			DefaultProvider: getEnv("LLM_PROVIDER", "gemini"),

			// Gemini 配置（用https://aistudio.google.com/ 免费获取）
			GeminiAPIKey:  getEnv("GEMINI_API_KEY", ""),
			GeminiModel:   getEnv("GEMINI_MODEL", "gemini-2.0-flash"),
			GeminiBaseURL: getEnv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),

			// 智谱 GLM-4V-Flash（https://open.bigmodel.cn/ 免费注册）
			ZhipuAPIKey:  getEnv("ZHIPU_API_KEY", ""),
			ZhipuModel:   getEnv("ZHIPU_MODEL", "glm-4v-flash"),
			ZhipuBaseURL: getEnv("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),

			// Ollama 本地（需要用户提前安装 Ollama 并运行 qwen2.5-vl）
			OllamaBaseURL: getEnv("OLLAMA_BASE_URL", "http://localhost:11434"),
			OllamaModel:   getEnv("OLLAMA_MODEL", "qwen2.5-vl:7b"),

			// OpenRouter（https://openrouter.ai/ 注册获得免费额度）
			OpenRouterAPIKey:  getEnv("OPENROUTER_API_KEY", ""),
			OpenRouterModel:   getEnv("OPENROUTER_MODEL", "qwen/qwen2.5-vl-72b-instruct:free"),
			OpenRouterBaseURL: getEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),

			// OpenAI（付费，用户自配时才生效）
			OpenAIAPIKey:  getEnv("OPENAI_API_KEY", ""),
			OpenAIModel:   getEnv("OPENAI_MODEL", "gpt-4o-mini"),
			OpenAIBaseURL: getEnv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		},
	}
	return cfg
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
