package main

import (
	"log"

	"github.com/gpilot/backend/internal/api"
	"github.com/gpilot/backend/internal/config"
	"github.com/gpilot/backend/internal/db"
	"github.com/gpilot/backend/internal/service"
)

func main() {
	// 加载配置
	cfg := config.Load()

	// 初始化数据库
	if err := db.Init(cfg.DB.Path); err != nil {
		log.Fatalf("failed to init db: %v", err)
	}
	log.Println("✅ Database initialized:", cfg.DB.Path)

	// 初始化服务
	aiService := service.NewAIService(&cfg.LLM)
	docService := service.NewDocService()
	api.SetServices(aiService, docService)

	// 打印 VLM 提供商状态
	log.Println("📡 VLM Provider Status (Free-First Chain):")
	for _, p := range aiService.GetProvidersStatus() {
		status := "❌ Not configured"
		if p.Available {
			status = "✅ Available"
		}
		freeTag := ""
		if p.IsFree {
			freeTag = " [FREE]"
		}
		log.Printf("   %s%s: %s", p.Name, freeTag, status)
	}

	// 启动路由
	r := api.SetupRouter()

	addr := ":" + cfg.Server.Port
	log.Printf("🚀 G-Pilot Backend started on http://localhost%s", addr)
	log.Println("📖 API Docs: http://localhost" + addr + "/health")

	if err := r.Run(addr); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
