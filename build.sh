#!/bin/bash
set -e

# 卸载所有 "Leduo Wow" 残留挂载卷，防止 hdiutil create 冲突
echo "Detaching any mounted Leduo Wow volumes..."
for vol in /Volumes/Leduo\ Wow*; do
  if [ -d "$vol" ]; then
    echo "  Detaching: $vol"
    hdiutil detach "$vol" -force 2>/dev/null || true
  fi
done

# 清理旧的构建产物
rm -rf dist/mac-arm64

# 禁止 Spotlight 索引 dist 目录，防止新签名的 .app 被锁导致 hdiutil 失败
mkdir -p dist
touch dist/.metadata_never_index

# 构建
npm run build:native && npm run build && npm run pack
