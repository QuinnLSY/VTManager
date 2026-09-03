#!/bin/bash
# VTManager macOS 打包脚本：构建 .app 并装入 ffmpeg，输出到 release/
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> 构建 VTManager.app（含前端 + Rust）"
touch src-tauri/src/commands.rs   # 触发 lib 重编译以嵌入最新前端资源
npm run app:build

APP="src-tauri/target/release/bundle/macos/VTManager.app"
# 1.0.2：视频元数据/截帧主路径已由系统 AVFoundation 接管，发布包不再附带 ffprobe
# （约 -49MB）；ffmpeg 仅保留用于「faststart 转封装」与 AVFoundation 不支持的容器回退。
echo "==> 复制 ffmpeg 进应用包（ffprobe 已移除，体积 -49MB）"
cp bin/ffmpeg "$APP/Contents/MacOS/"

echo "==> 组装发布包"
mkdir -p release/VTManager
rm -rf release/VTManager/VTManager.app
cp -R "$APP" release/VTManager/
cp 操作手册.html app-icon.png release/VTManager/ 2>/dev/null || true

# 关键：上面把 ffmpeg 复制进 Contents/MacOS 后，bundle 内容已变，构建期由 linker 打的
# ad-hoc 签名随之失效（spctl 会报 "code has no resources but signature indicates they
# must be present"）。这种状态的包拷到别的 Mac 上会被 Gatekeeper 判为「已损坏」而拒绝打开。
# 这里重新做一次 ad-hoc 签名，使包体自洽（仍属未公证签名，首次打开需右键「打开」）。
echo "==> 重新 ad-hoc 签名（修复复制 ffmpeg 后签名失效）"
codesign --force --deep --sign - release/VTManager/VTManager.app
codesign -v release/VTManager/VTManager.app && echo "    签名校验通过"

echo "==> 完成：release/VTManager/"
ls -lh release/VTManager/
