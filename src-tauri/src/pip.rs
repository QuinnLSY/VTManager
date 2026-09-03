// 独立画中画（PiP）窗口：播放器/图片查看器脱离主窗口运行。
// 全屏按钮触发：主窗口创建独立 WebviewWindow → 该窗口加载专属 HTML/CSS/JS → 视频/图片以独立 OS 窗口显示。
// 用户关闭窗口（顶部X）或按 Esc 时，Rust 端监听 Destroyed 事件 emit "pip-closed" 给主窗口 → 主窗口恢复。
//
// 主窗口语义（v1.0.1-r12）：进入全屏时主窗口的播放器/查看器**不销毁**，只隐藏 + 暂停；
// 退出全屏时立刻显示并从精确时间点续播/续看（零重新加载、零重新缓冲）。
// 独立窗口通过 set_pip_state 回写当前 index/进度/旋转/缩放，主窗口关闭时 take_pip_state 取回。
//
// 1.0.2-r4 修复：回传状态改为"窗口销毁后延迟删除"（见 purge_pip_state_later）。
// 旧代码在 Destroyed 里同步删除，主窗口永远取不到状态 → 退出全屏后播/看的是
// 进入全屏之前的那一个条目，而非在全屏里切换后的那个。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum PipKind {
    Video,
    Image,
}

/// 单条媒体数据（含与目录列表里一致的最小字段集；附加 thumb 用于缩略图条）。
/// 这里只放打开 PiP 必需的字段，避免序列化整个库的全量数据。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PipMedia {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub cover: Option<String>,
}

/// 打开参数：媒体队列（与原播放/查看器逻辑一致）+ 当前索引 + 库根 + 封面目录
/// + 主窗口查看器的初始画面变换（旋转/缩放/平移，图片专用；视频恒为默认值）。
/// 全屏窗口一打开即沿用主窗口当前的旋转状态，做到全屏/非全屏同步共用。
#[derive(Debug, Serialize, Deserialize)]
pub struct PipOpenArgs {
    pub kind: PipKind,
    pub list: Vec<PipMedia>,
    pub index: usize,
    pub root: String,
    pub covers_dir: String,
    #[serde(default)]
    pub init_rot: i32,
    #[serde(default)]
    pub init_scale: f64,
    #[serde(default)]
    pub init_tx: f64,
    #[serde(default)]
    pub init_ty: f64,
    /// 主窗口进入全屏时的字幕快照（视频专用，1.0.2-r7）
    #[serde(default)]
    pub subtitle: Option<crate::types::PipSubtitleSnapshot>,
}

/// 给独立窗口传递的初始数据 key（主窗口通过 URL query 注入）。
/// 我们不通过 URL 暴露完整媒体列表 —— URL 过长不安全；
/// 改用启动 URL query 仅放会话 ID，独立窗口首次 setup 时从 Rust 拉取真实数据。
pub fn label_for(kind: &PipKind, session_id: &str) -> String {
    let prefix = match kind {
        PipKind::Video => "pip-video",
        PipKind::Image => "pip-image",
    };
    // session_id 仅允许 [a-zA-Z0-9_-]，确保 label 合法
    format!("{}-{}", prefix, session_id)
}

/// 主窗口调用：创建独立 PiP 窗口。
/// 窗口先 show() 上屏，再切全屏 —— macOS 下 `NSWindow.screen()` 在窗口尚未上屏时返回 nil，
/// tao 的 set_fullscreen 会因此静默失败（表现为"全屏"窗口停在带标题栏的普通态 → 观感黑屏）。
#[tauri::command]
pub fn open_pip_window(app: AppHandle, args: PipOpenArgs) -> CmdResult<String> {
    let session_id = format!(
        "{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        rand_suffix(),
    );
    let label = label_for(&args.kind, &session_id);

    // 数据存入 AppHandle 的 state，由独立窗口拉取（get_pip_payload）。
    // PipStore 已在 run() 中 manage，这里总能拿到。
    let payload = PipPayload {
        kind: args.kind.clone(),
        list: args.list.clone(),
        index: args.index,
        root: args.root.clone(),
        covers_dir: args.covers_dir.clone(),
        init_rot: args.init_rot,
        init_scale: args.init_scale,
        init_tx: args.init_tx,
        init_ty: args.init_ty,
        subtitle: args.subtitle.clone(),
    };
    let state = app
        .try_state::<PipStore>()
        .ok_or_else(|| "PiP 存储未初始化".to_string())?;
    state
        .0
        .lock()
        .map_err(|e| format!("PiP 存储加锁失败: {}", e))?
        .insert(label.clone(), payload);
    sweep_pip_state(&app); // 开新窗口时顺带清掉历次会话遗留的回传状态

    // 构造 URL：使用前端 /pip.html 路由（dist 目录下生成）
    // 开发模式：Vite 多入口（pip.html）；生产模式：build 后 dist/pip.html
    // 同一 dev server 不同 entry 直接走 query 区分路由
    let url_path = format!("pip.html?label={}", urlencoding(&label));

    let title = match args.kind {
        PipKind::Video => "VTManager — 视频播放",
        PipKind::Image => "VTManager — 图片查看",
    };

    // 注意：这里**不能**用 .fullscreen(true)。tao 在窗口创建期（尚未 orderFront）调用
    // set_fullscreen 时 `NSWindow.screen()` 为 nil → 直接 return → 全屏静默失效。
    // 改为 build → show() → 延迟轮询直到确认进入全屏（见 schedule_fullscreen）。
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url_path.into()))
        .title(title)
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 420.0)
        .visible(false);

    let window = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            // 创建失败：删除已插入的 payload，避免泄漏
            if let Some(state) = app.try_state::<PipStore>() {
                if let Ok(mut map) = state.0.lock() {
                    map.remove(&label);
                }
            }
            return Err(format!("创建独立窗口失败: {}", e));
        }
    };

    // 监听窗口销毁事件：用户在独立窗口点 X / 系统关闭 → emit "pip-closed" 给主窗口
    let label_for_event = label.clone();
    let app_for_event = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let _ = app_for_event.emit_to("main", "pip-closed", &label_for_event);
            // 清理 payload 与回传状态，避免反复开闭泄漏
            if let Some(state) = app_for_event.try_state::<PipStore>() {
                if let Ok(mut map) = state.0.lock() {
                    map.remove(&label_for_event);
                }
            }
            // 回传状态**不能**在这里同步删除（原因见 purge_pip_state_later）：
            // 主窗口此刻还没来得及 take，删了就拿不到"在全屏里切换后的 index"了。
            purge_pip_state_later(app_for_event.clone(), label_for_event.clone());
        }
    });

    // 先上屏再全屏：顺序不可颠倒
    let _ = window.show();
    schedule_fullscreen(&app, &window);

    Ok(label)
}

/// 让窗口进入全屏：窗口 show() 后延迟轮询 `is_fullscreen()`，最多 2 秒内重试。
/// 这样即使 macOS 全屏动画被占用或窗口尚未 attach 到 NSWindow，也能最终进入全屏。
fn schedule_fullscreen(app: &AppHandle, window: &WebviewWindow) {
    let w = window.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        // 首次稍微等一下，让窗口完成上屏/attach
        std::thread::sleep(Duration::from_millis(80));
        for _ in 0..20 {
            let ok = Arc::new(AtomicBool::new(false));
            let ok2 = ok.clone();
            let _ = app2.run_on_main_thread({
                let w = w.clone();
                move || {
                    let _ = w.set_fullscreen(true);
                    ok2.store(w.is_fullscreen().unwrap_or(false), Ordering::Relaxed);
                }
            });
            if ok.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

/// 独立窗口 setup 时调用：拉取启动数据（一次性消费）。
#[tauri::command]
pub fn get_pip_payload(app: AppHandle, label: String) -> CmdResult<PipPayload> {
    let state = app
        .try_state::<PipStore>()
        .ok_or_else(|| "PiP 数据不存在".to_string())?;
    let map = state
        .0
        .lock()
        .map_err(|e| format!("PiP 存储加锁失败: {}", e))?;
    map.get(&label)
        .cloned()
        .ok_or_else(|| "PiP 数据已过期".to_string())
}

/// 关闭 PiP 窗口：emit "pip-closed" 给主窗口 → 主窗口恢复播放器/查看器；
/// 然后通过窗口 close() 触发 Destroyed 事件 → 再清理 payload。
#[tauri::command]
pub fn close_pip_window(app: AppHandle, label: String) -> CmdResult<()> {
    let _ = app.emit_to("main", "pip-closed", &label);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    // payload 清理已挂在 Destroyed 事件里；这里不重复清理（避免 race）
    Ok(())
}

/// 独立窗口回写当前状态（当前索引 / 播放进度 / 图片旋转缩放平移）。
/// 由 PiP 端在切换、暂停、退出前调用；主窗口关闭时用 take_pip_state 一次性取回。
#[tauri::command]
pub fn set_pip_state(app: AppHandle, label: String, state: PipState) -> CmdResult<()> {
    {
        let store = app
            .try_state::<PipStateStore>()
            .ok_or_else(|| "PiP 状态存储未初始化".to_string())?;
        store
            .0
            .lock()
            .map_err(|e| format!("PiP 状态加锁失败: {}", e))?
            .insert(label, (std::time::Instant::now(), state));
    }
    sweep_pip_state(&app);
    Ok(())
}

/// 兜底清理：主窗口可能永远不来取（例如应用直接退出），
/// 超过 TTL 的回传状态直接丢掉，避免长期驻留内存。
fn sweep_pip_state(app: &AppHandle) {
    if let Some(store) = app.try_state::<PipStateStore>() {
        if let Ok(mut map) = store.0.lock() {
            map.retain(|_, (at, _)| at.elapsed() < PIP_STATE_TTL);
        }
    }
}

/// 窗口销毁后延迟删除回传状态（1.0.2-r4 关键修复）。
///
/// 旧实现在 `Destroyed` 事件里 emit "pip-closed" 之后**立刻**删除状态，而主窗口要
/// 收到事件 → 发一次 IPC → 才执行 take_pip_state，这条路径必然慢于 Rust 侧的同步
/// 删除，于是永远拿到 null → 主窗口退回"进入全屏前的 index"：
/// 表现为「在全屏里切了上下一个，退出全屏却播回原来那个视频/图片」。
///
/// 改成延迟删除：给主窗口留出充足的取回时间窗；主窗口取走后条目已不存在，
/// 延迟删除自然是空操作。
fn purge_pip_state_later(app: AppHandle, label: String) {
    std::thread::spawn(move || {
        std::thread::sleep(PIP_STATE_GRACE);
        if let Some(store) = app.try_state::<PipStateStore>() {
            if let Ok(mut map) = store.0.lock() {
                // 只删"自窗口销毁后再没被刷新过"的条目：
                // 万一同名 label 被复用（极端时序下的新窗口），不会误删新状态
                if let Some((at, _)) = map.get(&label) {
                    if at.elapsed() >= PIP_STATE_GRACE {
                        map.remove(&label);
                    }
                }
            }
        }
    });
}

/// 主窗口调用：取回并清除独立窗口的最终状态（若窗口从未回写过则为 null）。
#[tauri::command]
pub fn take_pip_state(app: AppHandle, label: String) -> CmdResult<Option<PipState>> {
    let store = app
        .try_state::<PipStateStore>()
        .ok_or_else(|| "PiP 状态存储未初始化".to_string())?;
    let taken = store
        .0
        .lock()
        .map_err(|e| format!("PiP 状态加锁失败: {}", e))?
        .remove(&label);
    Ok(taken.map(|(_, st)| st))
}

/// 主窗口订阅「独立窗口关闭」事件 → 同步自身 UI 状态。
pub fn install_pip_close_listener(app: &AppHandle) {
    // 占位：保留供未来在 Rust 端桥接更复杂的事件流
    // 实际监听放在前端 store.watchFullscreen() 周边 —— 见 App.vue / store.ts
    let _ = app;
}

type CmdResult<T> = Result<T, String>;

#[derive(Default)]
pub struct PipStore(pub Mutex<HashMap<String, PipPayload>>);

/// 独立窗口 → 主窗口的回传状态表（按窗口 label 索引，带写入时刻用于兜底清理）
#[derive(Default)]
pub struct PipStateStore(pub Mutex<HashMap<String, (std::time::Instant, PipState)>>);

/// 回传状态的最短取回窗口：窗口销毁后至少保留这么久，确保主窗口来得及 take
const PIP_STATE_GRACE: Duration = Duration::from_secs(15);
/// 回传状态的最长驻留时间：超过即视为无人取回，兜底清理
const PIP_STATE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PipPayload {
    pub kind: PipKind,
    pub list: Vec<PipMedia>,
    pub index: usize,
    pub root: String,
    pub covers_dir: String,
    /// 主窗口进入全屏时的画面变换快照（图片专用），PiP 窗口据此初始化，实现双向同步
    #[serde(default)]
    pub init_rot: i32,
    #[serde(default)]
    pub init_scale: f64,
    #[serde(default)]
    pub init_tx: f64,
    #[serde(default)]
    pub init_ty: f64,
    /// 主窗口进入全屏时的字幕快照（视频专用，1.0.2-r7）：PiP 窗口据此渲染同一字幕
    #[serde(default)]
    pub subtitle: Option<crate::types::PipSubtitleSnapshot>,
}

/// 独立窗口的即时状态快照：主窗口据此「记忆当前播放/查看节点」并自动续播/续看。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct PipState {
    pub index: usize,   // 当前播放/查看的队列下标
    pub time: f64,      // 视频当前播放位置（秒）；图片恒为 0
    pub rot: i32,       // 图片旋转角度（0/90/180/270）
    pub scale: f64,     // 图片缩放系数
    pub tx: f64,        // 图片平移 X
    pub ty: f64,        // 图片平移 Y
}

/// 8 位字母数字随机串，多窗口并发打开时区分
fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(8);
    let mut x = n.wrapping_mul(0x9E3779B97F4A7C15) ^ 0xDEADBEEF;
    for _ in 0..8 {
        out.push(CHARS[(x as usize) % CHARS.len()] as char);
        x = x.wrapping_mul(0x100000001B3) ^ (x >> 13);
    }
    out
}

/// 简易 URL 编码（label 只含 [a-zA-Z0-9_-]，这里仅做防御性编码）
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}
