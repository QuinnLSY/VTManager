//! 缓存管理（1.0.1-r13 新增，1.0.2 扩展，1.0.2-r4 增加时间维度过期）：
//! - 磁盘占用统计（设置面板「存储空间」展示）
//! - 手动一键清除缓存（红色按钮）
//! - 缓存磁盘自动上限：超过阈值按最旧优先清理，防止长期使用硬盘无限膨胀
//! - **按时间过期（1.0.2-r4）**：长时间未被再次查看的缩略图/预览自动删除，
//!   「查看过」以缓存文件 mtime 为准（命中缓存时 touch 续期，见 media.rs）
//! - 目录列表内存缓存（1.0.2）：3 秒 TTL + LRU 上限，返回上级/重复浏览秒开
//! 涉及目录：cache/thumbs（缩略图）、cache/previews（图片查看器预览）、cache/remux（转封装副本）。
//! 以上均为可再生缓存，清除不影响应用正常使用（下次浏览/播放按需重建）。
//!
//! 注意：remux 副本**不参与**按时间过期 —— 它可能正在被播放（删除会让流式播放中断），
//! 其生命周期由「关闭播放器即删」（1.0.2-r3）+ 2GB 总上限兜底。

use crate::state::{cache_dir, covers_dir, previews_dir, remux_dir, thumbs_dir, trash_dir, vtm_dir};
use crate::types::DirListing;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 缓存总上限（默认 2GB）
pub const CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 超限后清理到该水位（上限的 80%）
pub const CACHE_TRIM_TO_BYTES: u64 = CACHE_LIMIT_BYTES * 8 / 10;
/// 每生成 N 份缓存采样检查一次目录总大小（避免每次生成都全目录统计）
const TRIM_CHECK_EVERY: u64 = 64;

static CACHE_WRITES: AtomicU64 = AtomicU64::new(0);

// ---------- 按时间过期（1.0.2-r4） ----------
//
// 背景：资料库全在本地盘，缓存只是"加速产物"。旧的策略只有 2GB 总量上限，
// 导致缓存长期膨胀到接近上限才回收。改为时间维度：超过 TTL 未被再次查看的
// 缩略图/预览直接删除，之后访问按需重建（重建成本：缩略图几十 ms，预览几百 ms）。
//
// 「再次查看」的判定 = 缓存文件 mtime：
//   - 生成时自然写入当前时间；
//   - 命中缓存时 touch 续期（media::image_thumb / video_thumb / preview_image）。
// 用 mtime 而不是内存表，是为了跨应用重启仍然准确；用 mtime 而不是 atime，
// 是因为 macOS APFS 的 atime 更新不可靠（可能被 noatime 关闭）。

/// 默认保留时长：1 小时（用户可在设置里改为 6/24 小时或"永不清理"）
pub const DEFAULT_TTL_HOURS: u64 = 1;
/// 过期扫描的最小间隔（避免频繁遍历目录）
const SWEEP_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
/// 只有这两个目录参与按时间过期（remux 例外，见模块注释）
const TTL_DIRS: [&str; 3] = ["thumbs", "previews", "scrubs"];

/// 当前保留时长（秒）；0 = 永不自动清理。由设置项 cache_ttl_hours 驱动。
static TTL_SECS: AtomicU64 = AtomicU64::new(DEFAULT_TTL_HOURS * 3600);

/// 打开资料库 / 修改设置时同步（把"小时数"设置折算成秒；0 表示关闭自动清理）
pub fn set_cache_ttl_hours(hours: u64) {
    TTL_SECS.store(hours.saturating_mul(3600), Ordering::Relaxed);
}

fn cache_ttl() -> Option<std::time::Duration> {
    let s = TTL_SECS.load(Ordering::Relaxed);
    if s == 0 {
        None
    } else {
        Some(std::time::Duration::from_secs(s))
    }
}

/// 命中缓存时调用：把 mtime 刷新为当前时间，表示"刚刚还在用"。
/// 失败静默（文件系统只读 / 文件被并发删除等都不影响功能）。
pub fn touch_cache_file(path: &Path) {
    if let Ok(f) = std::fs::File::options().write(true).open(path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

static LAST_SWEEP: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// 频率受限的过期扫描：距上次扫描不足 SWEEP_MIN_INTERVAL 直接跳过。
/// 适合挂在高频路径（缩略图生成、设置面板查占用）上。
pub fn maybe_sweep_expired_cache(root: &Path) {
    let mut g = LAST_SWEEP.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(at) = *g {
        if at.elapsed() < SWEEP_MIN_INTERVAL {
            return;
        }
    }
    *g = Some(std::time::Instant::now());
    drop(g);
    let _ = sweep_expired_cache(root);
}

/// 删除超过保留时长未被访问的缩略图/预览，返回释放的字节数。
/// 正在写入的临时文件（.tmp / .part）跳过，留给下次生成时清理。
pub fn sweep_expired_cache(root: &Path) -> Result<u64, String> {
    let Some(ttl) = cache_ttl() else {
        return Ok(0);
    };
    let now = std::time::SystemTime::now();
    let mut freed: u64 = 0;
    let mut removed = 0usize;
    for sub in TTL_DIRS {
        let d = cache_dir(root).join(sub);
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            // 临时文件：可能是另一个线程正在写入，删了会造成半截缓存
            let is_tmp = p
                .extension()
                .map(|x| x == "tmp" || x == "tmp.jpg" || x == "part")
                .unwrap_or(false);
            if is_tmp {
                continue;
            }
            let age = now
                .duration_since(md.modified().unwrap_or(now))
                .unwrap_or_default();
            if age < ttl {
                continue;
            }
            if std::fs::remove_file(&p).is_ok() {
                freed += md.len();
                removed += 1;
            }
        }
    }
    if removed > 0 {
        invalidate_usage_cache(); // 磁盘占用统计作废，设置面板下次拿到真实值
    }
    Ok(freed)
}

// ---------- 目录列表内存缓存（1.0.2） ----------
//
// list_dir 每次都要 read_dir + 查封面/tags/dir_sizes/元数据 四张表，
// 返回上级、重复浏览、多栏联查时开销重复。这里做 3 秒 TTL 短缓存：
// - TTL 极短，即使无显式失效也几乎不会返回过时数据；
// - 所有写操作（增删改移、封面/标签/刮削、扫描、外部变更）都显式失效，保证一致性；
// - 大目录（数千项）缓存克隆开销小（Arc 共享 + 仅在命中时克隆一次返回给调用方）。

const DIR_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3);
const DIR_CACHE_MAX: usize = 64;

struct DirCacheEntry {
    at: std::time::Instant,
    listing: Arc<DirListing>,
}

static DIR_CACHE: Mutex<Option<HashMap<String, DirCacheEntry>>> = Mutex::new(None);

/// 命中返回 Arc 共享引用（避免克隆整个 listing）；未命中或过期返回 None
pub fn cached_listing(path: &str) -> Option<Arc<DirListing>> {
    let mut g = DIR_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if let Some(e) = m.get(path) {
        if e.at.elapsed() < DIR_CACHE_TTL {
            return Some(e.listing.clone());
        }
        m.remove(path);
    }
    // 上限保护：满了直接整体清空（简单可靠，代价是下一次重新读盘）
    if m.len() >= DIR_CACHE_MAX {
        m.clear();
    }
    None
}

/// 存储成功读取的目录列表
pub fn store_listing(path: String, listing: DirListing) {
    let mut g = DIR_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    m.insert(
        path,
        DirCacheEntry {
            at: std::time::Instant::now(),
            listing: Arc::new(listing),
        },
    );
}

/// 写操作/外部变更/扫描后调用：全量失效，杜绝缓存与磁盘不一致
pub fn invalidate_dir_cache() {
    if let Ok(mut g) = DIR_CACHE.lock() {
        *g = None;
    }
}

/// 生成缓存后调用：① 按时间清理过期缓存（内部自限频）② 按采样频率检查总大小，
/// 超限自动清理最旧缓存。两者都是可再生缓存，删掉只影响下次重建速度。
pub fn maybe_trim_cache(root: &Path) {
    maybe_sweep_expired_cache(root);
    let n = CACHE_WRITES.fetch_add(1, Ordering::Relaxed) + 1;
    if n % TRIM_CHECK_EVERY != 0 {
        return;
    }
    let _ = trim_cache_impl(root, CACHE_LIMIT_BYTES, CACHE_TRIM_TO_BYTES);
}

/// 手动清除全部可再生缓存（thumbs/previews/remux），返回释放的字节数。
/// 保留目录本身；正在写入的 .tmp 文件跳过（下次生成时清理）。
pub fn clear_cache(root: &Path) -> Result<u64, String> {
    let mut freed: u64 = 0;
    for sub in ["thumbs", "previews", "remux", "scrubs"] {
        let d = cache_dir(root).join(sub);
        if !d.exists() {
            continue;
        }
        let rd = std::fs::read_dir(&d).map_err(|e| format!("读取缓存目录失败: {}", e))?;
        for e in rd.flatten() {
            let p = e.path();
            let is_tmp = p
                .extension()
                .map(|x| x == "tmp" || x == "tmp.jpg" || x == "part")
                .unwrap_or(false);
            if is_tmp {
                let _ = std::fs::remove_file(&p); // 残留临时文件一并清掉
                continue;
            }
            if let Ok(md) = e.metadata() {
                if md.is_file() {
                    freed += md.len();
                }
            }
            let _ = std::fs::remove_file(&p);
        }
    }
    invalidate_usage_cache();
    Ok(freed)
}

/// 磁盘占用明细（设置面板展示）
/// 注意：字段保持 snake_case 输出（与前端 TS 类型一致；勿加 rename_all = "camelCase"）
#[derive(serde::Serialize, Clone)]
pub struct DiskUsage {
    pub total_bytes: u64,
    pub thumbs_bytes: u64,
    pub previews_bytes: u64,
    pub remux_bytes: u64,
    /// 悬停帧预览精灵图（1.0.2-r5+）
    pub scrubs_bytes: u64,
    pub covers_bytes: u64,
    pub trash_bytes: u64,
    pub db_bytes: u64,
    /// 应用本体（.app 安装包 / 可执行文件）大小，1.0.2 新增
    pub app_bytes: u64,
}

/// 统计结果 TTL：5 秒内重复调用直接返回缓存，避免设置面板轮询时反复遍历目录树
const USAGE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5);
static USAGE_CACHE: Mutex<Option<(std::time::Instant, DiskUsage)>> = Mutex::new(None);

pub fn disk_usage(root: &Path) -> DiskUsage {
    let mut guard = USAGE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((at, cached)) = guard.as_ref() {
        if at.elapsed() < USAGE_CACHE_TTL {
            return cached.clone();
        }
    }
    let mut usage = compute_disk_usage(root);
    usage.app_bytes = app_size();
    *guard = Some((std::time::Instant::now(), usage.clone()));
    usage
}

/// 清缓存/自动清理后调用，避免旧统计被 TTL 继续返回
pub fn invalidate_usage_cache() {
    if let Ok(mut guard) = USAGE_CACHE.lock() {
        *guard = None;
    }
}

/// 单次遍历 vtm 数据目录，同时归类累加各分类字节数。
/// （旧实现按分类分别递归 7 次，目录大时统计耗时放大；此处降为 1 次遍历。）
fn compute_disk_usage(root: &Path) -> DiskUsage {
    let vtm = vtm_dir(root);
    let thumbs = thumbs_dir(root);
    let previews = previews_dir(root);
    let remux = remux_dir(root);
    let scrubs = crate::state::scrubs_dir(root);
    let covers = covers_dir(root);
    let trash = trash_dir(root);
    let db = vtm.join("vtmanager.db");
    let db_wal = vtm.join("vtmanager.db-wal");
    let db_shm = vtm.join("vtmanager.db-shm");

    let mut d = DiskUsage {
        total_bytes: 0,
        thumbs_bytes: 0,
        previews_bytes: 0,
        remux_bytes: 0,
        scrubs_bytes: 0,
        covers_bytes: 0,
        trash_bytes: 0,
        db_bytes: 0,
        app_bytes: 0,
    };
    let mut stack: Vec<PathBuf> = vec![vtm];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(p);
                continue;
            }
            if !md.is_file() {
                continue;
            }
            let size = md.len();
            d.total_bytes += size;
            if p.starts_with(&thumbs) {
                d.thumbs_bytes += size;
            } else if p.starts_with(&previews) {
                d.previews_bytes += size;
            } else if p.starts_with(&remux) {
                d.remux_bytes += size;
            } else if p.starts_with(&scrubs) {
                d.scrubs_bytes += size;
            } else if p.starts_with(&covers) {
                d.covers_bytes += size;
            } else if p.starts_with(&trash) {
                d.trash_bytes += size;
            } else if p == db || p == db_wal || p == db_shm {
                d.db_bytes += size;
            }
        }
    }
    d
}

/// 递归统计目录总字节数（不跟随符号链接）
pub fn dir_size(path: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![path.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(p);
            } else if md.is_file() {
                total += md.len();
            }
        }
    }
    total
}

/// 应用本体占用（设置面板「存储空间」展示）：
/// macOS 发布包为 .app 目录大小（含主程序、ffmpeg、资源等）；
/// 开发环境（cargo run / cargo tauri dev）无 .app 包裹，返回可执行文件自身大小。
pub fn app_size() -> u64 {
    let Ok(exe) = std::env::current_exe() else { return 0 };
    #[cfg(target_os = "macos")]
    {
        // 发布包：exe 位于 <App>.app/Contents/MacOS/，向上第 3 级是 .app 包
        if let Some(app) = exe.ancestors().nth(3) {
            if app.extension().map(|e| e == "app").unwrap_or(false) {
                return dir_size(app);
            }
        }
    }
    std::fs::metadata(&exe).map(|m| m.len()).unwrap_or(0)
}

/// 超限清理：按 (子目录优先级, mtime) 最旧优先删除，直到总大小 ≤ target。
/// 优先级：thumbs > previews > remux（重建成本递增，先删便宜的）。
fn trim_cache_impl(root: &Path, limit: u64, target: u64) -> Result<(), String> {
    let cache = cache_dir(root);
    let total = dir_size(&cache);
    if total <= limit {
        return Ok(());
    }
    let mut files: Vec<(PathBuf, i64, u64)> = Vec::new(); // (path, mtime_ms, size)
    for (sub, prio) in [("thumbs", 0i32), ("previews", 1), ("remux", 2)] {
        let d = cache.join(sub);
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            let mt = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // 正在写入的临时文件跳过（扩展名 .tmp）
            let is_tmp = p
                .extension()
                .map(|x| x == "tmp" || x == "tmp.jpg" || x == "part")
                .unwrap_or(false);
            if !is_tmp {
                // 排序键：优先级优先（×2^40 保证先按优先级），再按 mtime
                files.push((p, (prio as i64) << 40 | mt, md.len()));
            }
        }
    }
    files.sort_by_key(|f| f.1);
    let mut remaining = total;
    for (p, _, size) in files {
        if remaining <= target {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            remaining = remaining.saturating_sub(size);
        }
    }
    invalidate_usage_cache();
    Ok(())
}

// ---------- 单元测试（1.0.2-r4：按时间过期） ----------
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // 两个测试都会改写进程级全局 TTL_SECS（AtomicU64）并调用 sweep，若并行执行会互相污染：
    // sweep 测试 set 0（=永不）后被 touch 测试并发 set 1，导致「0 分支」误删文件（freed=2048 ≠ 0）。
    // 必须串行执行（1.0.2-r10 修复既有测试竞态）。
    static TTL_LOCK: Mutex<()> = Mutex::new(());

    fn tmp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vtm-cache-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|x| x.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(path: &Path, age: std::time::Duration) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x".repeat(2048)).unwrap();
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_modified(std::time::SystemTime::now() - age).unwrap();
    }

    #[test]
    fn sweep_removes_stale_and_keeps_fresh_and_remux() {
        let _ttl = TTL_LOCK.lock().unwrap();
        let root = tmp_root("sweep");
        let cache = cache_dir(&root);
        let stale = std::time::Duration::from_secs(3 * 3600); // 3 小时前
        let fresh = std::time::Duration::from_secs(60); // 1 分钟前

        let old_thumb = cache.join("thumbs/old.webp");
        let new_thumb = cache.join("thumbs/new.webp");
        let old_preview = cache.join("previews/old.webp");
        let tmp_file = cache.join("thumbs/writing.tmp");
        let remux = cache.join("remux/playing.mp4");
        put(&old_thumb, stale);
        put(&new_thumb, fresh);
        put(&old_preview, stale);
        put(&tmp_file, stale);
        put(&remux, stale);

        set_cache_ttl_hours(1);
        let freed = sweep_expired_cache(&root).unwrap();

        assert!(!old_thumb.exists(), "过期缩略图应被删除");
        assert!(!old_preview.exists(), "过期预览应被删除");
        assert!(new_thumb.exists(), "近期访问过的缩略图应保留");
        assert!(tmp_file.exists(), "正在写入的临时文件不应被删除");
        assert!(remux.exists(), "remux 副本不参与按时间过期（可能正在播放）");
        assert_eq!(freed, 4096, "应统计到 2 个文件 × 2KB");

        // 关闭自动清理后不再删除任何东西
        set_cache_ttl_hours(0);
        put(&cache.join("thumbs/stale2.webp"), stale);
        assert_eq!(sweep_expired_cache(&root).unwrap(), 0);
        assert!(cache.join("thumbs/stale2.webp").exists());

        set_cache_ttl_hours(DEFAULT_TTL_HOURS); // 还原，避免影响同进程其它测试
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn touch_cache_file_refreshes_mtime() {
        let _ttl = TTL_LOCK.lock().unwrap();
        let root = tmp_root("touch");
        let p = cache_dir(&root).join("thumbs/t.webp");
        put(&p, std::time::Duration::from_secs(7200));
        let before = std::fs::metadata(&p).unwrap().modified().unwrap();
        touch_cache_file(&p);
        let after = std::fs::metadata(&p).unwrap().modified().unwrap();
        assert!(after > before, "touch 应把 mtime 刷新为当前时间");

        set_cache_ttl_hours(1);
        assert!(p.exists());
        let _ = sweep_expired_cache(&root);
        assert!(p.exists(), "刚 touch 过的缓存不应被清理");

        set_cache_ttl_hours(DEFAULT_TTL_HOURS);
        let _ = std::fs::remove_dir_all(&root);
    }
}
