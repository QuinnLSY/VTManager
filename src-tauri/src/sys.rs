//! 平台相关操作：打开文件 / 定位文件 / 已安装应用 / 卷根检测
//! macOS 与 Windows 双平台解耦，同一份代码按 target_os 自适应。

use crate::types::InstalledApp;
use std::path::{Path, PathBuf};
use std::process::Command;

fn spawn_check(mut c: Command) -> Result<(), String> {
    c.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动失败: {}", e))
}

/// 用系统默认应用打开文件
pub fn open_default(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return spawn_check({
            let mut c = Command::new("open");
            c.arg(path);
            c
        });
    }
    #[cfg(target_os = "windows")]
    {
        return spawn_check({
            let mut c = Command::new("cmd");
            c.args(["/C", "start", ""]).arg(path);
            c
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return spawn_check({
            let mut c = Command::new("xdg-open");
            c.arg(path);
            c
        });
    }
}

/// 用指定应用打开文件（app 可为 macOS 的 .app 路径/名称，或 Windows 的 exe/lnk 路径）
pub fn open_with_app(path: &str, app: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return spawn_check({
            let mut c = Command::new("open");
            c.args(["-a", app]).arg(path);
            c
        });
    }
    #[cfg(target_os = "windows")]
    {
        let lower = app.to_lowercase();
        if lower.ends_with(".lnk") {
            // 从开始菜单快捷方式解析真实 exe，再以文件为参数启动
            let script = format!(
                "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}').TargetPath; if($s){{ Start-Process -FilePath $s -ArgumentList '{}' }}",
                app.replace('\'', "''"),
                path.replace('\'', "''")
            );
            return spawn_check({
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-Command", &script]);
                c
            });
        }
        return spawn_check({
            let mut c = Command::new(app);
            c.arg(path);
            c
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return spawn_check({
            let mut c = Command::new(app);
            c.arg(path);
            c
        });
    }
}

/// 在文件管理器中显示（Finder / 资源管理器）
pub fn reveal(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return spawn_check({
            let mut c = Command::new("open");
            c.args(["-R", path]);
            c
        });
    }
    #[cfg(target_os = "windows")]
    {
        return spawn_check({
            let mut c = Command::new("explorer");
            c.arg(format!("/select,{}", path));
            c
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return spawn_check({
            let mut c = Command::new("xdg-open");
            c.arg(path.parent().unwrap_or(Path::new("/")));
            c
        });
    }
}

/// 应用所在卷/盘的根目录（用于自动检测硬盘资料库）
pub fn volume_root(exe: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut cur: &Path = exe;
        while let Some(parent) = cur.parent() {
            if parent == Path::new("/Volumes") {
                return cur.file_name().map(|v| parent.join(v));
            }
            cur = parent;
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        // exe = E:\VTManager\VTManager.exe → 根为 E:\
        exe.ancestors().last().map(|p| p.to_path_buf())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

pub fn list_installed_apps() -> Vec<InstalledApp> {
    #[cfg(target_os = "macos")]
    {
        return list_apps_macos();
    }
    #[cfg(target_os = "windows")]
    {
        return list_apps_windows();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn list_apps_macos() -> Vec<InstalledApp> {
    const DIRS: &[&str] = &[
        "/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
        "/Applications/Utilities",
    ];
    let mut out: Vec<InstalledApp> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(home) = std::env::var_os("HOME") {
        scan_apps_dir(&PathBuf::from(home).join("Applications"), &mut out, &mut seen, ".app");
    }
    for d in DIRS {
        scan_apps_dir(Path::new(d), &mut out, &mut seen, ".app");
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(target_os = "macos")]
fn scan_apps_dir(
    dir: &Path,
    out: &mut Vec<InstalledApp>,
    seen: &mut std::collections::HashSet<String>,
    suffix: &str,
) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(suffix) {
            continue;
        }
        let path = e.path().to_string_lossy().to_string();
        if !seen.insert(path.clone()) {
            continue;
        }
        out.push(InstalledApp {
            name: name[..name.len() - suffix.len()].to_string(),
            path,
        });
    }
}

#[cfg(target_os = "windows")]
fn list_apps_windows() -> Vec<InstalledApp> {
    let mut out: Vec<InstalledApp> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let roots: Vec<PathBuf> = [
        std::env::var("ProgramData").ok(),
        std::env::var("APPDATA").ok(),
    ]
    .into_iter()
    .flatten()
    .map(|base| PathBuf::from(base).join("Microsoft/Windows/Start Menu/Programs"))
    .collect();
    for root in roots {
        scan_start_menu(&root, &mut out, &mut seen, 0);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(target_os = "windows")]
fn scan_start_menu(
    dir: &Path,
    out: &mut Vec<InstalledApp>,
    seen: &mut std::collections::HashSet<String>,
    depth: usize,
) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if path.is_dir() {
            scan_start_menu(&path, out, seen, depth + 1);
        } else if name.to_lowercase().ends_with(".lnk") && !name.starts_with("Uninstall") {
            let p = path.to_string_lossy().to_string();
            if !seen.insert(p.clone()) {
                continue;
            }
            out.push(InstalledApp {
                name: name.trim_end_matches(".lnk").to_string(),
                path: p,
            });
        }
    }
}
