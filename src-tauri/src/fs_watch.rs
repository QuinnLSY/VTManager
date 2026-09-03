//! 资料库文件系统变更监听：外部（访达等）增删改后自动通知前端刷新
use notify::{RecursiveMode, Watcher};
use std::sync::mpsc;
use std::time::Duration;
use tauri::Emitter;

/// 只启动一次（跨库切换场景：旧 watcher 事件仅触发刷新，无害）
static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn ensure_started(app: tauri::AppHandle, root: std::path::PathBuf) {
    use std::sync::atomic::Ordering;
    if STARTED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        == Ok(false)
    {
        start_watching(app, root);
    }
}

fn start_watching(app: tauri::AppHandle, root: std::path::PathBuf) {
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<Result<notify::Event, notify::Error>>();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(_) => return, // 平台不支持则静默降级（无自动刷新）
        };
        if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
            return;
        }
        // 保持 watcher 存活至线程结束
        std::mem::forget(watcher);

        let mut pending: Vec<String> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(700)) {
                Ok(Ok(ev)) => {
                    if pending.len() > 500 {
                        continue; // 事件风暴时直接丢弃超额事件，防 payload 膨胀
                    }
                    for p in ev.paths {
                        let s = p.to_string_lossy().to_string();
                        // 应用自身数据目录与系统垃圾目录不触发刷新
                        if s.contains(".VTManager")
                            || s.contains(".Trashes")
                            || s.contains("System Volume Information")
                            || s.contains("$RECYCLE.BIN")
                        {
                            continue;
                        }
                        pending.push(s);
                    }
                }
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() {
                        // 外部变更：作废目录列表缓存（1.0.2），前端刷新必然拿到最新数据
                        crate::cache::invalidate_dir_cache();
                        let _ = app.emit("fs-changed", serde_json::json!({ "paths": pending }));
                        pending.clear();
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}
