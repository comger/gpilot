BACKEND_DIR=./backend
EXT_DIR=./extension
NODE_18=source $$NVM_DIR/nvm.sh && nvm use 18.17.1 &&

.PHONY: all backend extension clean run-backend

all: backend extension

## 启动后端服务（开发模式）
run-backend:
	@echo "🚀 启动 G-Pilot 后端 (http://localhost:3210)"
	@cd $(BACKEND_DIR) && go run cmd/server/main.go

## 构建后端
backend:
	@echo "🔨 构建 Go 后端..."
	@cd $(BACKEND_DIR) && go build -o build/gpilot-server ./cmd/server
	@echo "✅ 后端已构建: backend/build/gpilot-server"

## 构建 Chrome 扩展
extension:
	@echo "🔨 构建 Chrome 扩展..."
	@cd $(EXT_DIR) && export NVM_DIR="$$HOME/.nvm" && $(NODE_18) npm run build
	@echo "✅ 扩展已构建: extension/dist/"
	@echo "   在 Chrome > 扩展程序 > 加载已解压的扩展程序 > 选择 extension/dist/"

## 仅复制 manifest 等静态资源
ext-assets:
	@cd $(EXT_DIR) && export NVM_DIR="$$HOME/.nvm" && $(NODE_18) node scripts/copy-assets.mjs

clean:
	@rm -rf $(BACKEND_DIR)/build $(EXT_DIR)/dist
	@echo "🧹 清理完成"

## 显示帮助
help:
	@echo ""
	@echo "  G-Pilot 构建命令"
	@echo "  ─────────────────────────────────────"
	@echo "  make run-backend   启动后端服务器"
	@echo "  make backend       构建后端可执行文件"
	@echo "  make extension     构建 Chrome 扩展"
	@echo "  make all           构建全部"
	@echo "  make clean         清理构建产物"
	@echo ""
