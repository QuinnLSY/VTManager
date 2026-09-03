use crate::pip::{PipStateStore, PipStore};
use crate::state::{cache_dir, covers_dir, AppState};
use crate::types::*;
use crate::{fsops, media, scan, sys, tmdb, util};
use rusqlite::params;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

type CmdResult<T> = Result<T, String>;

// ---------- 库管理 ----------

fn data_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("library.json"))
}

fn save_last_library(app: &AppHandle, root: &str) {
    if let Some(f) = data_file(app) {
        if let Some(parent) = f.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(f, root);
    }
}

// ---------- 全局偏好（与资料库无关） ----------
//
// prefs.json（应用数据目录）承载**全部应用设置**：主题（最早迁移）+ 1.0.2-r8 起
// 回收站清除天数 / 缓存保留时长 / 外部应用 / 点击行为 / TMDB Key 等。
// 此前这些存在 `<库>/.VTManager/vtmanager.db` 的 settings 表里，open_library
// 切换资料库会换成另一个数据库文件 → 设置被重置（如回收站天数跳回默认 3 天）。
// 现在统一走 prefs.json，切库、换目录都不受影响；库级 settings 表只作一次性迁移来源。

fn prefs_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("prefs.json"))
}

fn read_prefs(app: &AppHandle) -> HashMap<String, String> {
    prefs_file(app)
        .map(|p| crate::state::read_prefs_file(&p))
        .unwrap_or_default()
}

fn write_prefs(app: &AppHandle, m: &HashMap<String, String>) {
    if let Some(p) = prefs_file(app) {
        crate::state::write_prefs_file(&p, m);
    }
}

#[tauri::command]
pub fn get_pref(app: AppHandle, key: String) -> Option<String> {
    read_prefs(&app).get(&key).cloned()
}

#[tauri::command]
pub fn set_pref(app: AppHandle, key: String, value: String) {
    let mut m = read_prefs(&app);
    m.insert(key, value);
    write_prefs(&app, &m);
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        ffmpeg_ok: media::tool_path("ffmpeg").is_ok(),
        home: std::env::var("HOME").unwrap_or_default(),
    }
}

#[tauri::command]
pub fn detect_library(app: AppHandle, state: tauri::State<'_, AppState>) -> LibraryCandidate {
    let mut last = None;
    if let Ok(root) = state.ensure_open() {
        last = Some(root.to_string_lossy().to_string());
    } else if let Some(f) = data_file(&app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            let s = s.trim().to_string();
            if !s.is_empty()
                && Path::new(&s).is_dir()
                && Path::new(&s).join(".VTManager").is_dir()
            {
                last = Some(s);
            }
        }
    }
    let mut candidate = None;
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = sys::volume_root(&exe) {
            if root.join(".VTManager").is_dir() {
                candidate = Some(root.to_string_lossy().to_string());
            }
        }
    }
    LibraryCandidate { last, candidate }
}

#[derive(serde::Serialize)]
pub struct LibraryPaths {
    pub root: String,
    pub covers_dir: String,
    pub vtm_dir: String,
}

#[tauri::command]
pub fn get_paths(state: tauri::State<'_, AppState>) -> CmdResult<LibraryPaths> {
    let root = state.ensure_open()?;
    Ok(LibraryPaths {
        root: root.to_string_lossy().to_string(),
        covers_dir: covers_dir(&root).to_string_lossy().to_string(),
        vtm_dir: crate::state::vtm_dir(&root).to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn open_library(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    root: String,
) -> CmdResult<String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("目录不存在: {}", root));
    }
    state.open_library(&p)?;
    crate::cache::invalidate_dir_cache(); // 换库后旧目录缓存全部作废
    // 1.0.2-r4：同步「缓存保留时长」设置，并在开库时清掉上次使用留下的过期缓存
    //（用户可能隔了几天才再打开应用，此时旧缓存已经完全无用）
    crate::cache::set_cache_ttl_hours(cache_ttl_hours(&state));
    let _ = crate::cache::sweep_expired_cache(&p);
    // 1.0.2-r6：开库时清掉回收站里已过自动清除期限的条目
    //（应用可能已经好几天没打开，期间「到期」早就发生了）
    let _ = crate::fsops::sweep_expired_trash(&state);
    crate::cache::invalidate_usage_cache();
    save_last_library(&app, &root);
    crate::fs_watch::ensure_started(app, p.clone());
    if let Err(e) = crate::stream::ensure_started(&p) {
        eprintln!("[stream] 流服务启动失败: {}", e);
    }
    Ok(root)
}

// ---------- 大文件视频流播放 ----------

/// 本地流服务基址（含会话令牌）：http://127.0.0.1:{port}/{token}/
#[tauri::command]
pub fn stream_base() -> CmdResult<String> {
    crate::stream::stream_base().ok_or_else(|| "流服务未启动".into())
}

#[tauri::command]
pub fn moov_position(state: tauri::State<'_, AppState>, path: String) -> CmdResult<String> {
    let root = state.ensure_open()?;
    ensure_in_root(&root, &path)?;
    Ok(crate::stream::moov_position(&path).to_string())
}

#[tauri::command]
pub fn start_remux(state: tauri::State<'_, AppState>, path: String) -> CmdResult<crate::stream::RemuxJob> {
    let root = state.ensure_open()?;
    ensure_in_root(&root, &path)?;
    Ok(crate::stream::start_remux(&root, &path))
}

#[tauri::command]
pub fn remux_status(state: tauri::State<'_, AppState>, path: String) -> CmdResult<crate::stream::RemuxJob> {
    let root = state.ensure_open()?;
    ensure_in_root(&root, &path)?;
    Ok(crate::stream::remux_status(&root, &path))
}

/// 关闭播放时清理该视频的转封装缓存副本（1.0.2-r3「关闭即删」）：
/// MKV 等容器播放会在 cache/remux 生成与原视频等大的副本，此命令按
/// (path, mtime) hash 精确删除该副本与 tmp 残留；只动缓存，不触碰本地原文件。
/// 开关读全局设置 `cleanup_remux_on_close`（1.0.2-r8 起存 prefs.json，缺省开）；
/// 在**后端**判断，保证主窗口与 PiP 独立窗口（settings 未加载）行为一致。
#[tauri::command]
pub fn cleanup_remux(state: tauri::State<'_, AppState>, path: String) -> CmdResult<bool> {
    let root = state.ensure_open()?;
    ensure_in_root(&root, &path)?;
    if setting_value(&state, "cleanup_remux_on_close").as_deref() == Some("0") {
        return Ok(false);
    }
    Ok(crate::stream::cleanup_remux(&root, &path))
}

/// 进度条悬停帧预览（1.0.2-r5）：查询/触发精灵图生成。
/// 缓存命中立即 ready；未命中后台生成，前端轮询本接口直到 ready/failed。
/// duration 由前端 loadedmetadata 传入（秒），决定采样张数与间隔。
#[tauri::command]
pub fn scrub_sheet(
    state: tauri::State<'_, AppState>,
    path: String,
    duration: f64,
) -> CmdResult<crate::media::ScrubSheetStatus> {
    let root = state.ensure_open()?;
    ensure_in_root(&root, &path)?;
    let mtime_ms = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(crate::media::scrub_sheet(&root, &path, mtime_ms, duration))
}

/// 流播放相关命令的根目录校验：目标必须位于当前资料库内（canonicalize 防 `..`/链接绕过）
fn ensure_in_root(root: &Path, target: &str) -> CmdResult<()> {
    let (Ok(ct), Ok(cr)) = (std::fs::canonicalize(target), std::fs::canonicalize(root)) else {
        return Err("文件不存在".into());
    };
    if !ct.starts_with(&cr) {
        return Err("目标不在资料库内".into());
    }
    Ok(())
}

// ---------- 目录浏览 ----------

#[tauri::command]
pub fn list_dir(state: tauri::State<'_, AppState>, path: String) -> CmdResult<DirListing> {
    // 1.0.2：3 秒 TTL 目录列表缓存（返回上级/重复浏览秒开；写操作与外部变更会失效）
    if let Some(cached) = crate::cache::cached_listing(&path) {
        return Ok((*cached).clone());
    }
    let listing = fsops::list_dir(&state, &path)?;
    crate::cache::store_listing(path, listing.clone());
    Ok(listing)
}

#[tauri::command]
pub fn create_dir(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<String> {
    let r = fsops::create_dir(&state, &parent, &name);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

#[tauri::command]
pub fn rename_entry(
    state: tauri::State<'_, AppState>,
    path: String,
    new_name: String,
) -> CmdResult<String> {
    let r = fsops::rename_entry(&state, &path, &new_name);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

#[tauri::command]
pub fn move_entries(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    dest: String,
) -> CmdResult<()> {
    let r = fsops::move_entries(&state, paths, &dest);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

#[tauri::command]
pub fn copy_entries(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    dest: String,
) -> CmdResult<i32> {
    let r = fsops::copy_entries(&state, paths, &dest);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

#[tauri::command]
pub fn delete_entries(state: tauri::State<'_, AppState>, paths: Vec<String>) -> CmdResult<()> {
    let r = fsops::delete_entries(&state, paths);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

// ---------- 回收站 ----------

#[tauri::command]
pub fn list_trash(state: tauri::State<'_, AppState>) -> CmdResult<Vec<TrashItem>> {
    fsops::list_trash(&state)
}

#[tauri::command]
pub fn restore_trash(state: tauri::State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    let r = fsops::restore_trash(&state, ids);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

#[tauri::command]
pub fn delete_forever(state: tauri::State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    let r = fsops::delete_forever(&state, ids);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

#[tauri::command]
pub fn empty_trash(state: tauri::State<'_, AppState>) -> CmdResult<()> {
    let r = fsops::empty_trash(&state);
    if r.is_ok() {
        crate::cache::invalidate_dir_cache();
    }
    r
}

/// 1.0.2-r6：设置「回收站自动清除间隔天数」（0 = 永不自动清除）。
/// 写入后**立即把回收站内所有条目的到期时间按当前时间重置**。
#[tauri::command]
pub fn set_trash_ttl_days(state: tauri::State<'_, AppState>, days: i64) -> CmdResult<()> {
    fsops::set_trash_ttl_days(&state, days).map_err(|e| e.into())
}

/// 1.0.2-r6：立即清扫已到期的回收站条目，返回清除条数
#[tauri::command]
pub fn sweep_trash(state: tauri::State<'_, AppState>) -> CmdResult<usize> {
    fsops::sweep_expired_trash(&state).map_err(|e| e.into())
}

// ---------- 缩略图与封面 ----------

#[derive(serde::Deserialize)]
pub struct ThumbReq {
    pub path: String,
    pub is_dir: bool,
    pub is_video: bool,
}

#[derive(serde::Serialize)]
pub struct ThumbRes {
    pub path: String,
    pub thumb: Option<String>,
}

fn mtime_ms(p: &Path) -> i64 {
    p.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn get_thumbs(
    state: tauri::State<'_, AppState>,
    items: Vec<ThumbReq>,
) -> CmdResult<Vec<ThumbRes>> {
    let root = state.ensure_open()?;
    let cover_paths: Vec<String> = items
        .iter()
        .filter(|i| i.is_dir || i.is_video)
        .map(|i| i.path.clone())
        .collect();
    // 封面查表需要 DB，但缩略图生成不需要 —— 查完立即释放 DB 锁，
    // 避免并行生成期间阻塞其他数据库操作（1.0.1-r13）。
    let cm = {
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        fsops::cover_map(conn, &cover_paths)
    };
    let cdir = covers_dir(&root);
    // 1.0.1-r13：并行生成缩略图（图片解码为 CPU 密集、视频缩略图调 ffmpeg 进程，
    // 旧版串行生成大目录首屏等待时间长）。1.0.2：线程数按 CPU 核数自适应
    // （上限 8，避免小核数机器过度抢占；macOS arm64 常见 8~12 核）。
    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8);
    let out: Vec<ThumbRes> = std::thread::scope(|s| {
        let cm = &cm;
        let cdir = &cdir;
        let root = &root;
        let handles: Vec<_> = items
            .chunks(nthreads)
            .map(|chunk| {
                s.spawn(move || {
                    let mut local = Vec::with_capacity(chunk.len());
                    for it in chunk {
                        let p = PathBuf::from(&it.path);
                        let mut thumb: Option<String> = None;
                        if let Some(c) = cm.get(&it.path) {
                            thumb = Some(cdir.join(c).to_string_lossy().to_string());
                        } else if !it.is_dir {
                            let mt = mtime_ms(&p);
                            if it.is_video {
                                thumb = media::video_thumb(root, &it.path, mt)
                                    .ok()
                                    .map(|x| x.to_string_lossy().to_string());
                            } else {
                                thumb = media::image_thumb(root, &p, mt)
                                    .ok()
                                    .map(|x| x.to_string_lossy().to_string());
                            }
                        }
                        local.push(ThumbRes { path: it.path.clone(), thumb });
                    }
                    local
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    // 缓存自动上限采样检查（1.0.1-r13）
    crate::cache::maybe_trim_cache(&root);
    Ok(out)
}

/// 图片查看器预览图：大图（>2048px）返回降采样 JPEG 缓存路径，小图返回 None（用原图）。
/// 1.0.1-r13，用于降低大图查看时的内存占用。
#[tauri::command]
pub fn get_preview(
    state: tauri::State<'_, AppState>,
    path: String,
) -> CmdResult<Option<String>> {
    let root = state.ensure_open()?;
    let p = PathBuf::from(&path);
    let mt = mtime_ms(&p);
    Ok(media::preview_image(&root, &p, mt)?
        .map(|x| x.to_string_lossy().to_string()))
}

/// 设置面板「存储空间」：应用在资料库中的数据/缓存占用明细（含应用本体大小）
#[tauri::command]
pub fn disk_usage(state: tauri::State<'_, AppState>) -> CmdResult<crate::cache::DiskUsage> {
    let root = state.ensure_open()?;
    // 打开设置面板时顺带做一次过期清理（自限频 60s），让展示的占用数字是最新的
    crate::cache::maybe_sweep_expired_cache(&root);
    Ok(crate::cache::disk_usage(&root))
}

/// 一键清除可再生缓存（缩略图/预览/转封装），返回释放的字节数；不影响应用正常使用。
#[tauri::command]
pub fn clear_cache(state: tauri::State<'_, AppState>) -> CmdResult<u64> {
    let root = state.ensure_open()?;
    crate::cache::clear_cache(&root)
}

/// 数据库一键优化（1.0.2）：WAL checkpoint 截断 + PRAGMA optimize + VACUUM。
/// 长期增删/移动大量文件后压缩 vtmanager.db 体积、整理碎片、提升查询速度。
/// 返回释放的字节数（db 文件压缩前后差值）；扫描进行中会返回明确错误。
#[tauri::command]
pub fn optimize_db(state: tauri::State<'_, AppState>) -> CmdResult<u64> {
    let root = state.ensure_open()?;
    if state.scanning.load(Ordering::SeqCst) {
        return Err("索引扫描进行中，请扫描完成后再优化数据库".into());
    }
    let db_path = crate::state::vtm_dir(&root).join("vtmanager.db");
    let before = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    // VACUUM 不能在事务内执行；execute_batch 逐条提交，无碍。
    // wal_checkpoint(TRUNCATE) 把 WAL 内容并回主库并截断，随后 VACUUM 压缩主库。
    conn.execute_batch(
        "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize; VACUUM;",
    )
    .map_err(|e| {
        format!(
            "数据库优化失败（请确认当前没有正在进行的扫描/移动操作后重试）: {}",
            e
        )
    })?;
    crate::cache::invalidate_dir_cache();
    let after = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    Ok(before.saturating_sub(after))
}

/// 空闲预生成缩略图（1.0.2）：后台低优先级为当前目录缺失缓存的媒体条目生成缩略图，
/// 完成（或达到本批上限）后向前端发 `thumbs-prewarmed` 事件，前端补拉缩略图。
/// 仅处理当前目录的直接子项；生成期间每张之间让出 1ms，避免抢占前台交互。
#[tauri::command]
pub fn prewarm_thumbs(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    dir: String,
) -> CmdResult<()> {
    let root = state.ensure_open()?;
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err("目录不存在".into());
    }
    // 防止同一目录反复排队：单一生成队列，重复请求直接忽略
    use std::sync::Mutex;
    static PREWARM_LOCK: Mutex<Option<String>> = Mutex::new(None);
    {
        let mut g = PREWARM_LOCK.lock().unwrap_or_else(|x| x.into_inner());
        if let Some(active) = g.as_ref() {
            if active == &dir {
                return Ok(()); // 已在队列中
            }
        }
        *g = Some(dir.clone());
    }
    let root = root.clone();
    std::thread::spawn(move || {
        let mut done: u32 = 0;
        let mut total: u32 = 0;
        if let Ok(rd) = std::fs::read_dir(&p) {
            let mut jobs: Vec<(PathBuf, bool)> = Vec::new(); // (path, is_video)
            for e in rd.flatten() {
                let fp = e.path();
                let Some(name) = e.file_name().to_str().map(|s| s.to_string()) else {
                    continue;
                };
                if crate::util::is_hidden(&name, &fp) {
                    continue;
                }
                let Ok(md) = e.metadata() else { continue };
                if md.is_dir() {
                    continue;
                }
                let kind = crate::util::kind_of(&name, false);
                if kind == "video" || kind == "image" {
                    jobs.push((fp, kind == "video"));
                }
            }
            total = jobs.len() as u32;
            // 单批上限：最多预生成 400 张，避免首次进入超大目录时长时间占用磁盘 IO
            for (fp, is_video) in jobs.into_iter().take(400) {
                let mt = mtime_ms(&fp);
                let r = if is_video {
                    media::video_thumb(&root, &fp.to_string_lossy(), mt).map(|_| ())
                } else {
                    media::image_thumb(&root, &fp, mt).map(|_| ())
                };
                if r.is_ok() {
                    done += 1;
                }
                // 低优先级：每张之间短暂让出 CPU，且每 8 张检查一次扫描状态（扫描优先）
                let scanning = {
                    let st = app.state::<AppState>();
                    st.scanning.load(Ordering::SeqCst)
                };
                if scanning {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        let _ = app.emit(
            "thumbs-prewarmed",
            serde_json::json!({ "dir": dir, "done": done, "total": total }),
        );
        let mut g = PREWARM_LOCK.lock().unwrap_or_else(|x| x.into_inner());
        *g = None;
    });
    Ok(())
}

#[tauri::command]
pub fn capture_frame(
    state: tauri::State<'_, AppState>,
    video: String,
    time: f64,
) -> CmdResult<String> {
    let root = state.ensure_open()?;
    let dir = cache_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("缓存目录不可用: {}", e))?;
    let out = dir.join(format!("frame_{}.jpg", util::now_ms()));
    media::capture_frame(&video, time, &out)?;
    Ok(out.to_string_lossy().to_string())
}

// ---------- 播放器字幕与截图（1.0.2-r7） ----------

/// 扫描视频同目录的同名字幕文件（.srt/.vtt，含语言后缀），供播放器自动加载
#[tauri::command]
pub fn probe_subtitles(video: String) -> Vec<SubtitleFile> {
    fsops::probe_subtitles(&video)
}

/// 读取字幕文本（编码自动识别：UTF-8 / UTF-16 / GBK），返回 UTF-8 字符串
#[tauri::command]
pub fn read_subtitle(state: tauri::State<'_, AppState>, path: String) -> CmdResult<String> {
    let root = state.ensure_open()?;
    ensure_in_root(&root, &path)?;
    fsops::read_subtitle(&path)
}

/// 播放器截图：把视频当前帧保存为原分辨率 PNG，返回保存路径。
/// AVFoundation 优先，失败回退 ffmpeg。dest_dir 缺省为资料库根/captures/。
#[tauri::command]
pub fn capture_snapshot(
    state: tauri::State<'_, AppState>,
    video: String,
    time: f64,
    dest_dir: Option<String>,
) -> CmdResult<String> {
    let root = state.ensure_open()?;
    ensure_in_root(&root, &video)?;
    let dir = match dest_dir.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => {
            let pb = PathBuf::from(d);
            std::fs::create_dir_all(&pb).map_err(|e| format!("创建保存目录失败: {}", e))?;
            pb
        }
        _ => {
            let dir = Path::new(&root).join("captures");
            std::fs::create_dir_all(&dir).map_err(|e| format!("创建保存目录失败: {}", e))?;
            dir
        }
    };
    let stem = Path::new(&video)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("frame");
    let out = dir.join(format!("{}-{}.png", stem, util::now_ms()));
    // AVFoundation 主路径（原分辨率 PNG）→ 失败回退 ffmpeg PNG
    if let Err(_) = av_capture_png(&video, time, &out) {
        media::capture_frame_png(&video, time, &out)?;
    }
    Ok(out.to_string_lossy().to_string())
}

fn av_capture_png(video: &str, time: f64, out: &Path) -> Result<(), String> {
    crate::av::capture_frame_png(video, time, out)
}

/// 选择字幕文件（系统对话框，过滤 .srt/.vtt）；取消返回 None
#[tauri::command]
pub fn pick_subtitle_file(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .add_filter("字幕", &["srt", "vtt"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// 选择截图保存目录（系统对话框）；取消返回 None
#[tauri::command]
pub fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_cover(
    state: tauri::State<'_, AppState>,
    target: String,
    image_path: Option<String>,
    video_path: Option<String>,
    frame_time: Option<f64>,
    source: Option<String>,
) -> CmdResult<String> {
    let root = state.ensure_open()?;
    let p = PathBuf::from(&target);
    if !p.exists() {
        return Err("目标不存在".into());
    }
    let is_dir = p.is_dir();
    let cover_file = if let Some(ip) = &image_path {
        media::save_cover_image(&root, Path::new(ip), &target)?
    } else if let Some(vp) = &video_path {
        let dir = covers_dir(&root);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let name = format!(
            "{}.jpg",
            util::hash_hex(&[&target, &util::now_ms().to_string()])
        );
        media::capture_frame(vp, frame_time.unwrap_or(0.0), &dir.join(&name))?;
        name
    } else {
        return Err("未提供封面来源".into());
    };
    let src = source.unwrap_or_else(|| {
        if image_path.is_some() {
            "upload".to_string()
        } else {
            "frame".to_string()
        }
    });
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    conn.execute(
        "INSERT OR REPLACE INTO covers (path, kind, cover_file, source, frame_time, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            target,
            if is_dir { "dir" } else { "video" },
            cover_file,
            src,
            frame_time,
            util::now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    crate::cache::invalidate_dir_cache(); // 封面变化：目录列表里的 cover 字段已不同
    Ok(cover_file)
}

// async：ffprobe 在大文件上耗时明显；同步跑在 tokio worker 线程仍会阻塞该线程，
// 因此用 spawn_blocking 把 ffprobe 放到独立线程池，避免卡住 UI。
#[tauri::command]
pub async fn video_info(path: String) -> VideoInfo {
    tokio::task::spawn_blocking(move || media::ffprobe_info(&path))
        .await
        .unwrap_or_else(|_| VideoInfo {
            duration: None,
            width: None,
            height: None,
        })
}

#[tauri::command]
pub fn media_dates(state: tauri::State<'_, AppState>, dir_path: String) -> CmdResult<Vec<PhotoDate>> {
    let list = fsops::list_dir(&state, &dir_path)?;
    let mut out = Vec::new();
    for e in list
        .entries
        .iter()
        .filter(|e| e.kind == "image" || e.kind == "video")
    {
        let taken = if e.kind == "image" {
            media::exif_taken_ms(Path::new(&e.path))
        } else {
            None
        };
        out.push(PhotoDate {
            path: e.path.clone(),
            taken_ms: taken.or(Some(e.modified_ms)),
        });
    }
    Ok(out)
}

// ---------- 标签 ----------

const TAG_COLORS: &[&str] = &["red", "orange", "yellow", "green", "blue", "purple"];

#[tauri::command]
pub fn set_tag(
    state: tauri::State<'_, AppState>,
    path: String,
    color: Option<String>,
) -> CmdResult<()> {
    state.ensure_open()?;
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    match color {
        Some(c) if TAG_COLORS.contains(&c.as_str()) => {
            conn.execute(
                "INSERT OR REPLACE INTO tags (path, color) VALUES (?1, ?2)",
                params![path, c],
            )
            .map_err(|e| e.to_string())?;
        }
        _ => {
            conn.execute("DELETE FROM tags WHERE path = ?1", params![path])
                .map_err(|e| e.to_string())?;
        }
    }
    // 标记颜色也视为一次管理操作：刷新文件修改时间
    crate::util::touch_now(&path);
    crate::cache::invalidate_dir_cache(); // 标签变化：目录列表里的 tag 字段已不同
    Ok(())
}

/// 全库颜色标签浏览：返回被标记的「最高层」对象。
/// 文件夹被标记后其子项按继承视为同色，由文件夹本身代表，不再单独展开；
/// 只有不被其他同色标记文件夹包含的标记项（含单个文件）才出现在结果里。
#[tauri::command]
pub fn tag_roots(state: tauri::State<'_, AppState>, color: String) -> CmdResult<Vec<SearchResult>> {
    if !TAG_COLORS.contains(&color.as_str()) {
        return Err("无效的标签颜色".into());
    }
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let tagged: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT path FROM tags WHERE color = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![color], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let is_proper_ancestor = |a: &str, p: &str| -> bool {
        p.starts_with(&format!("{}/", a)) || p.starts_with(&format!("{}\\", a))
    };
    let mut out: Vec<SearchResult> = Vec::new();
    for p in &tagged {
        if tagged.iter().any(|a| a != p && is_proper_ancestor(a, p)) {
            continue;
        }
        let from_index = conn
            .query_row(
                "SELECT name, is_dir, kind, size, created_at FROM index_entries WHERE path = ?1",
                params![p],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)? != 0,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .ok();
        let (name, is_dir, kind, size, created) = match from_index {
            Some(v) => v,
            None => {
                // 不在索引：回退文件系统元数据；路径已失效（外部删除/移动残留）则清理该标记并跳过
                let path = PathBuf::from(p);
                let Ok(md) = path.metadata() else {
                    let _ = conn.execute("DELETE FROM tags WHERE path = ?1", params![p]);
                    continue;
                };
                let n = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                let d = md.is_dir();
                (
                    n.clone(),
                    d,
                    crate::util::kind_of(&n, d),
                    md.len() as i64,
                    ctime_of(&path),
                )
            }
        };
        let parent = Path::new(p)
            .parent()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(SearchResult {
            path: p.clone(),
            parent,
            name,
            is_dir,
            kind,
            size: size.max(0) as u64,
            created_ms: created,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

// ---------- 媒体详情 ----------

#[tauri::command]
pub async fn media_info(
    state: tauri::State<'_, AppState>,
    path: String,
    kind: String,
) -> CmdResult<MediaInfo> {
    state.ensure_open()?;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    let size = p.metadata().map(|m| m.len()).unwrap_or(0);
    if kind == "dir" {
        // 文件夹详情：占用（索引聚合）+ 条目数 + 时间
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        let dir_size: Option<i64> = conn
            .query_row(
                "SELECT size FROM dir_sizes WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .ok();
        let entry_count: i64 = std::fs::read_dir(&p)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| {
                        let n = e.file_name().to_string_lossy().to_string();
                        !crate::util::is_hidden(&n, &e.path())
                    })
                    .count() as i64
            })
            .unwrap_or(0);
        return Ok(MediaInfo {
            container: "文件夹".into(),
            duration: None,
            bitrate: None,
            size: 0,
            tracks: Vec::new(),
            width: None,
            height: None,
            taken_ms: None,
            camera: None,
            lens: None,
            iso: None,
            aperture: None,
            shutter: None,
            focal: None,
            gps: None,
            created_ms: ctime_of(&p),
            modified_ms: mtime_of(&p),
            dir_size,
            entry_count: Some(entry_count),
        });
    }
    if kind == "video" {
        let created_ms = p
            .metadata()
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let modified_ms = mtime_of(&p);
        // 1.0.2：优先 ffprobe 完整信息（帧率/声道/语言/编码器；当用户环境存在 ffprobe
        // 或旧版安装包时走此增强路径）；发布包默认不带 ffprobe，自动回退 AVFoundation 摘要。
        // ffprobe 在大文件上会阻塞 tokio worker，放到独立线程池执行
        let raw = tokio::task::spawn_blocking({
            let path = path.clone();
            move || media::ffprobe_raw(&path)
        })
        .await
        .map_err(|_| "读取视频信息失败")?;

        let Some(raw) = raw else {
            // ---- AVFoundation 回退路径（macOS 原生，无 ffprobe 依赖） ----
            let mut tracks = Vec::new();
            let mut width = None;
            let mut height = None;
            let mut duration = None;
            let mut bitrate = None;
            if let Some(av) = crate::av::probe(&path) {
                duration = av.duration;
                bitrate = av.bitrate;
                width = av.width;
                height = av.height;
                for t in av.tracks {
                    let (k, detail) = if t.kind == "video" {
                        (
                            "video".to_string(),
                            match (width, height) {
                                (Some(w), Some(h)) => format!("{}×{} · {}", w, h, t.codec),
                                _ => t.codec.clone(),
                            },
                        )
                    } else if t.kind == "audio" {
                        ("audio".to_string(), t.codec.clone())
                    } else {
                        ("subtitle".to_string(), t.codec.clone())
                    };
                    tracks.push(MediaTrack { kind: k, codec: t.codec, detail });
                }
            }
            return Ok(MediaInfo {
                container: crate::util::ext_of(&path),
                duration,
                bitrate,
                size,
                tracks,
                width,
                height,
                taken_ms: None,
                camera: None,
                lens: None,
                iso: None,
                aperture: None,
                shutter: None,
                focal: None,
                gps: None,
                created_ms,
                modified_ms,
                dir_size: None,
                entry_count: None,
            });
        };

        let mut tracks = Vec::new();
        let mut width = None;
        let mut height = None;
        if let Some(streams) = raw["streams"].as_array() {
            for s in streams {
                let t = s["codec_type"].as_str().unwrap_or("");
                let codec = s["codec_name"].as_str().unwrap_or("").to_string();
                let lang = s["tags"]["language"]
                    .as_str()
                    .unwrap_or("und")
                    .to_string();
                match t {
                    "video" => {
                        if width.is_none() {
                            width = s["width"].as_u64().map(|x| x as u32);
                            height = s["height"].as_u64().map(|x| x as u32);
                        }
                        let fps = s["r_frame_rate"]
                            .as_str()
                            .map(|r| {
                                let mut it = r.split('/');
                                let a: f64 = it.next().unwrap_or("0").parse().unwrap_or(0.0);
                                let b: f64 = it.next().unwrap_or("1").parse().unwrap_or(1.0);
                                if b > 0.0 {
                                    format!("{:.2} fps", a / b)
                                } else {
                                    String::new()
                                }
                            })
                            .unwrap_or_default();
                        let wh = match (width, height) {
                            (Some(w), Some(h)) => format!("{}×{} ", w, h),
                            _ => String::new(),
                        };
                        tracks.push(MediaTrack {
                            kind: "video".into(),
                            codec,
                            detail: format!(
                                "{}{}{}",
                                wh,
                                fps,
                                if lang != "und" {
                                    format!(" [{}]", lang)
                                } else {
                                    String::new()
                                }
                            ),
                        });
                    }
                    "audio" => {
                        let ch = s["channels"].as_u64().unwrap_or(0);
                        tracks.push(MediaTrack {
                            kind: "audio".into(),
                            codec,
                            detail: format!("{}声道 [{}]", ch, lang),
                        });
                    }
                    "subtitle" => {
                        tracks.push(MediaTrack {
                            kind: "subtitle".into(),
                            codec,
                            detail: format!("[{}]", lang),
                        });
                    }
                    _ => {}
                }
            }
        }
        let duration = raw["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse::<f64>().ok());
        let bitrate = raw["format"]["bit_rate"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok());
        let container = raw["format"]["format_name"].as_str().unwrap_or("").to_string();
        Ok(MediaInfo {
            container,
            duration,
            bitrate,
            size,
            tracks,
            width,
            height,
            taken_ms: None,
            camera: None,
            lens: None,
            iso: None,
            aperture: None,
            shutter: None,
            focal: None,
            gps: None,
            created_ms,
            modified_ms,
            dir_size: None,
            entry_count: None,
        })
    } else if kind == "image" {
        let (taken_ms, camera, lens, iso, aperture, shutter, focal, gps) =
            media::exif_detail(&p);
        let (mut width, mut height) = (None, None);
        if let Ok(file) = std::fs::File::open(&p) {
            if let Ok(reader) = image::ImageReader::new(std::io::BufReader::new(file))
                .with_guessed_format()
            {
                if let Ok((w, h)) = reader.into_dimensions() {
                    width = Some(w);
                    height = Some(h);
                }
            }
        }
        let ext = crate::util::ext_of(&path);
        Ok(MediaInfo {
            container: ext,
            duration: None,
            bitrate: None,
            size,
            tracks: Vec::new(),
            width,
            height,
            taken_ms,
            camera,
            lens,
            iso,
            aperture,
            shutter,
            focal,
            gps,
            created_ms: ctime_of(&p),
            modified_ms: mtime_of(&p),
            dir_size: None,
            entry_count: None,
        })
    } else {
        let ext = crate::util::ext_of(&path);
        Ok(MediaInfo {
            container: ext,
            duration: None,
            bitrate: None,
            size,
            tracks: Vec::new(),
            width: None,
            height: None,
            taken_ms: None,
            camera: None,
            lens: None,
            iso: None,
            aperture: None,
            shutter: None,
            focal: None,
            gps: None,
            created_ms: ctime_of(&p),
            modified_ms: mtime_of(&p),
            dir_size: None,
            entry_count: None,
        })
    }
}

// ---------- helpers ----------

fn ctime_of(p: &Path) -> i64 {
    p.metadata()
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_of(p: &Path) -> i64 {
    p.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- 照片按日期智能归类 ----------

#[tauri::command]
pub fn smart_organize_plan(
    state: tauri::State<'_, AppState>,
    dir: String,
) -> CmdResult<Vec<OrganizePlanItem>> {
    state.ensure_open()?;
    let list = fsops::list_dir(&state, &dir)?;
    let base = PathBuf::from(&dir);
    let mut out = Vec::new();
    for e in list
        .entries
        .iter()
        .filter(|e| !e.is_dir && (e.kind == "image" || e.kind == "video"))
    {
        // 照片：EXIF 拍摄日期；视频：容器 creation_time → EXIF → 文件创建时间
        let taken = if e.kind == "image" {
            media::exif_taken_ms(Path::new(&e.path)).unwrap_or(e.modified_ms)
        } else {
            media::video_taken_ms(Path::new(&e.path))
                .or_else(|| media::exif_taken_ms(Path::new(&e.path)))
                .unwrap_or(e.created_ms)
        };
        if taken <= 0 {
            continue;
        }
        let (y, m) = crate::util::ms_to_ym(taken);
        let rel = format!("{:04}/{:04}-{:02}", y, y, m);
        let to = base.join(&rel).join(&e.name);
        out.push(OrganizePlanItem {
            from: e.path.clone(),
            to: to.to_string_lossy().to_string(),
            name: e.name.clone(),
            conflict: to.exists(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn smart_organize_apply(
    state: tauri::State<'_, AppState>,
    items: Vec<OrganizePlanItem>,
) -> CmdResult<i32> {
    let root = state.ensure_open()?;
    let mut done = 0;
    for it in &items {
        if it.conflict || it.from == it.to {
            continue;
        }
        let from = PathBuf::from(&it.from);
        let to = PathBuf::from(&it.to);
        if !from.exists() {
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
        std::fs::rename(&from, &to).map_err(|e| format!("移动失败 {}: {}", it.name, e))?;
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        crate::db::rename_refs(conn, &it.from, &it.to)?;
        // 归类移动后刷新修改时间，并实时迁移目录占用
        crate::util::touch_now(&it.to);
        let sz = Path::new(&it.to).metadata().map(|m| m.len() as i64).unwrap_or(0);
        fsops::adjust_dir_sizes(conn, &root, &from, -sz);
        fsops::adjust_dir_sizes(conn, &root, &to, sz);
        done += 1;
    }
    crate::cache::invalidate_dir_cache(); // 归类移动改变目录结构
    Ok(done)
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DirNode {
    pub path: String,
    pub name: String,
    pub children: Vec<DirNode>,
}

/// 库内目录树（供“移动到 / 上传到”选择器），跳过隐藏目录，限深 6 级
#[tauri::command]
pub fn dir_tree(state: tauri::State<'_, AppState>) -> CmdResult<Vec<DirNode>> {
    fn scan(dir: &Path, depth: usize) -> Vec<DirNode> {
        let mut out = Vec::new();
        if depth > 6 {
            return out;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return out;
        };
        for item in rd.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if !item.path().is_dir() {
                continue;
            }
            if crate::util::is_hidden(&name, &item.path()) {
                continue;
            }
            let children = scan(&item.path(), depth + 1);
            out.push(DirNode {
                path: item.path().to_string_lossy().to_string(),
                name,
                children,
            });
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    }
    let root = state.ensure_open()?;
    Ok(scan(&root, 0))
}

// ---------- 搜索与索引 ----------

pub fn do_search(state: &AppState, query: &str) -> CmdResult<Vec<SearchResult>> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let tokens: Vec<String> = q.split_whitespace().map(|s| s.to_lowercase()).collect();
    let mut clauses = Vec::new();
    let mut bind: Vec<String> = Vec::new();
    for t in &tokens {
        let esc = t
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let like = format!("%{}%", esc);
        clauses.push(
            "(name LIKE ? ESCAPE '\\' OR name_py LIKE ? ESCAPE '\\' OR py_initial LIKE ? ESCAPE '\\')"
                .to_string(),
        );
        bind.push(like.clone());
        bind.push(like.clone());
        bind.push(like);
    }
    let sql = format!(
        "SELECT path, parent, name, is_dir, kind, size, created_at FROM index_entries WHERE {} ORDER BY is_dir DESC, name COLLATE NOCASE LIMIT 400",
        clauses.join(" AND ")
    );
    let bind_ref: Vec<&dyn rusqlite::ToSql> = bind.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(bind_ref.as_slice(), |r| {
            Ok(SearchResult {
                path: r.get(0)?,
                parent: r.get(1)?,
                name: r.get(2)?,
                is_dir: r.get::<_, i64>(3)? != 0,
                kind: r.get(4)?,
                size: r.get::<_, i64>(5)?.max(0) as u64,
                created_ms: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
pub fn search(state: tauri::State<'_, AppState>, query: String) -> CmdResult<Vec<SearchResult>> {
    do_search(&state, &query)
}

#[tauri::command]
pub fn scan_start(app: AppHandle) -> CmdResult<()> {
    scan::start_scan(app)
}

#[tauri::command]
pub fn scan_status(state: tauri::State<'_, AppState>) -> CmdResult<ScanStatus> {
    state.ensure_open()?;
    let running = state.scanning.load(Ordering::SeqCst);
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let last_scan: Option<i64> = conn
        .query_row("SELECT value FROM meta WHERE key='last_scan'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| s.parse().ok());
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM index_entries", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(ScanStatus {
        running,
        last_scan,
        count,
    })
}

#[tauri::command]
pub fn stats(state: tauri::State<'_, AppState>) -> CmdResult<Stats> {
    state.ensure_open()?;
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let q = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
    let last_scan: Option<i64> = conn
        .query_row("SELECT value FROM meta WHERE key='last_scan'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|s| s.parse().ok());
    Ok(Stats {
        files: q("SELECT COUNT(*) FROM index_entries WHERE is_dir = 0"),
        dirs: q("SELECT COUNT(*) FROM index_entries WHERE is_dir = 1"),
        videos: q("SELECT COUNT(*) FROM index_entries WHERE kind = 'video'"),
        images: q("SELECT COUNT(*) FROM index_entries WHERE kind = 'image'"),
        total_size: q("SELECT COALESCE(SUM(size), 0) FROM index_entries WHERE is_dir = 0"),
        last_scan,
    })
}

#[tauri::command]
pub fn recent_files(
    state: tauri::State<'_, AppState>,
    limit: i64,
) -> CmdResult<Vec<SearchResult>> {
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let mut stmt = conn
        .prepare(
            "SELECT path, parent, name, is_dir, kind, size, created_at FROM index_entries WHERE is_dir = 0 AND kind IN ('video','image') ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(SearchResult {
                path: r.get(0)?,
                parent: r.get(1)?,
                name: r.get(2)?,
                is_dir: r.get::<_, i64>(3)? != 0,
                kind: r.get(4)?,
                size: r.get::<_, i64>(5)?.max(0) as u64,
                created_ms: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

// ---------- 收藏 ----------

#[tauri::command]
pub fn add_favorite(
    state: tauri::State<'_, AppState>,
    path: String,
    cat_id: Option<i64>,
) -> CmdResult<()> {
    let name = PathBuf::from(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    // cat_id 缺省/负值 = 不指定归类：新收藏进入根目录，已收藏项保持原分类不变
    let cat = cat_id.unwrap_or(0).max(0);
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    // 分类存在性校验与写入在同一锁内完成，避免校验后被并发删除产生悬空 cat_id
    if cat > 0
        && conn
            .query_row(
                "SELECT 1 FROM fav_categories WHERE id = ?1",
                params![cat],
                |_| Ok(()),
            )
            .is_err()
    {
        return Err("收藏夹分类不存在".into());
    }
    conn.execute(
        "INSERT INTO favorites (path, name, added_at, cat_id) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           cat_id = CASE WHEN excluded.cat_id > 0 THEN excluded.cat_id ELSE favorites.cat_id END",
        params![path, name, util::now_ms(), cat],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_favorite(state: tauri::State<'_, AppState>, path: String) -> CmdResult<()> {
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    conn.execute("DELETE FROM favorites WHERE path = ?1", params![path])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_favorites(state: tauri::State<'_, AppState>) -> CmdResult<Vec<FavoriteItem>> {
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let mut stmt = conn
        .prepare("SELECT path, name, cat_id FROM favorites ORDER BY added_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FavoriteItem {
                path: r.get(0)?,
                name: r.get(1)?,
                is_dir: false,
                kind: String::new(),
                cat_id: r.get::<_, i64>(2).unwrap_or(0),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<FavoriteItem> = rows.flatten().collect();
    drop(stmt);
    for f in out.iter_mut() {
        let p = Path::new(&f.path);
        f.is_dir = p.is_dir();
        f.kind = if f.is_dir {
            "dir".to_string()
        } else {
            crate::util::kind_of(&f.name, false)
        };
    }
    out.retain(|f| Path::new(&f.path).exists());
    Ok(out)
}

// ---------- 收藏夹分类 ----------

#[tauri::command]
pub fn list_fav_categories(state: tauri::State<'_, AppState>) -> CmdResult<Vec<FavCategory>> {
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let mut stmt = conn
        .prepare("SELECT id, name FROM fav_categories ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FavCategory {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

fn clean_cat_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("分类名不能为空".into());
    }
    if n.chars().count() > 24 {
        return Err("分类名过长（最多 24 字）".into());
    }
    Ok(n.to_string())
}

fn is_unique_violation(e: &rusqlite::Error) -> bool {
    // rusqlite 主码只区分到 ConstraintViolation（UNIQUE/主码等），
    // fav_categories 上除自增主键外仅 name UNIQUE 约束，该判断足够精确
    matches!(
        e.sqlite_error_code(),
        Some(rusqlite::ffi::ErrorCode::ConstraintViolation)
    )
}

#[tauri::command]
pub fn add_fav_category(state: tauri::State<'_, AppState>, name: String) -> CmdResult<i64> {
    let n = clean_cat_name(&name)?;
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    conn.execute(
        "INSERT INTO fav_categories (name, created_at) VALUES (?1, ?2)",
        params![n, util::now_ms()],
    )
    .map_err(|e| {
        if is_unique_violation(&e) {
            "同名分类已存在".to_string()
        } else {
            e.to_string()
        }
    })?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn rename_fav_category(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
) -> CmdResult<()> {
    let n = clean_cat_name(&name)?;
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let changed = conn
        .execute(
            "UPDATE fav_categories SET name = ?2 WHERE id = ?1",
            params![id, n],
        )
        .map_err(|e| {
            if is_unique_violation(&e) {
                "同名分类已存在".to_string()
            } else {
                e.to_string()
            }
        })?;
    if changed == 0 {
        return Err("分类不存在".into());
    }
    Ok(())
}

/// 删除分类：其下收藏回到收藏夹根目录（不删除收藏本身）
#[tauri::command]
pub fn delete_fav_category(state: tauri::State<'_, AppState>, id: i64) -> CmdResult<()> {
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE favorites SET cat_id = 0 WHERE cat_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE favorites_trash SET cat_id = 0 WHERE cat_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM fav_categories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 系统与应用 ----------

#[tauri::command]
pub fn list_apps() -> Vec<InstalledApp> {
    sys::list_installed_apps()
}

#[tauri::command]
pub fn open_with(path: String, app: Option<String>) -> CmdResult<()> {
    if !Path::new(&path).exists() {
        return Err("文件不存在".into());
    }
    match app {
        Some(a) if !a.trim().is_empty() => sys::open_with_app(&path, a.trim()),
        _ => sys::open_default(&path),
    }
}

#[tauri::command]
pub fn reveal(path: String) -> CmdResult<()> {
    if !Path::new(&path).exists() {
        return Err("路径不存在".into());
    }
    sys::reveal(&path)
}

/// 在文件管理器中打开目录并进入（macOS Finder / Windows 资源管理器）。
/// 用于设置里「进入缓存目录」一键跳转 —— sys::open_default 对目录即打开窗口进入。
#[tauri::command]
pub fn open_directory(path: String) -> CmdResult<()> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("目录不存在".into());
    }
    sys::open_default(&path)
}

// ---------- 设置 ----------

/// 读取全局设置值（1.0.2-r8 起统一读 prefs.json，与资料库无关）
fn setting_value(state: &AppState, key: &str) -> Option<String> {
    state
        .prefs_path()
        .and_then(|p| crate::state::read_prefs_file(&p).get(key).cloned())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, AppState>) -> CmdResult<HashMap<String, String>> {
    let p = state.prefs_path().ok_or("全局设置不可用")?;
    let mut m = crate::state::read_prefs_file(&p);
    // 一次性迁移（1.0.2-r8）：老版本设置存在库级 settings 表。
    // 首次读取时把「全局缺失的 key」从当前库提升为全局（已存在的 key 不覆盖），
    // 写回后旧库不再作为来源。多库场景：先迁移的库成为全局默认，之后切库不覆盖。
    let legacy: Option<Vec<(String, String)>> = {
        let guard = state.conn().ok();
        let conn = guard.as_ref().and_then(|(_, g)| g.get().ok());
        conn.and_then(|conn| {
            let mut stmt = conn.prepare("SELECT key, value FROM settings").ok()?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .ok()?;
            Some(rows.flatten().collect())
        })
    };
    let mut merged = false;
    if let Some(rows) = legacy {
        for (k, v) in rows {
            if !m.contains_key(&k) && !v.is_empty() {
                m.insert(k, v);
                merged = true;
            }
        }
    }
    if merged {
        crate::state::write_prefs_file(&p, &m);
    }
    Ok(m)
}

#[tauri::command]
pub fn set_setting(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> CmdResult<()> {
    // 写入全局 prefs.json（1.0.2-r8：设置不随资料库切换而变）
    let p = state.prefs_path().ok_or("全局设置不可用")?;
    let mut m = crate::state::read_prefs_file(&p);
    m.insert(key.clone(), value);
    crate::state::write_prefs_file(&p, &m);
    // 1.0.2-r4：缓存保留时长改动立即生效（不必重启 / 重开资料库）
    if key == "cache_ttl_hours" {
        crate::cache::set_cache_ttl_hours(cache_ttl_hours(&state));
    }
    Ok(())
}

/// 读取「缓存保留时长（小时）」设置；非法值回退到默认 1 小时，0 = 永不自动清理。
fn cache_ttl_hours(state: &AppState) -> u64 {
    match setting_value(state, "cache_ttl_hours").as_deref() {
        Some(v) => v.trim().parse::<u64>().unwrap_or(crate::cache::DEFAULT_TTL_HOURS),
        None => crate::cache::DEFAULT_TTL_HOURS,
    }
}

// ---------- TMDB ----------

#[tauri::command]
pub async fn tmdb_search(
    state: tauri::State<'_, AppState>,
    query: String,
) -> CmdResult<Vec<TmdbMovie>> {
    let key = setting_value(&state, "tmdb_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("请先在设置中配置 TMDB API Key")?;
    tmdb::search(key.trim(), &query).await
}

#[tauri::command]
pub async fn tmdb_apply(
    state: tauri::State<'_, AppState>,
    dir_path: String,
    id: i64,
) -> CmdResult<DirMeta> {
    let root = state.ensure_open()?;
    let key = setting_value(&state, "tmdb_key")
        .filter(|k| !k.trim().is_empty())
        .ok_or("请先在设置中配置 TMDB API Key")?;
    let (movie, poster_url) = tmdb::movie_detail(key.trim(), id).await?;
    let mut poster_file: Option<String> = None;
    if let Some(url) = &poster_url {
        poster_file = tmdb::download_poster(&covers_dir(&root), &dir_path, url)
            .await
            .ok();
    }
    let meta = tmdb::meta_from_movie(&dir_path, &movie, poster_file.clone());
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    conn.execute(
        "INSERT OR REPLACE INTO dir_meta (path, title, year, overview, rating, tmdb_id, poster_file, extra, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        params![
            dir_path,
            meta.title,
            meta.year,
            meta.overview,
            meta.rating,
            meta.tmdb_id,
            meta.poster_file,
            Option::<String>::None,
            util::now_ms()
        ],
    )
    .map_err(|e| e.to_string())?;
    if let Some(pf) = &poster_file {
        conn.execute(
            "INSERT OR REPLACE INTO covers (path, kind, cover_file, source, frame_time, updated_at) VALUES (?1, 'dir', ?2, 'tmdb', NULL, ?3)",
            params![dir_path, pf, util::now_ms()],
        )
        .map_err(|e| e.to_string())?;
    }
    crate::cache::invalidate_dir_cache(); // 刮削改变 dir_meta / covers
    Ok(meta)
}

// ---------- 入口 ----------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .manage(PipStore::default())
        .manage(PipStateStore::default())
        .setup(|app| {
            // 注入全局偏好文件路径：prefs.json 承载全部应用设置，与资料库无关
            if let Ok(d) = app.path().app_data_dir() {
                app.state::<AppState>().set_prefs_path(d.join("prefs.json"));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            detect_library,
            open_library,
            get_paths,
            list_dir,
            create_dir,
            rename_entry,
            move_entries,
            copy_entries,
            delete_entries,
            list_trash,
            restore_trash,
            delete_forever,
            empty_trash,
            set_trash_ttl_days,
            sweep_trash,
            get_thumbs,
            get_preview,
            disk_usage,
            clear_cache,
            optimize_db,
            prewarm_thumbs,
            capture_frame,
            probe_subtitles,
            read_subtitle,
            capture_snapshot,
            pick_subtitle_file,
            pick_folder,
            set_cover,
            video_info,
            media_dates,
            dir_tree,
            set_tag,
            tag_roots,
            media_info,
            smart_organize_plan,
            smart_organize_apply,
            search,
            scan_start,
            scan_status,
            stats,
            recent_files,
            add_favorite,
            remove_favorite,
            list_favorites,
            list_fav_categories,
            add_fav_category,
            rename_fav_category,
            delete_fav_category,
            list_apps,
            open_with,
            reveal,
            open_directory,
            stream_base,
            moov_position,
            start_remux,
            remux_status,
            scrub_sheet,
            cleanup_remux,
            get_settings,
            set_setting,
            get_pref,
            set_pref,
            tmdb_search,
            tmdb_apply,
            // PiP 独立窗口命令（在 pip.rs 中通过 #[tauri::command] 注册）
            crate::pip::open_pip_window,
            crate::pip::get_pip_payload,
            crate::pip::close_pip_window,
            crate::pip::set_pip_state,
            crate::pip::take_pip_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
