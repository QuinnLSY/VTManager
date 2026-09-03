# VTManager — Windows 版打包说明

> 版本 v1.0.2 · 最后更新 2026-09-01

## 一、为什么这个文件夹里没有安装包？

**Windows 安装包无法在 macOS 上直接产出**，这是 Tauri 的硬性技术限制，不是步骤遗漏：

| 构建 Windows 包必需的组件 | 性质 |
|---|---|
| MSVC 编译器 + Windows SDK（编译 Rust/链接 exe） | Windows 专有 |
| WebView2 绑定（应用渲染内核） | 需 Windows SDK 头文件 |
| **WiX Toolset**（生成 `.msi`） | **Windows 专有工具，macOS 无法运行** |
| **NSIS**（生成 `.exe` 安装器） | **Windows 专有工具，macOS 无法运行** |

Tauri 官方文档明确说明：**不支持交叉编译打包，需在目标平台上构建**。
当前开发环境为 macOS（且未安装 mingw-w64 交叉工具链），因此这里只能提供**完整可执行的打包体系**——在 Windows 环境运行即可产出安装包。

---

## 二、方式 A：GitHub Actions 云端构建（推荐，零本地环境）

项目已内置工作流 `.github/workflows/build-windows.yml`，用 GitHub 的 Windows 服务器自动构建，**免费且无需准备任何环境**。

1. 把代码推送到 GitHub 仓库（私有仓库也可以，Actions 免费额度足够）
2. 触发构建（二选一）：
   - 打标签：`git tag v1.0.2 && git push --tags`
   - 或手动：仓库页面 → **Actions** → 选 `Build Windows` → **Run workflow**
3. 等待约 5–10 分钟（首次构建需编译全部 Rust 依赖，较慢）
4. 在 Actions 运行详情页底部 **Artifacts** 区下载 `VTManager-Windows`，解压即得：
   - `VTManager_1.0.2_x64-setup.exe`（NSIS 安装器，双击安装）
   - `VTManager_1.0.2_x64_zh-CN.msi`（MSI 包，适合企业批量部署）

> 云端构建会自动下载 Windows 版 `ffmpeg.exe` 并放入 `bin/`，无需手动处理。

---

## 三、方式 B：在 Windows 电脑上本地构建

### 3.1 环境准备（只需做一次）

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | https://nodejs.org/ |
| Rust | stable，**安装时选 MSVC 工具链** | https://rustup.rs/ |
| Visual Studio 2022 生成工具 | 勾选「**C++ 桌面开发**」 | 提供 `link.exe` 与 Windows SDK |
| WebView2 运行时 | Win10/11 通常自带 | 缺失时安装包会自动引导安装 |
| ffmpeg.exe | Windows 全静态版 | **脚本会自动下载**，也可手动放 `bin/` |

### 3.2 执行打包

在项目根目录打开 **PowerShell**：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\package-windows.ps1
```

脚本会自动完成：环境检查 → 下载 `ffmpeg.exe` → `npm install` → `tauri build` → 把安装包汇总到 `release-windows/`。

手动执行也可以（等价于脚本第 3 步之后）：

```powershell
npm install
npx tauri build
```

### 3.3 产物位置

```
src-tauri\target\release\bundle\
├── nsis\VTManager_1.0.2_x64-setup.exe     # NSIS 安装器（推荐分发）
└── msi\VTManager_1.0.2_x64_zh-CN.msi      # MSI 包
```

脚本会自动把它们复制到 `release-windows/`，并附带 `操作手册.html`、`app-icon.png`、`使用须知.txt`。

---

## 四、给使用者的运行要求

- **系统**：Windows 10 1809 及以上 / Windows 11（依赖 WebView2）
- **WebView2**：Win10/11 一般已自带；若缺失，NSIS 安装器会联网引导安装
- **资料库**：应用本体不含任何媒体数据。首次启动后在应用里「打开资料库」，指向存放影视/图片的目录；索引、封面、缓存都写入该目录下的 `.VTManager/` 子目录，**不写入系统盘**
- **卸载**：控制面板卸载即可，资料库目录与 `.VTManager/` 会保留（不会被删除）

## 五、常见问题

**Q：安装时 Windows SmartScreen 提示"未知发布者"？**
A：正常现象——安装包未做代码签名（需购买代码签名证书，约几百元/年）。
点击「更多信息」→「仍要运行」即可。若需分发给他人，建议购买签名证书消除提示。

**Q：杀毒软件报毒？**
A：Tauri 应用（WebView2 + Rust）偶被误报，加入白名单即可。签名后可大幅减少误报。

**Q：启动后白屏/无画面？**
A：99% 是 WebView2 运行时缺失，安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) 后重启应用。

**Q：视频缩略图不生成？**
A：确认 `bin\ffmpeg.exe` 存在（脚本会自动下载）。macOS 版 `bin/ffmpeg` 在 Windows 上不可用——Windows 需要 `.exe`。

**Q：能只发 exe 不打包安装包吗？**
A：可以。`src-tauri\target\release\VTManager.exe` 是绿色单文件（需与同目录资源一起分发），但不建议——没有开始菜单项、卸载入口与文件关联。

---

## 六、配置说明（已就绪，无需修改）

`src-tauri/tauri.conf.json` 中 Windows 相关配置已配置好：

```json
"bundle": {
  "targets": ["app", "nsis", "msi"],
  "icon": ["icons/icon.icns", "icons/icon.ico"],
  "windows": {
    "webviewInstallMode": { "type": "downloadBootstrapper" },
    "nsis": { "languages": ["SimpChinese"], "installMode": "currentUser" },
    "wix": { "language": "zh-CN" }
  }
}
```

- `targets`：macOS 上只会产出 `.app`（不兼容的 target 自动跳过），Windows 上产出 `.msi` + NSIS `.exe`
- `installMode: currentUser`：安装到当前用户，不需要管理员权限
- `downloadBootstrapper`：缺 WebView2 时安装器联网下载，避免离线安装失败
- 图标 `icons/icon.ico` 已存在（44KB，含多尺寸）
