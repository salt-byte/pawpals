#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="PawPals"
APP_PATH="$PROJECT_DIR/dist/mac-arm64/$APP_NAME.app"

echo "🐾 [$APP_NAME] 停止正在运行的实例..."
pkill -f "$APP_NAME" 2>/dev/null || true
# 只 kill PawPals 自己的 gateway 进程（端口 18790），不动系统 openclaw LaunchAgent
pkill -f "openclaw.*18790" 2>/dev/null || true
sleep 1

echo "🧹 清理旧的构建产物和已安装版本..."
rm -rf "$PROJECT_DIR/dist"
rm -rf "/Applications/$APP_NAME.app"
rm -f "$HOME/Library/Application Support/PawPals/deployment.log"
rm -f "$HOME/Library/Application Support/PawPals/deployment-state.json"

echo "📦 重新构建..."
cd "$PROJECT_DIR"
npm run desktop:build

echo "🚀 启动新版本..."
OPENCLAW_BIN=/opt/homebrew/bin/openclaw "$APP_PATH/Contents/MacOS/PawPals" &

echo "✅ 完成！$APP_NAME 已启动。"
