# bin/ — 外部二进制依赖放置目录

本目录用于放置构建期需要打入应用包的外部二进制。**这些文件不纳入 Git 版本控制**（体积大且为第三方产物），需自行准备。

## macOS 打包所需

| 文件 | 用途 | 获取方式 |
|---|---|---|
| `ffmpeg` | 视频「faststart 转封装」，以及 AVFoundation（系统解码器）不支持的容器回退截帧 | `brew install ffmpeg`，然后 `cp $(which ffmpeg) bin/ffmpeg` |

> `ffprobe` 自 1.0.2 起已不再需要（元数据探测优先走 AVFoundation），发布包不再分发，可节省约 49MB。

## Windows 打包所需

`ffmpeg.exe` —— `scripts/package-windows.ps1` 会自动下载，无需手动放置。

## 注意

- `scripts/package-macos.sh` 会执行 `cp bin/ffmpeg "$APP/Contents/MacOS/"`；若缺少该文件，打包脚本会失败。
- 复制二进制进 `.app` 后 bundle 内容发生变化，脚本内置了 `codesign --force --deep --sign -` 重新 ad-hoc 签名步骤，**请勿调整该顺序**，否则分发到其他 Mac 会被 Gatekeeper 判为「已损坏」。
- 若你不需要转封装 / 回退截帧功能，可临时注释掉脚本中复制 ffmpeg 的一行，应用仍可正常构建运行。
