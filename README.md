# VTManager

**v1.0.2** · 影视与图片的本地可视化管理应用（macOS / Windows）

VTManager 是一款单机桌面应用，直接指向你的影视/图片硬盘目录，以「目录树 + 封面网格」的方式管理数 TB 的视频、海报与照片资源。所有操作都真实作用于硬盘文件系统，应用本身不改变你现有的资源存放习惯。

## 功能总览（v1.0.2）

- **多级目录管理**：影视分类（一级）→ 系列（二级）→ 电影详情（三级）→ 资源（四级），支持任意深度自定义层级
- **封面系统**：二/三级目录可设置封面（本地图片 / 视频截帧 / TMDB 海报）；视频封面支持从视频截帧或上传图片，未设置时自动生成缩略图
- **悬停动效**：封面/图片悬停小幅放大 + 柔白光晕高亮；视频悬停显示播放按钮，单击即播
- **文件操作**：拖拽导入（从系统资源管理器拖入）、应用内拖拽移动、新建文件夹、重命名、批量重命名、批量移动、批量删除、安全删除（回收站可恢复）、批量彩色标签、批量收藏
- **分栏视图**：目录自动按 文件夹｜视频｜图片 分栏展示（可切换网格/时间轴），栏宽可拖动
- **彩色标签**：六色标签 + 全局标签浏览（文件夹标签对子项继承）
- **排序**：名称 / 创建时间 / 修改时间 × 正序 / 倒序（分栏每栏独立记忆）
- **全盘模糊搜索**：按文件名片段、拼音全拼、拼音首字母搜索，结果带真实缩略图，点击直接跳转定位
- **应用内预览**：HTML5 视频播放器（大文件流式播放、断点续播、上一/下一、快捷键、自定义控制栏——进度条与播放/快进/快退/倍速/音量键**水平居中**、倍速 0.25–6.0（预设 0.25/0.5/0.75/1/1.5/2 + 2–6 自定义**滑动条**）、**长按右方向键临时 2× 加速**（当前倍速 ×2、上限 6×，松开恢复原倍速；短按仍为「下一个视频」）、画中画、快进/快退 10 秒、点击画面暂停/继续、**进度条悬停实时帧预览**、**本地字幕加载**——同目录同名 .srt/.vtt 自动加载/手动选择文件/开关/字号调节、**当前帧截图**——按钮或 S 键存为原分辨率 PNG、默认存资料库 captures/ 目录可自定义）+ 图片查看器（缩放/平移/旋转/翻页/缩略图条）；两者底部**缩略图条**均支持鼠标拖动横向滑动、**滚轮悬停前后浏览**（纵向滚轮转横向滚动，不切换当前条目）、点击跳转；可随时切换到外部默认应用打开
- **可选在线刮削**：按目录名到 TMDB 匹配电影，一键填充中文名、年份、评分、简介与高清海报
- **照片时间轴**：按拍摄日期（EXIF/ffprobe 创建时间）分组浏览照片与视频
- **智能归类**：按拍摄日期一键生成「年 / 年-月」归类计划，预览后可应用/撤销
- **其他**：最近添加、收藏夹（分类管理）、回收站（可恢复/彻底删除/清空/**到期自动清除，默认 3 天可设 0–365 天，条目显示到期时间**）、日夜主题、外部变更自动感知（文件监听 + 轮询兜底）、文件夹占用显示、媒体详情面板（EXIF/码流）、视频截帧封面实时预览
- **性能优化**（r13 + 1.0.2）：SQLite WAL 并发读写、增量索引扫描（二次扫描秒级完成）、缩略图并行生成（线程按 CPU 核数自适应）、AVFoundation 视频处理主路径（替代 ffprobe，失败自动回退 ffmpeg）、大图查看降采样预览（内存降 90%+）、超大目录虚拟滚动、缩略图/预览 WebP 缓存（体积 −40%）、目录列表 3 秒内存缓存、Rust fat-LTO + panic=abort 编译优化、弹窗组件代码分割（主包 −33%）、播放器解码资源及时释放、网格图片异步解码懒加载
- **维护功能**（1.0.2）：设置面板「存储空间」展示应用数据占用明细 + 应用本体大小，红色「一键清除缓存」按钮，绿色「优化数据库」按钮（VACUUM 压缩，显示释放空间），空闲时后台预生成缩略图（浏览即点即有，不抢扫描）；「缓存保留时长」下方实时显示当前资料库的缓存目录（`<库根>/.VTManager/cache`，切换资料库自动更新），点「进入缓存目录」一键在 Finder/资源管理器中打开，方便管理缓存文件

## 技术栈及各部分作用

| 层 | 技术 | 在项目中的作用 |
|---|---|---|
| 桌面壳 | **Tauri 2**（`src-tauri/`） | 打包为原生 .app / .exe，提供窗口、Web 安全协议（assetProtocol 用于本地图片/视频加载） |
| 核心逻辑 | **Rust**（`src-tauri/src/`） | 全部文件系统操作、SQLite、ffmpeg 调用、TMDB 请求 |
| 前端界面 | **Vue 3 + TypeScript + Vite**（`src/`） | 全部 UI，无重型 UI 框架，纯手写 CSS 扁平化淡蓝主题 |
| 前后端桥 | `@tauri-apps/api` invoke（`src/api.ts`） | 前端调用 Rust 命令，参数自动序列化 |
| 数据库 | **SQLite**（rusqlite bundled，无需安装） | 搜索索引、封面索引、TMDB 元数据、收藏、回收站记录、设置 |
| 视频处理 | **AVFoundation**（macOS 系统能力，objc2 绑定）+ **静态 ffmpeg**（`bin/`，随应用分发） | 视频缩略图/截帧/元数据优先走系统 AVFoundation（快、零依赖），失败自动回退 ffmpeg；ffmpeg 另负责 moov 前置转封装兜底；发布包不含 ffprobe，目标机器**零依赖** |
| EXIF | kamadak-exif | 照片拍摄日期（时间轴视图） |
| 拼音搜索 | pinyin | 中文文件名转拼音/首字母建立搜索索引 |
| 系统对话框 | tauri-plugin-dialog（权限声明于 `src-tauri/capabilities/default.json`） | 目录/文件选择；**新增插件时必须同步追加 capabilities 权限** |
| HTTP | reqwest (rustls) | TMDB 刮削（仅此功能联网） |

### Rust 模块地图（src-tauri/src/）

| 文件 | 职责 |
|---|---|
| `commands.rs` | 全部 Tauri 命令入口（约 40 个）与 Builder 装配（含 optimize_db / prewarm_thumbs / app_bytes） |
| `state.rs` | 应用状态：当前资料库根、DB 连接守卫（DbGuard） |
| `db.rs` | SQLite 打开/建表、重命名/删除后的路径引用同步 |
| `fsops.rs` | 目录列表、建目录、重命名、移动、复制、回收站全套 |
| `media.rs` | ffmpeg/ffprobe 路径解析与调用、缩略图/预览缓存（1.0.2+ WebP）、截帧、EXIF、封面保存 |
| `av.rs` | macOS AVFoundation 视频处理（1.0.2+）：元数据探测 + 截帧主路径，失败回退 ffmpeg/ffprobe |
| `scan.rs` | 后台索引扫描（r13+ 增量：按 (path, mtime) 对比，未变跳过/变化更新/消失清理，事件上报进度、拼音字段） |
| `cache.rs` | 缓存管理（r13+/1.0.2）：磁盘占用统计、一键清缓存、2GB 自动上限清理、按时间自动过期（1.0.2-r4+，`cache_ttl_hours` 可调）、目录列表 3 秒 TTL 缓存 |
| `sys.rs` | **平台解耦层**：打开文件/定位文件/已安装应用列表/卷根检测（macOS 与 Windows 各自实现） |
| `tmdb.rs` | TMDB 搜索、详情、海报下载 |
| `types.rs` / `util.rs` | 序列化结构体 / 通用工具（hash、隐藏文件判断、EXIF 时间解析） |

## 数据存放（随硬盘迁移）

应用在资料库根目录创建唯一的数据目录 `.VTManager/`：

```
.VTManager/
├── vtmanager.db      # SQLite（WAL 模式，含 -wal/-shm 伴生文件）：索引/封面/元数据/回收站（应用设置 1.0.2-r8+ 已迁出至全局 prefs.json）
├── covers/           # 封面图片（截帧/上传/TMDB 海报）
├── cache/thumbs/     # 自动缩略图缓存（WebP，可再生，可随时清空重建）
├── cache/previews/   # 大图查看预览缓存（WebP，r13+，可再生）
├── cache/remux/      # 视频转封装缓存（r9+，可再生）
├── cache/scrubs/     # 进度条悬停帧预览精灵图（1.0.2-r5+，WebP，可再生）
└── .trash/           # 回收站暂存区
```

另有 `captures/`（资料库根下，与 `.VTManager/` 平级）——播放器「当前帧截图」默认保存目录（1.0.2-r7+），可在播放器字幕菜单中改到任意位置。

- **应用设置全部为全局设置**（1.0.2-r8+）：主题、回收站天数、缓存保留时长、播放/看图行为等所有设置存于**应用数据目录的 `prefs.json`**，切换资料库根目录不会重置任何设置；从旧版本升级时首次启动自动把原资料库设置一次性迁移为全局默认。

- 缓存总量超过 2GB 时应用自动清理最旧缓存；设置面板「存储空间」可一键清除缓存、一键优化数据库（VACUUM 压缩），均不影响正常使用。
- **缓存按时间自动过期**（1.0.2-r4+，默认 1 小时）：缩略图/预览缓存超过保留时长未被再次查看即自动删除，之后访问按需重建（命中即续期）；可在设置 → 存储空间中选 1 / 6 / 24 小时或永不清理，也可**自定义输入任意小时数**（0–8760）。预览缓存已瘦身至旧方案约 40% 体积（1600px WebP），观感不变。
- **转封装缓存「关闭即删」**（默认开）：MKV/AVI 等格式应用内播放时会在资料库缓存生成一份与原视频等大的转封装副本（用于流畅拖动进度条）；关闭播放器或切换视频时自动删除该副本、不占用额外空间，再次播放会自动快速重建（秒级）。可在设置 → 播放与查看中切为「保留副本（重播秒开）」。
- **回收站到期自动清除**（1.0.2-r6+，默认 3 天）：删除的文件/文件夹进入回收站后按设定天数到期自动彻底清除（进入回收站即写入到期时间）；可在设置 → 回收站中改 0–365 天（0=永不），修改后站内全部条目按当前时间重置到期时间并**即时刷新**（无需重进回收站）；每条记录显示剩余天数与到期日期，删除确认弹窗同步提示「文件将于 N 天后自动清除，请及时查验」。
- 应用本体（VTManager.app 或 exe）建议放在同一硬盘内。应用启动时自动检测所在卷/盘符根目录，若存在 `.VTManager` 则自动打开该资料库 —— **把整个硬盘拷走，换台电脑即可继续使用**（迁移时请连同 `vtmanager.db-wal` / `vtmanager.db-shm` 一起拷贝）。

## 构建与开发（双平台解耦，可独立构建）

### 环境

- Node.js ≥ 18、npm
- Rust（rustup）—— macOS 需 Xcode Command Line Tools；Windows 需 MSVC Build Tools 与 WebView2（Win10/11 自带）
- 静态 ffmpeg 放入 `bin/`（本仓库已含 macOS arm64 版；Windows 请下载全静态 gpl build 的 `ffmpeg.exe` 放入同一目录；1.0.2 起发布包不再携带 ffprobe，视频元数据/截帧优先走系统 AVFoundation）

### 常用命令

```bash
npm install          # 安装前端依赖
npm run dev          # 仅前端热更新（浏览器预览，无后端）
npm run app:dev      # 完整开发模式（Tauri 窗口 + 前端热更新）
npm run app:build    # 构建当前平台的发布包
```

`npm run app:build` 在 **macOS** 上产出 `.app`（`src-tauri/target/release/bundle/macos/VTManager.app`）与 `.dmg`；在 **Windows** 上产出 NSIS 安装包与 portable exe（`src-tauri/target/release/bundle/nsis/`、`src-tauri/target/release/vtmanager.exe`）。两个平台的构建互不依赖，在各自系统上独立执行即可。

macOS 构建完成后，把 ffmpeg 复制进应用包（或运行 `scripts/package-macos.sh`）：

```bash
cp bin/ffmpeg src-tauri/target/release/bundle/macos/VTManager.app/Contents/MacOS/
```

> 1.0.2 起只需复制 `ffmpeg`（视频转封装兜底与 AVFoundation 失败回退用），不再复制 `ffprobe`——发布体积因此减小约 49MB。

Windows 构建时，tauri 会把 `bin/*.exe` 旁的二进制直接放到 exe 同目录，无需手工复制。

### Windows 打包

> **Windows 安装包无法在 macOS 上产出**——Tauri 不支持交叉编译打包：构建 Windows 包必需的 MSVC + Windows SDK + WiX（`.msi`）+ NSIS（`.exe`）均为 Windows 专有工具。完整流程、环境要求与常见问题见 [`release-windows/README.md`](release-windows/README.md)。

两种方式任选其一：

**A. 云端构建（推荐，零本地环境）** —— 已内置 `.github/workflows/build-windows.yml`

1. 把代码推送到 GitHub 仓库（私有仓库亦可，Actions 免费额度足够）
2. 打标签 `git tag v1.0.2 && git push --tags`，或在仓库 **Actions** 页选 `Build Windows` → `Run workflow`
3. 约 5–10 分钟后在 Actions 运行页底部 **Artifacts** 下载 `VTManager-Windows`，内含 NSIS `.exe` 与 `.msi`（Windows 版 ffmpeg 由工作流自动下载）

**B. Windows 本机一键打包** —— 在项目根目录打开 PowerShell

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\package-windows.ps1
```

脚本自动完成：环境检查 → 下载 `ffmpeg.exe` → `npm install` → `tauri build` → 汇总安装包与手册到 `release-windows/`。

> 安装包未做代码签名，Windows 会提示「未知发布者」（SmartScreen），点「更多信息 → 仍要运行」即可。分发给他人建议购买代码签名证书消除提示。

### Windows 平台 ffmpeg 提示

`bin/ffmpeg`（macOS 版）不会被 Windows 构建引用；Windows 下确保 `bin/ffmpeg.exe` 存在即可，运行时按 `ffmpeg` → `ffmpeg.exe` 顺序自动解析。Windows 无 AVFoundation，视频元数据/截帧直接走 ffmpeg/ffprobe（回退链路即为常态路径）。

## 分发（拷到别的机器 / 移动硬盘）

**只需拷贝 `release/VTManager/` 目录（约 60MB）**，无需整个项目（27.6GB 中绝大部分是开发产物）：

| 目录 | 体积 | 是否分发 |
|---|---|---|
| `release/VTManager/` | 60MB | ✅ 拷这个（应用 + 操作手册 + 图标） |
| `testlib/` | 12G | ❌ 开发测试素材 |
| `src-tauri/target/` | 10G | ❌ Rust 编译中间产物 |
| `node_modules/` | 74M | ❌ 前端依赖（已打包进应用） |

媒体数据与索引都存在**资料库目录**下的 `.VTManager/` 中（不在应用包内），因此换机器或拷到移动硬盘后，打开应用 →「打开资料库」指向媒体目录即可继续使用，**不写系统盘**。首次打开会按需重建缩略图缓存，稍慢属正常（之后即秒开）。

## 升级与溯源

- 数据库表结构、数据目录布局、版本变更记录见 [`docs/UPGRADE.md`](docs/UPGRADE.md) —— 升级版本时按此文档做迁移
- 应用操作说明见 [`操作手册.html`](操作手册.html)（应用介绍页，可直接用浏览器打开）

## 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单元测试
node scripts/mock-verify.mjs                      # 前端端到端验证（需先 VITE_MOCK=1 npm run dev）
```

浏览器联调（mock 后端）验证脚本位于 `scripts/`：`mock-verify.mjs`（基础 25 项）、`mock-verify-fixes.mjs`（12 项）、`mock-verify-theme-chrome.mjs`（16 项）、`mock-verify-rot-sync.mjs`（6 项）、`mock-verify-batch-search.mjs`（11 项）、`mock-verify-perf.mjs`（性能优化专项 11 项）、`mock-verify-dblclick.mjs`（双击防误触专项 9 项）、`mock-verify-cache-ttl.mjs`（缓存过期专项 8 项）、`mock-verify-scrub.mjs`（播放器悬停帧预览 + 控制栏专项 25 项）、`mock-verify-trash-ttl.mjs`（回收站自动清除专项 13 项）、`mock-verify-subtitle-capture.mjs`（字幕 + 截图专项 18 项）、`mock-verify-settings-global.mjs`（设置全局化专项 22 项）、`mock-verify-strip-wheel.mjs`（缩略图条滚轮前后浏览专项 17 项）、`mock-verify-hold-boost.mjs`（长按右方向键 2× 加速专项 18 项）、`mock-verify-settings-r10.mjs`（缓存目录显示 + 输入框收窄专项 10 项），**共 221 项**。发布会跑全量回归。
