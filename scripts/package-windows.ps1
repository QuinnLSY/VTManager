#requires -Version 5.1
<#
.SYNOPSIS
    VTManager Windows 一键打包脚本

.DESCRIPTION
    1) 检查 Node.js / Rust 运行环境
    2) 自动下载 Windows 版 ffmpeg.exe 到 bin/（已存在则跳过）
    3) npm install + tauri build，产出 NSIS(.exe) 与 MSI 安装包
    4) 把安装包与手册汇总到 release-windows/

.NOTES
    本文件以 UTF-8 BOM 保存，避免 Windows PowerShell 5.1 中文乱码。
    用法（在项目根目录执行）：
        Set-ExecutionPolicy -Scope Process Bypass
        .\scripts\package-windows.ps1
#>

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }

# ---------- 1. 环境检查 ----------
Write-Step "检查运行环境"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "    [X] 未找到 Node.js，请先安装 Node 18+：https://nodejs.org/" -ForegroundColor Red
  exit 1
}
$nodeVer = [version]((node --version) -replace '^v', '')
if ($nodeVer.Major -lt 18) {
  Write-Host "    [X] Node 版本过低（$($nodeVer)），需要 18 或更高" -ForegroundColor Red
  exit 1
}
Write-Ok "Node.js $($nodeVer)"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host "    [X] 未找到 Rust 工具链，请先安装：https://rustup.rs/（选 MSVC 工具链）" -ForegroundColor Red
  exit 1
}
Write-Ok "Rust: $(cargo --version)"

# MSVC 构建工具：Tauri Windows 构建必需（缺失时由链接器报错，这里仅软提示）
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vsWhere) {
  Write-Ok "已检测到 Visual Studio 安装器"
} else {
  Write-Warn "未检测到 Visual Studio 生成工具；若构建时报 link.exe 缺失，请安装 VS 2022 生成工具（C++ 桌面开发）"
}

# WebView2 运行时（应用运行需要，构建不需要）
$wv = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if ($wv) { Write-Ok "WebView2 运行时已安装" }
else { Write-Warn "未检测到 WebView2 运行时（Win10/11 一般自带；安装包也会通过引导程序自动安装）" }

# ---------- 2. Windows 版 ffmpeg ----------
Write-Step "准备 Windows 版 ffmpeg"
New-Item -ItemType Directory -Force -Path "bin" | Out-Null
if (Test-Path "bin\ffmpeg.exe") {
  Write-Ok "bin\ffmpeg.exe 已存在，跳过下载"
} else {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ffUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  $zip = Join-Path $env:TEMP "ffmpeg-win64.zip"
  $dir = Join-Path $env:TEMP "ffmpeg-win64"
  try {
    Write-Host "    下载中（约 100MB，请稍候）..." -ForegroundColor Gray
    Invoke-WebRequest -Uri $ffUrl -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $dir -Force
    $exe = Get-ChildItem -Path $dir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (-not $exe) { throw "压缩包中未找到 ffmpeg.exe" }
    Copy-Item $exe.FullName -Destination "bin\ffmpeg.exe" -Force
    Write-Ok "已放置 bin\ffmpeg.exe"
  } catch {
    Write-Host "    [X] ffmpeg 下载失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "        可手动下载 Windows 全静态 ffmpeg.exe 放入 bin\ 后重跑本脚本" -ForegroundColor Yellow
    Write-Host "        推荐地址：https://github.com/BtbN/FFmpeg-Builds/releases" -ForegroundColor Yellow
    exit 1
  } finally {
    Remove-Item $zip -ErrorAction SilentlyContinue
    Remove-Item $dir -Recurse -ErrorAction SilentlyContinue
  }
}

# ---------- 3. 构建 ----------
Write-Step "安装前端依赖"
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "    [X] npm install 失败" -ForegroundColor Red; exit 1 }
Write-Ok "依赖就绪"

Write-Step "构建 Windows 安装包（NSIS + MSI）"
npx tauri build
if ($LASTEXITCODE -ne 0) { Write-Host "    [X] tauri build 失败" -ForegroundColor Red; exit 1 }

# ---------- 4. 汇总产物 ----------
Write-Step "汇总产物到 release-windows"
$out = Join-Path $Root "release-windows"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$bundle = Join-Path $Root "src-tauri\target\release\bundle"
$pkgs = @()
$pkgs += Get-ChildItem -Path (Join-Path $bundle "nsis") -Filter "*.exe" -ErrorAction SilentlyContinue
$pkgs += Get-ChildItem -Path (Join-Path $bundle "msi")  -Filter "*.msi" -ErrorAction SilentlyContinue

if ($pkgs.Count -eq 0) {
  Write-Host "    [X] 未找到安装包产物，请检查 src-tauri\target\release\bundle 目录" -ForegroundColor Red
  exit 1
}
foreach ($p in $pkgs) {
  Copy-Item $p.FullName -Destination $out -Force
  Write-Ok ("{0}  ({1:N1} MB)" -f $p.Name, ($p.Length / 1MB))
}

foreach ($f in @("操作手册.html", "app-icon.png", "使用须知.txt")) {
  if (Test-Path (Join-Path $Root $f)) { Copy-Item (Join-Path $Root $f) -Destination $out -Force }
}

Write-Host "`n==> 完成：release-windows" -ForegroundColor Cyan
Get-ChildItem $out | Select-Object Name, @{N = "大小(MB)"; E = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
