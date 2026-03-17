#!/bin/bash

echo "正在卸载 PawPals..."

# 停止进程
pkill -f "PawPals" 2>/dev/null || true
pkill -f "openclaw.*18790" 2>/dev/null || true
sleep 1

# 删除 app
rm -rf "/Applications/PawPals.app"

# 删除所有数据
rm -rf "$HOME/Library/Application Support/PawPals"

echo ""
echo "✅ PawPals 已完全卸载。"
