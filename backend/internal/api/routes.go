package api

import (
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// SetupRouter 配置路由
func SetupRouter() *gin.Engine {
	r := gin.Default()

	// CORS 配置（允许插件本地请求）
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: false,
	}))

	// 健康检查
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "G-Pilot Backend"})
	})

	api := r.Group("/api/v1")
	{
		// ─── 项目管理 ───
		api.GET("/projects", GetProjects)
		api.POST("/projects", CreateProject)
		api.GET("/projects/:id", GetProject)
		api.DELETE("/projects/:id", DeleteProject)

		// ─── 录制会话 ───
		api.GET("/sessions", GetSessions)
		api.POST("/sessions", CreateSession)

		// 嵌套 group，避免 :id 与 :sessionId 冲突
		sessionGroup := api.Group("/sessions/:id")
		{
			sessionGroup.GET("", GetSession)
			sessionGroup.PATCH("/status", UpdateSessionStatus)
			sessionGroup.DELETE("", DeleteSession)
			sessionGroup.GET("/steps", GetSteps)
			sessionGroup.POST("/steps", CreateStep)
			sessionGroup.PATCH("/steps/:stepId", UpdateStep)
			sessionGroup.GET("/generate", GenerateDoc) // SSE 流式
		}

		// ─── 截图 ───
		api.GET("/screenshots/:id", GetScreenshot)

		// ─── 脱敏规则 ───
		api.GET("/masking/profiles", GetMaskingProfiles)
		api.POST("/masking/profiles", CreateMaskingProfile)
		api.POST("/masking/profiles/:profileId/rules", AddMaskingRule)
		api.GET("/masking/defaults", GetDefaultMaskingRules)

		// ─── AI 相关 ───
		api.GET("/ai/providers/status", GetProvidersStatus)
		api.GET("/ai/steps/:stepId/describe", GenerateStepDescription)

		// ─── 文档 ───
		api.GET("/documents/:docId", GetDocument)
		api.GET("/documents/:docId/export", ExportDocument)

		// ─── LLM 提供商配置 ───
		api.GET("/llm/providers", GetLLMProviders)
		api.PUT("/llm/providers", UpsertLLMProvider)
	}

	return r
}
