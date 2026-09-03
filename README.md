<div align="center">

<img src="public/app-icon.png" alt="VTManager" width="104" />

# VTManager

**一个轻量便捷的磁盘视图管理工具**

把散落在硬盘里的影视与图片，变成一眼能找到、一点就能打开的个人媒体库。

<p>
  <a href="https://github.com/QuinnLSY/VTManager/releases/latest"><img src="https://img.shields.io/badge/下载-v1.0.2-5b8cff?style=flat-square&logo=github" alt="下载 v1.0.2"></a>
  <a href="https://github.com/QuinnLSY/VTManager/releases/latest"><img src="https://img.shields.io/github/v/release/QuinnLSY/VTManager?style=flat-square&label=Release" alt="Release"></a>
  <a href="https://github.com/QuinnLSY/VTManager/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-3ddc97?style=flat-square" alt="MIT License"></a>
  <a href="https://quinnlsy.github.io/VTManager/"><img src="https://img.shields.io/badge/在线操作手册-阅读-38e1ff?style=flat-square" alt="在线手册"></a>
  <a href="https://github.com/QuinnLSY/VTManager/issues"><img src="https://img.shields.io/badge/问题反馈-Issues-ffc24d?style=flat-square" alt="Issues"></a>
  <a href="https://github.com/QuinnLSY/VTManager/actions/workflows/ci.yml"><img src="https://github.com/QuinnLSY/VTManager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p>
  <img src="https://img.shields.io/badge/macOS-11+-000000?style=flat-square&logo=apple" alt="macOS 11+">
  <img src="https://img.shields.io/badge/Windows-10%2F11-0078d6?style=flat-square&logo=windows" alt="Windows 10/11">
  <img src="https://img.shields.io/badge/Tauri-2-ffc131?style=flat-square&logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Vue-3-42b883?style=flat-square&logo=vuedotjs" alt="Vue 3">
  <img src="https://img.shields.io/badge/Rust-2021-dea584?style=flat-square&logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/SQLite-bundled-003b57?style=flat-square&logo=sqlite" alt="SQLite">
</p>

</div>

---

## 📖 这是什么

VTManager 是一款**纯本地运行**的桌面应用。你只需把它的资料库指向存放影视或图片的硬盘目录，它就会以「目录树 + 封面网格」的方式，把数 TB 的视频、海报与照片整理成可浏览、可搜索、可播放的媒体库。

它不上传任何数据、不强制联网、不要求你改变现有的文件存放习惯——所有浏览、播放、打标签、收藏操作都不会改动你的原始文件；只有你主动执行重命名、移动、删除或智能归类时，才会真实改变磁盘内容，且删除会先进入回收站，随时可恢复。

### 适用人群与场景

| 场景 | VTManager 能做什么 |
|---|---|
| 🎬 **影音收藏党** | 数 TB 电影 / 剧集按目录层级管理，自动生成封面墙，点开即播，断点续播 |
| 📷 **摄影爱好者** | 按 EXIF 拍摄日期生成时间轴，缩放看图、旋转、Exif 信息一览 |
| 🗂️ **硬盘整理** | 全盘模糊搜索（支持拼音）、彩色标签、收藏分类、按日期智能归类 |
| 💾 **移动硬盘用户** | 数据全部存在硬盘上的 `.VTManager/` 目录里，硬盘一拷走，换台电脑继续用 |

### 设计原则

- **本地优先**：索引、缩略图、设置全部存在你自己的硬盘，不依赖任何云服务
- **零侵入**：不改动原始文件与目录结构，只在资料库根创建一个隐藏数据目录
- **轻量**：Tauri 2 原生壳 + 手写 CSS，安装包约 60MB，万级媒体库秒开秒刷
- **零依赖运行**：SQLite 静态编译、ffmpeg 内置，目标机器无需安装任何运行环境

---

## 🚀 快速开始：下载即用

### macOS（推荐）

1. 前往 [**Releases 页面**](https://github.com/QuinnLSY/VTManager/releases/latest) 下载 `VTManager-1.0.2-macos-arm64.dmg`（或 `.zip`）
2. 打开 dmg，把 `VTManager.app` 拖进「应用程序」文件夹
3. 首次启动选择你的影视 / 图片目录，等待后台索引完成即可开始浏览

> [!IMPORTANT]
> **首次打开若被系统拦截**：在访达中 **右键 `VTManager.app` → 打开** → 再点一次「打开」。
> 原因：应用为开发者自签名、未送 Apple 公证，macOS Gatekeeper 会默认拦截未公证应用。
> 这是 macOS 的标准安全提示，仅首次需要，之后可正常双击启动。
> 若提示「应用已损坏」，在终端执行：`xattr -cr /Applications/VTManager.app`

| 文件 | 说明 | SHA-256 |
|---|---|---|
| `VTManager-1.0.2-macos-arm64.dmg` | 磁盘镜像（推荐，拖入 Applications） | `5a9e91758c96179c2774db1a62abac0f946f85097da6d03741e732475040bedd` |
| `VTManager-1.0.2-macos-arm64.zip` | 压缩包（含 App + 操作手册 + 使用须知） | `38989175914a81b7567415356826f05c85e105e1de94ea1ad3f9679bbf37bdaf` |

### Windows

暂未提供预编译安装包。可使用源码在本机构建，或通过仓库内置的 GitHub Actions 云端构建（详见下方 [从源码构建](#-从源码构建)）。

### 系统要求

- **macOS 11+**（Apple Silicon / Intel），无需安装任何运行环境
- 除 TMDB 在线刮削（需自行填写 API Key）外，不发起任何网络请求

---

## 📚 使用说明

### 在线操作手册

完整功能介绍、图文说明与常见问题，请访问独立发布的在线手册：

> ### 🔗 [https://quinnlsy.github.io/VTManager/](https://quinnlsy.github.io/VTManager/)

也可以直接打开仓库中的 [`操作手册.html`](操作手册.html)，或用下载包内附的同名文件（浏览器打开即可）。

### 60 秒上手

1. **选择目录** — 打开应用，添加视频 / 图片根目录
2. **自动索引** — 后台扫描生成缩略图，可边扫边浏览
3. **浏览管理** — 网格 / 分栏 / 时间线浏览，批量打标签、收藏
4. **即点即播** — 双击播放，支持断点续播、画中画、倍速、字幕与截图

### 常用快捷键

| 操作 | 快捷键 | 操作 | 快捷键 |
|---|---|---|---|
| 搜索 | <kbd>⌘</kbd> + <kbd>F</kbd> | 播放 / 暂停 | <kbd>空格</kbd> |
| 批量多选 | <kbd>⌘</kbd> + 点击 | 全屏 | <kbd>F</kbd> |
| 快退 / 快进 10 秒 | <kbd>J</kbd> / <kbd>L</kbd> | 倍速调节 | <kbd>[</kbd> / <kbd>]</kbd>（0.25–6.0×） |
| 上 / 下一个 | <kbd>←</kbd> / <kbd>→</kbd> | **长按临时 2× 加速** | 按住 <kbd>→</kbd> ≥ 0.4 秒，松开恢复 |
| 字幕开关 | <kbd>C</kbd> | 当前帧截图 | <kbd>S</kbd> |

---

## ✨ 功能一览

<details open>
<summary><b>🗂️ 浏览与组织</b></summary>

- **多级目录**：影视分类 → 系列 → 详情 → 资源，支持任意深度自定义层级
- **多视图**：网格 / 分栏（文件夹｜视频｜图片，栏宽可拖）/ 时间线 / 列表
- **封面系统**：目录与视频可设封面（本地图片 / 视频截帧 / TMDB 海报），未设置时自动生成缩略图
- **全盘模糊搜索**：文件名片段、拼音全拼、拼音首字母均可命中，结果带真实缩略图，点击跳转定位
- **彩色标签**：六色标签 + 全局标签浏览，文件夹标签对子项继承
- **收藏与分类**：收藏夹分类管理、最近添加、快速筛选
- **排序**：名称 / 创建时间 / 修改时间 × 正序 / 倒序，分栏每栏独立记忆
- **照片时间轴**：按 EXIF / 媒体创建日期分组浏览照片与视频

</details>

<details open>
<summary><b>🎬 视频播放</b></summary>

- HTML5 播放器，大文件流式播放、**断点续播**、上一 / 下一个自动连播
- **自定义控制栏**：进度条、缓冲条、播放 / 暂停、音量、倍速水平居中，悬停唤醒、自动隐藏
- **进度条悬停实时帧预览**（精灵图缓存，拖动即时出图）
- **倍速 0.25×–6.0×**：预设档位 + 2–6× 自定义滑动条
- **长按右方向键临时 2× 加速**：按住 0.4 秒进入当前倍速 ×2（上限 6×），松开立即恢复；短按仍是「下一个视频」
- **外挂字幕**：同目录同名 `.srt` / `.vtt` 自动加载，支持手动选择文件、开关与字号调节
- **当前帧截图**：`S` 键或控制栏按钮，保存为原分辨率 PNG，目录可自定义
- **画中画与独立全屏窗口**（PiP），多屏 / 摸鱼两不误
- **缩略图条**：底部条带可拖动、**滚轮悬停前后浏览**、点击跳转

</details>

<details open>
<summary><b>🖼️ 图片查看</b></summary>

- 缩放 / 平移 / 旋转 / 翻页，独立全屏窗口
- 媒体详情面板：EXIF 信息、视频码流参数
- 缩略图条快速跳转，支持滚轮前后浏览

</details>

<details open>
<summary><b>✏️ 文件管理</b></summary>

- 拖拽导入、应用内拖拽移动、新建文件夹
- 重命名、批量重命名、批量移动、批量删除
- **安全删除**：删除进回收站，可恢复 / 彻底删除 / 清空，支持到期自动清除（默认 3 天，可设 0–365 天）
- **智能归类**：按拍摄日期一键生成「年 / 年-月」归类计划，预览后可应用 / 撤销
- **TMDB 刮削**（可选联网）：按目录名匹配电影，一键填充中文名、年份、评分、简介与高清海报

</details>

<details>
<summary><b>🛠️ 维护与性能</b></summary>

- **存储空间面板**：展示应用数据占用明细与应用本体大小
- **一键清除缓存** / **优化数据库**（VACUUM 压缩，显示释放空间）
- **缓存目录一键进入**：设置中显示当前资料库缓存目录，点击直接在 Finder / 资源管理器打开
- **缓存策略**：WebP 缩略图与预览缓存（体积 −40%）、按时间自动过期（1 / 6 / 24 小时或永不，支持自定义）、2GB 自动上限清理
- **转封装缓存「关闭即删」**：拖进度条用的临时副本在关闭播放器后自动删除，不占空间
- **性能优化**：SQLite WAL 并发、增量索引扫描（二次扫描秒级）、缩略图并行生成（线程按 CPU 核数自适应）、AVFoundation 视频处理主路径、大图降采样预览（内存 −90%）、超大目录虚拟滚动、空闲预生成缩略图、弹窗组件代码分割
- **外部变更自动感知**：文件监听 + 轮询兜底，硬盘里改了文件，应用自动同步
- **日夜主题**切换

</details>

---

## 🧑‍💻 从源码构建

<details>
<summary><b>环境要求</b>（点击展开）</summary>

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 含 npm |
| Rust | stable（rustup 安装） | 编译 Tauri 后端 |
| Xcode Command Line Tools | macOS | `xcode-select --install` |
| MSVC Build Tools + WebView2 | Windows | Win10/11 自带 WebView2 |
| ffmpeg | 任意近期版本 | **需自行准备，见下方说明** |

> SQLite 使用 rusqlite bundled 静态编译、HTTP 使用 reqwest + rustls，均**无需系统额外安装**数据库或 OpenSSL。

</details>

### 1. 准备 ffmpeg

二进制体积大且不随仓库分发。macOS 执行：

```bash
brew install ffmpeg
cp $(which ffmpeg) bin/ffmpeg
```

Windows 将 `ffmpeg.exe` 放入 `bin/` 即可（`scripts/package-windows.ps1` 也会自动下载）。详见 [`bin/README.md`](bin/README.md)。

### 2. 安装依赖并运行

```bash
git clone https://github.com/QuinnLSY/VTManager.git
cd VTManager
npm install
npm run app:dev        # 开发模式：Tauri 窗口 + 前端热更新
```

### 3. 构建发布包

```bash
npm run app:build      # 构建当前平台的发布包
```

- **macOS** 产出 `src-tauri/target/release/bundle/macos/VTManager.app`，再执行 `bash scripts/package-macos.sh` 完成 ffmpeg 装入 + 重新签名，输出到 `release/VTManager/`
- **Windows** 产出 NSIS `.exe` 与 `.msi`；也可一键执行 `scripts/package-windows.ps1`

> **Windows 包无法在 macOS 上交叉编译产出**（需 MSVC + Windows SDK + WiX / NSIS 等 Windows 专有工具）。
> 推荐用仓库内置的 GitHub Actions 云端构建：推送标签 `git tag v1.0.2 && git push --tags`，或在 Actions 页手动触发 **Build Windows**，约 5–10 分钟后在 Artifacts 下载。详见 [`release-windows/README.md`](release-windows/README.md)。

### 4. 运行测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单元测试（15 项）
VITE_MOCK=1 npm run dev &                         # 启动 mock 后端
node scripts/mock-verify.mjs                      # 前端端到端回归（共 15 个脚本 221 项）
```

---

## ⚠️ 本地配置注意事项与排错

<details open>
<summary><b>常见问题速查</b></summary>

**Q1. `npm run app:build` 报找不到 `bin/ffmpeg`**
打包脚本会把 ffmpeg 复制进应用包用于转封装兜底。按上文准备 ffmpeg，或临时注释 `scripts/package-macos.sh` 中复制 ffmpeg 的一行（应用仍可正常构建运行，仅失去部分容器兼容能力）。

**Q2. macOS 提示「VTManager 已损坏，无法打开」**
应用为自签名未公证。执行：

```bash
xattr -cr /Applications/VTManager.app
```

或右键 App → 打开（仅首次）。

**Q3. Windows 提示「未知发布者」（SmartScreen）**
安装包未做代码签名，点「更多信息 → 仍要运行」即可。分发给他人建议购买代码签名证书。

**Q4. 首次 Rust 编译很慢 / `target/` 目录巨大**
首次 `cargo build` 需编译全部依赖，约 10–20 分钟；`src-tauri/target/` 可能达到 10GB，属正常产物，已加入 `.gitignore`。

**Q5. 媒体文件加载不出来（图片 / 视频空白或 403）**
`src-tauri/tauri.conf.json` 中 `assetProtocol.scope.requireLiteralLeadingDot` 必须为 `false`，否则 `.VTManager` 下的隐藏目录资源会被安全策略拦截。**请勿修改该项**。

**Q6. 新增 Tauri 插件后命令被静默拒绝**
新增插件 / window API 必须同步在 `src-tauri/capabilities/default.json` 中追加权限声明。

**Q7. `npm run dev` 端口 5173 被占用**
修改 `vite.config.ts` 中的 `server.port`，或结束占用进程。

**Q8. 浏览器预览时功能异常**
纯 `npm run dev` 只有前端、无后端，需配合 `VITE_MOCK=1 npm run dev`（mock 后端）或 `npm run app:dev`（完整 Tauri 窗口）。

**Q9. 数据存在哪里？换电脑怎么迁移？**
索引与缓存存放在**资料库根目录**的 `.VTManager/` 中（`vtmanager.db`、`covers/`、`cache/`、`.trash/`）；应用设置（1.0.2-r8+）为全局设置，存于应用数据目录的 `prefs.json`。
把硬盘拷到新电脑后，打开应用 → 指向该目录即可继续使用。迁移时请连同 `vtmanager.db-wal`、`vtmanager.db-shm` 一起拷贝。

**Q10. 清除缓存 / 优化数据库会丢数据吗？**
不会。缓存可随时清空并按需重建；VACUUM 只压缩索引文件本身。你的原始媒体、标签、收藏与观看进度不受影响。

</details>

---

## 🗂️ 项目结构

```
VTManager/
├── src/                  # 前端：Vue 3 + TypeScript（UI、组件、状态、mock 联调后端）
├── src-tauri/            # 后端：Rust（Tauri 命令、文件系统、SQLite、缓存、AV 处理）
│   ├── src/commands.rs   # 全部 Tauri 命令入口
│   ├── src/media.rs      # 缩略图 / 预览缓存、截帧、EXIF、封面
│   ├── src/av.rs         # macOS AVFoundation 视频处理主路径
│   ├── src/cache.rs      # 缓存管理与过期清理
│   └── capabilities/     # Tauri 权限声明
├── bin/                  # 外部二进制依赖放置目录（ffmpeg 需自备）
├── scripts/              # 打包脚本与 15 个 mock 回归验证脚本
├── docs/                 # 开发指南、版本溯源、使用须知
├── 操作手册.html          # 面向用户的操作手册（同时发布为在线网页）
└── release/              # 打包产物（不入库）
```

技术栈细节、Rust 模块地图与内部约定，见开发文档 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) 与版本溯源 [`docs/UPGRADE.md`](docs/UPGRADE.md)。

---

## 🤝 参与贡献

欢迎任何形式的贡献：**提交 Issue 反馈问题、提出功能建议、改进文档，或提交 Pull Request**。

📄 **[贡献指南 CONTRIBUTING.md](CONTRIBUTING.md)** · 🔒 **[安全策略 SECURITY.md](SECURITY.md)** · 📝 **[更新日志 CHANGELOG.md](CHANGELOG.md)**

### 提交 Issue

- 🐛 **Bug 反馈**：请附上系统版本、应用版本、复现步骤，以及（如有）控制台日志
- 💡 **功能建议**：说明使用场景与希望解决的痛点
- 提交前建议先搜索 [已有 Issue](https://github.com/QuinnLSY/VTManager/issues)，避免重复

### 提交 Pull Request

1. Fork 本仓库，基于 `main` 创建分支（如 `feat/xxx`、`fix/xxx`）
2. 完成改动并确保通过验证：
   - Rust 侧：`cargo fmt` + `cargo clippy` + `cargo test`
   - 前端侧：`npm run build`，并运行相关 `scripts/mock-verify-*.mjs` 回归脚本
3. 提交信息建议使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范（如 `feat:`、`fix:`、`docs:`）
4. 发起 PR，描述改动动机、实现方式与验证结果

### 开发约定

- 前端不引入重型 UI 框架，样式为手写 CSS（扁平化淡蓝主题）
- 修改文件系统状态的 Rust 命令，成功后需调用 `cache::invalidate_dir_cache()` 使目录缓存失效
- 新增 Tauri 命令需三处同步：`src-tauri/src/commands.rs` 定义与注册、`src/api.ts` 封装、`src/mock/tauri.ts` mock 分支
- 涉及设置的功能请走全局 `prefs.json`，跨窗口（如 PiP 独立窗口）判断设置应在后端读取

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源，可自由使用、修改与分发。

<div align="center">

如果 VTManager 帮到了你，欢迎给项目点个 ⭐ Star —— 这是对我最大的鼓励！

Made with ❤️ by [@QuinnLSY](https://github.com/QuinnLSY)

</div>
