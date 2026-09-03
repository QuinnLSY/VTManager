# 贡献指南

感谢你愿意为 VTManager 出一份力！🎉

无论你是想反馈 Bug、提出新功能、改进文档，还是直接提交代码，都非常欢迎。
本文档说明参与贡献的方式与项目约定，请先花几分钟阅读。

---

## 一、参与方式

| 方式 | 适合场景 |
|---|---|
| **提交 Issue** | 报告 Bug、提出功能建议、反馈使用体验 |
| **改进文档** | 修正错别字、补充说明、翻译 |
| **提交 Pull Request** | 修复 Bug、实现新功能、性能优化 |

> 提交 Issue 前请先搜索[已有 Issue](https://github.com/QuinnLSY/VTManager/issues)，避免重复。

---

## 二、开发环境搭建

### 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 含 npm |
| Rust | stable | 通过 [rustup](https://rustup.rs/) 安装 |
| Xcode Command Line Tools | macOS | `xcode-select --install` |
| MSVC + WebView2 | Windows | Win10/11 自带 WebView2 |
| ffmpeg | 近期版本 | 需自备，见下 |

SQLite 使用 rusqlite 静态编译、HTTP 使用 reqwest + rustls，**均无需系统额外安装依赖**。

### 准备 ffmpeg

二进制不随仓库分发（体积大且属第三方产物）：

```bash
# macOS
brew install ffmpeg && cp $(which ffmpeg) bin/ffmpeg

# Windows：下载静态 ffmpeg.exe 放入 bin/ 目录
```

详见 [`bin/README.md`](bin/README.md)。

### 启动开发

```bash
git clone https://github.com/QuinnLSY/VTManager.git
cd VTManager
npm install
npm run app:dev        # Tauri 窗口 + 前端热更新（推荐）
```

其他命令：

```bash
npm run dev            # 仅前端（无后端，需配合 VITE_MOCK=1）
VITE_MOCK=1 npm run dev   # mock 后端 + 浏览器联调（回归脚本依赖此模式）
npm run app:build      # 构建当前平台发布包
```

---

## 三、测试

### Rust 单测

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

> 部分单测（如 `cleanup_remux_deletes_cache_and_rebuilds`）需要真实 ffmpeg，请确认 `bin/ffmpeg` 已就位。
> 改写进程级全局状态（如 `cache.rs` 的 `TTL_SECS`）的测试必须共享互斥锁串行化，否则并发执行会互相污染。

### 前端端到端回归

```bash
VITE_MOCK=1 npm run dev &        # 先启动 mock dev server
node scripts/mock-verify.mjs     # 运行回归脚本
```

`scripts/mock-verify-*.mjs` 共 **15 个脚本、221 项断言**，覆盖浏览、播放、字幕、缓存、回收站、主题等。
**修改功能后请补充或更新对应专项脚本**，发布前须全绿。

### 发版前静态审计

```bash
python3 scripts/audit-command-consistency.py
```

校验 Tauri 命令三方一致性（Rust 定义 ↔ 注册 ↔ 前端调用）与重构易碎锚点。

---

## 四、代码约定

### 通用原则

> ⚠️ **已实现的功能不得擅自删除或弱化**。若重构改变了代码结构，必须在新结构下重新实现原有能力。
> 历史上曾发生「重构即丢功能」的问题，请务必自查并补充回归断言。

### Rust 侧

- 新增 Tauri 命令需**三处同步**：
  1. `src-tauri/src/commands.rs` 中定义并在 `generate_handler` 注册
  2. `src/api.ts` 中添加前端封装
  3. `src/mock/tauri.ts` 中补充 mock 分支
- 命令返回结构体的 serde 字段名必须与前端 TS 类型一致（camelCase）
- **任何写文件系统的命令成功后必须调用 `cache::invalidate_dir_cache()`**，否则目录列表 3 秒缓存会返回脏数据
- 新增以路径为主键的表，须同步 `db::rename_refs()` / `db::remove_refs()`
- 新增插件 / window API 必须同步 `src-tauri/capabilities/default.json` 权限，否则命令被静默拒绝
- 平台相关代码用 `#[cfg(target_os = ...)]` 门控，并保持非 macOS / Windows 的兜底分支（`sys.rs` 已实现）

### 前端侧

- 不引入重型 UI 框架，样式为手写 CSS（扁平化淡蓝主题，CSS 变量集中在 `src/styles.css`）
- 弹窗组件使用 `defineAsyncComponent` 做代码分割
- 缩略图 `<img>` 统一 `loading="lazy"` + `decoding="async"`
- **跨窗口生效的设置判断必须放在后端命令内**（PiP 独立窗口的 store 不共享，前端判断会失效）
- 容器上绑定 `dblclick` 时须做控件防误触处理（按钮补 `@dblclick.stop`，容器记录控件点击时间做二次拦截）
- TypeScript：严格模式，避免在 Vue 模板中使用类型断言与多条内联语句（曾导致渲染崩溃）

---

## 五、提交与 Pull Request

### 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
feat: 新增 xxx 功能
fix: 修复 xxx 问题
perf: 优化 xxx 性能
docs: 更新 xxx 文档
refactor: 重构 xxx
test: 补充 xxx 测试
chore: 构建 / 工具链调整
```

### PR 流程

1. Fork 仓库，基于 `main` 创建分支（`feat/xxx`、`fix/xxx`、`docs/xxx`）
2. 完成改动并自测：Rust 单测通过、前端构建通过、相关回归脚本全绿
3. 发起 PR，在描述中说明：
   - **改动动机**（解决什么问题）
   - **实现方式**（关键改动点）
   - **验证结果**（跑过哪些测试、手工验证步骤）
4. 保持 PR 聚焦单一主题，避免混入无关改动

---

## 六、行为准则

请保持友善、尊重与耐心。任何形式的骚扰、人身攻击或歧视性言论都不被容忍。

---

## 七、许可证

贡献即表示你同意你的代码以 [MIT License](LICENSE) 开源发布。
