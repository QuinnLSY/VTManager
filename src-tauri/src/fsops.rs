use crate::state::{trash_dir, AppState};
use crate::types::{DirListing, DirMeta, Entry, TrashItem};
use crate::util::*;
use rusqlite::params;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

fn ms(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn cover_map(conn: &rusqlite::Connection, paths: &[String]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for chunk in paths.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders: Vec<String> = chunk.iter().map(|_| "?".to_string()).collect();
        let sql = format!(
            "SELECT path, cover_file FROM covers WHERE path IN ({})",
            placeholders.join(",")
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let bind: Vec<&dyn rusqlite::ToSql> = chunk.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
        let collected: Vec<(String, String)> = match stmt.query_map(bind.as_slice(), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => continue,
        };
        for row in collected {
            map.insert(row.0, row.1);
        }
    }
    map
}

/// 派生标签：文件夹被打上颜色后，其下所有子文件夹/文件按继承同样视为该颜色。
/// 自身精确标记优先于祖先继承；祖先取最近的被标记者。查表为 O(1)。
fn inherited_tag(path: &str, rows: &std::collections::HashMap<String, String>) -> Option<String> {
    if let Some(c) = rows.get(path) {
        return Some(c.clone());
    }
    let mut cur = path;
    loop {
        let i = match cur.rfind('/').or_else(|| cur.rfind('\\')) {
            Some(i) if i > 0 => i,
            _ => return None,
        };
        cur = &cur[..i];
        if let Some(c) = rows.get(cur) {
            return Some(c.clone());
        }
    }
}

/// 目录大小映射（来自扫描索引聚合；无数据则缺失）
pub fn dir_size_map(
    conn: &rusqlite::Connection,
    paths: &[String],
) -> std::collections::HashMap<String, i64> {
    let mut map = std::collections::HashMap::new();
    for chunk in paths.chunks(200) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders: Vec<String> = chunk.iter().map(|_| "?".to_string()).collect();
        let sql = format!(
            "SELECT path, size FROM dir_sizes WHERE path IN ({})",
            placeholders.join(",")
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            let bind: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
            if let Ok(rows) = stmt.query_map(bind.as_slice(), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            }) {
                for row in rows.flatten() {
                    map.insert(row.0, row.1);
                }
            }
        }
    }
    map
}

pub fn list_dir(state: &AppState, dir: &str) -> Result<DirListing, String> {
    let root = state.ensure_open()?;
    let p = PathBuf::from(dir);
    if !p.is_dir() {
        return Err(format!("目录不存在: {}", dir));
    }
    let mut entries: Vec<Entry> = Vec::new();
    let rd = std::fs::read_dir(&p).map_err(|e| format!("读取目录失败: {}", e))?;
    for item in rd.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if is_hidden(&name, &item.path()) {
            continue;
        }
        let Ok(md) = item.metadata() else { continue };
        let is_dir = md.is_dir();
        let size = if is_dir { 0 } else { md.len() };
        let created_ms = {
            let c = ms(md.created());
            if c > 0 { c } else { ms(md.modified()) }
        };
        let path_str = item.path().to_string_lossy().to_string();
        entries.push(Entry {
            name: name.clone(),
            path: path_str.clone(),
            is_dir,
            kind: kind_of(&name, is_dir),
            ext: if is_dir { String::new() } else { ext_of(&name) },
            size,
            created_ms,
            modified_ms: ms(md.modified()),
            cover: None,
            tag: None,
            dir_size: None,
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let (root2, guard) = state.conn()?;
    let _ = root2;
    let conn = guard.get()?;
    let cover_paths: Vec<String> = entries
        .iter()
        .filter(|e| e.is_dir || e.kind == "video")
        .map(|e| e.path.clone())
        .collect();
    let cm = cover_map(conn, &cover_paths);
    // 标签（含继承：被标记文件夹内的子项派生同色）与目录大小（索引聚合）；
    // tags 读取失败时降级为空表，不影响目录浏览
    let mut tag_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path, color FROM tags") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                tag_map.insert(row.0, row.1);
            }
        }
    }
    let dsm = dir_size_map(
        conn,
        &entries
            .iter()
            .filter(|e| e.is_dir)
            .map(|e| e.path.clone())
            .collect::<Vec<_>>(),
    );
    for e in entries.iter_mut() {
        if let Some(c) = cm.get(&e.path) {
            e.cover = Some(c.clone());
        }
        if let Some(c) = inherited_tag(&e.path, &tag_map) {
            e.tag = Some(c);
        }
        if e.is_dir {
            e.dir_size = dsm.get(&e.path).copied();
        }
    }
    let meta: Option<DirMeta> = conn
        .query_row(
            "SELECT path, title, year, overview, rating, tmdb_id, poster_file FROM dir_meta WHERE path = ?1",
            params![dir],
            |r| {
                Ok(DirMeta {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    year: r.get(2)?,
                    overview: r.get(3)?,
                    rating: r.get(4)?,
                    tmdb_id: r.get(5)?,
                    poster_file: r.get(6)?,
                })
            },
        )
        .ok();
    let parent = p
        .parent()
        .map(|x| x.to_string_lossy().to_string())
        .filter(|x| x.starts_with(root.to_string_lossy().as_ref()));
    Ok(DirListing {
        path: dir.to_string(),
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.to_string()),
        parent,
        entries,
        meta,
    })
}

pub fn create_dir(state: &AppState, parent: &str, name: &str) -> Result<String, String> {
    state.ensure_open()?;
    validate_name(name)?;
    let dir = PathBuf::from(parent);
    if !dir.is_dir() {
        return Err("父目录不存在".into());
    }
    let target = unique_target(&dir, name);
    std::fs::create_dir(&target).map_err(|e| format!("创建目录失败: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

pub fn rename_entry(state: &AppState, path: &str, new_name: &str) -> Result<String, String> {
    state.ensure_open()?;
    validate_name(new_name)?;
    let old = PathBuf::from(path);
    if !old.exists() {
        return Err("文件或目录不存在".into());
    }
    let parent = old.parent().ok_or("无法获取父目录")?;
    let target = parent.join(new_name);
    if target.exists() && target != old {
        return Err("同名文件已存在".into());
    }
    std::fs::rename(&old, &target).map_err(|e| format!("重命名失败: {}", e))?;
    let old_str = path.to_string();
    let new_str = target.to_string_lossy().to_string();
    if old_str != new_str {
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        crate::db::rename_refs(conn, &old_str, &new_str)?;
        // 重命名后刷新修改时间，让列表与详情反映这次操作
        crate::util::touch_now(&new_str);
    }
    Ok(new_str)
}

fn is_descendant(child: &Path, ancestor: &Path) -> bool {
    child.starts_with(ancestor) && child != ancestor
}

pub fn move_entries(state: &AppState, paths: Vec<String>, dest: &str) -> Result<(), String> {
    let root = state.ensure_open()?;
    let dest_p = PathBuf::from(dest);
    if !dest_p.is_dir() {
        return Err("目标目录不存在".into());
    }
    for p in paths {
        let src = PathBuf::from(&p);
        if !src.exists() {
            continue;
        }
        if is_descendant(&dest_p, &src) {
            return Err(format!("不能将目录移动到其自身子目录内: {}", src.display()));
        }
        // 已在目标目录内（原地）→ 跳过，避免 unique_target 误改文件名
        if src.parent().map(|p| p == dest_p).unwrap_or(false) {
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("无效路径")?;
        let target = unique_target(&dest_p, &name);
        // 目录大小：优先用索引聚合值（免全子树遍历），缺失才现算
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        let sz = match conn
            .query_row("SELECT size FROM dir_sizes WHERE path = ?1", params![p], |r| {
                r.get::<_, i64>(0)
            })
            .ok()
        {
            Some(s) if s > 0 => s,
            _ => path_size(&src, src.is_dir()) as i64,
        };
        std::fs::rename(&src, &target).map_err(|e| format!("移动失败 {}: {}", name, e))?;
        let new_str = target.to_string_lossy().to_string();
        crate::db::rename_refs(conn, &p, &new_str)?;
        // 移动后刷新修改时间
        crate::util::touch_now(&new_str);
        // 文件夹占用实时迁移：旧位置各祖先减、新位置各祖先加
        adjust_dir_sizes(conn, &root, &src, -sz);
        adjust_dir_sizes(conn, &root, &target, sz);
    }
    Ok(())
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<u64, String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        let mut n = 0u64;
        for item in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            n += copy_recursive(&item.path(), &dst.join(item.file_name()))?;
        }
        Ok(n)
    } else {
        std::fs::copy(src, dst).map_err(|e| e.to_string())?;
        Ok(src.metadata().map(|m| m.len()).unwrap_or(0))
    }
}

pub fn copy_entries(state: &AppState, paths: Vec<String>, dest: &str) -> Result<i32, String> {
    let root = state.ensure_open()?;
    let dest_p = PathBuf::from(dest);
    if !dest_p.is_dir() {
        return Err("目标目录不存在".into());
    }
    let mut count = 0;
    for p in paths {
        let src = PathBuf::from(&p);
        if !src.exists() {
            continue;
        }
        if is_descendant(&dest_p, &src) {
            return Err("不能复制目录到其自身子目录内".into());
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("无效路径")?;
        let target = unique_target(&dest_p, &name);
        let bytes = copy_recursive(&src, &target)?;
        count += 1;
        // 新增文件：目标位置各祖先目录占用实时增加，并为副本目录自身播种占用行
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        adjust_dir_sizes(conn, &root, &target, bytes as i64);
        let _ = conn.execute(
            "INSERT INTO dir_sizes (path, size) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET size = ?2",
            rusqlite::params![target.to_string_lossy(), bytes as i64],
        );
    }
    Ok(count)
}

// ---------- 回收站自动清除（1.0.2-r6） ----------
//
// 设计要点：
// 1) 到期时刻 `expire_at` 落库而非临场计算——设置面板随时可改，若按「当前设置 × deleted_at」
//    实时算，改一次设置就会让老条目提前/推后到期，用户看到的倒计时会跳变。落库后
//    「改设置只影响新删的条目」，语义稳定；而用户要求的「改设置后按当前时间重置」由
//    `set_trash_ttl_days` 显式重写全部在站条目完成。
// 2) `expire_at = 0` 表示永不自动清除（设置选「永不」）。
// 3) 清扫是惰性触发的（开库、列回收站），不开常驻定时器——应用没打开时不存在「到期」，
//    打开时扫一次即可；前台停留期间由 list_trash 自限频兜底。

const DAY_MS: i64 = 86_400_000;
pub const DEFAULT_TRASH_TTL_DAYS: i64 = 3;

/// 读取「回收站自动清除间隔天数」设置（1.0.2-r8 起存全局 prefs.json，切库不重置；
/// 非法值回落到默认 3 天；0 = 永不）
pub fn trash_ttl_days(state: &AppState) -> i64 {
    let s = state
        .prefs_path()
        .and_then(|p| crate::state::read_prefs_file(&p).get("trash_ttl_days").cloned())
        .unwrap_or_default();
    let n = s.trim().parse::<i64>().unwrap_or(DEFAULT_TRASH_TTL_DAYS);
    if n <= 0 {
        0
    } else {
        n.clamp(1, 3650)
    }
}

/// 写入设置（全局 prefs.json），**并把当前资料库回收站内所有条目的到期时间按
/// 当前时间重置**（用户改设置的即时效果）
pub fn set_trash_ttl_days(state: &AppState, days: i64) -> Result<(), String> {
    let days = if days <= 0 { 0 } else { days.clamp(1, 3650) };
    // 写入全局设置（不随资料库切换而变）
    let p = state.prefs_path().ok_or("全局设置不可用")?;
    let mut m = crate::state::read_prefs_file(&p);
    m.insert("trash_ttl_days".into(), days.to_string());
    crate::state::write_prefs_file(&p, &m);
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let now = now_ms();
    // 0 = 永不自动清除 → 到期时刻一并清零；否则从「此刻」重新计时
    if days == 0 {
        conn.execute("UPDATE trash_items SET expire_at = 0", [])
            .map_err(|e| e.to_string())?;
    } else {
        conn.execute("UPDATE trash_items SET expire_at = ?1", params![now + days * DAY_MS])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 删除已到期的回收站条目（真删，不可恢复）。返回清除条数。
pub fn sweep_expired_trash(state: &AppState) -> Result<usize, String> {
    let _root = match state.ensure_open() {
        Ok(r) => r,
        Err(_) => return Ok(0),
    };
    let now = now_ms();
    let ids: Vec<String> = {
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        let mut stmt = conn
            .prepare("SELECT id FROM trash_items WHERE expire_at > 0 AND expire_at <= ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![now], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    if ids.is_empty() {
        return Ok(0);
    }
    delete_forever(state, ids.clone())?;
    Ok(ids.len())
}

/// 上次清扫时刻（自限频：前台反复刷新回收站不会每次都查库删文件）
static LAST_TRASH_SWEEP: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// 带 30 秒自限频的清扫，挂在 list_trash 等高频路径上
pub fn maybe_sweep_expired_trash(state: &AppState) {
    let now = now_ms();
    let last = LAST_TRASH_SWEEP.load(std::sync::atomic::Ordering::Relaxed);
    if last > 0 && now - last < 30_000 {
        return;
    }
    LAST_TRASH_SWEEP.store(now, std::sync::atomic::Ordering::Relaxed);
    let _ = sweep_expired_trash(state);
}

pub fn delete_entries(state: &AppState, paths: Vec<String>) -> Result<(), String> {
    let root = state.ensure_open()?;
    let tdir = trash_dir(&root);
    std::fs::create_dir_all(&tdir).map_err(|e| format!("回收站不可用: {}", e))?;
    // 到期时刻在「移入回收站的那一刻」按当前设置算定；之后改设置不影响它（改设置会显式重置）
    let ttl = trash_ttl_days(state);
    let expire_at = if ttl <= 0 { 0 } else { now_ms() + ttl * DAY_MS };
    for p in paths {
        let src = PathBuf::from(&p);
        if !src.exists() {
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or("无效路径")?;
        let is_dir = src.is_dir();
        let size = if is_dir {
            dir_size(&src)
        } else {
            src.metadata().map(|m| m.len()).unwrap_or(0)
        };
        let id = format!("{}-{}", now_ms(), hash_hex(&[&p, &name, &now_ms().to_string()]));
        let target = tdir.join(format!("{}_{}", id, name));
        std::fs::rename(&src, &target)
            .map_err(|e| format!("移入回收站失败 {}: {}", name, e))?;
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        // 被收藏的路径（含其子级收藏）先搬入暂存表，恢复时搬回（分类归属一并暂存）
        conn.execute(
            "INSERT OR REPLACE INTO favorites_trash (path, name, added_at, cat_id)
             SELECT path, name, added_at, cat_id FROM favorites
             WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
            params![p],
        )
        .map_err(|e| e.to_string())?;
        // 被标记的路径（含子级显式标记）同样暂存，恢复时搬回
        conn.execute(
            "INSERT OR REPLACE INTO tags_trash (path, color)
             SELECT path, color FROM tags
             WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
            params![p],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO trash_items (id, orig_path, trash_path, name, is_dir, size, deleted_at, expire_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, p, target.to_string_lossy().to_string(), name, is_dir as i64, size as i64, now_ms(), expire_at],
        )
        .map_err(|e| e.to_string())?;
        crate::db::remove_refs(conn, &p)?;
        // 删除（移入回收站）：原位置各祖先目录占用实时减少
        adjust_dir_sizes(conn, &root, Path::new(&p), -(size as i64));
    }
    Ok(())
}

fn dir_size(p: &Path) -> u64 {
    walkdir::WalkDir::new(p)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

fn path_size(p: &Path, is_dir: bool) -> u64 {
    if is_dir {
        dir_size(p)
    } else {
        p.metadata().map(|m| m.len()).unwrap_or(0)
    }
}

/// 实时维护目录占用（dir_sizes 表）：文件/文件夹被删除、移出、移入、恢复时，
/// 沿其祖先链（与扫描聚合口径一致，根目录本身不计）增减对应大小。
/// 增量为负时下限钳 0；缺失的行（新建目录）以增量播种。全量扫描会重新校准。
pub fn adjust_dir_sizes(conn: &rusqlite::Connection, root: &Path, path: &Path, delta: i64) {
    if delta == 0 {
        return;
    }
    let mut anc = path.parent();
    while let Some(a) = anc {
        if a == root || !a.starts_with(root) {
            break;
        }
        let _ = conn.execute(
            "INSERT INTO dir_sizes (path, size) VALUES (?1, MAX(0, ?2))
             ON CONFLICT(path) DO UPDATE SET size = MAX(0, dir_sizes.size + ?2)",
            rusqlite::params![a.to_string_lossy(), delta],
        );
        anc = a.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjust_dir_sizes_upsert_and_clamp() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE dir_sizes (path TEXT PRIMARY KEY, size INTEGER NOT NULL)",
            [],
        )
        .unwrap();
        let root = Path::new("/lib");
        let sub = Path::new("/lib/movies");
        conn.execute("INSERT INTO dir_sizes (path, size) VALUES ('/lib/movies', 100)", []).unwrap();

        // +50：既有目录累加
        adjust_dir_sizes(&conn, root, &sub.join("a.mp4"), 50);
        let v: i64 = conn
            .query_row("SELECT size FROM dir_sizes WHERE path = '/lib/movies'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 150);

        // -200：钳 0 不为负
        adjust_dir_sizes(&conn, root, &sub.join("a.mp4"), -200);
        let v: i64 = conn
            .query_row("SELECT size FROM dir_sizes WHERE path = '/lib/movies'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 0);

        // 新目录（无行）以增量播种；多级祖先各自成行
        adjust_dir_sizes(&conn, root, &Path::new("/lib/new/nested/b.mp4"), 70);
        let v: i64 = conn
            .query_row("SELECT size FROM dir_sizes WHERE path = '/lib/new'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 70);
        let v: i64 = conn
            .query_row("SELECT size FROM dir_sizes WHERE path = '/lib/new/nested'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 70);

        // 根目录本身不写行（与扫描口径一致）
        adjust_dir_sizes(&conn, root, &Path::new("/lib/top.mp4"), 10);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM dir_sizes WHERE path = '/lib'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}

pub fn list_trash(state: &AppState) -> Result<Vec<TrashItem>, String> {
    // 1.0.2-r6：列回收站前先清掉已到期的（自限频 30s），用户看到的列表始终是最新的
    maybe_sweep_expired_trash(state);
    let (_, guard) = state.conn()?;
    let conn = guard.get()?;
    let mut stmt = conn
        .prepare("SELECT id, name, orig_path, trash_path, is_dir, size, deleted_at, expire_at FROM trash_items ORDER BY deleted_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TrashItem {
                id: r.get(0)?,
                name: r.get(1)?,
                orig_path: r.get(2)?,
                trash_path: r.get(3)?,
                is_dir: r.get::<_, i64>(4)? != 0,
                size: r.get::<_, i64>(5)?.max(0) as u64,
                deleted_at: r.get::<_, i64>(6)?.max(0),
                expire_at: r.get::<_, i64>(7)?.max(0),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

/// 回收站自动清除设置（供前端确认弹窗提示「xx 天后自动清除」）
pub fn trash_ttl_setting(state: &AppState) -> i64 {
    trash_ttl_days(state)
}

pub fn restore_trash(state: &AppState, ids: Vec<String>) -> Result<(), String> {
    let root = state.ensure_open()?;
    for id in ids {
        let (orig, tpath, tsize) = {
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            let row: Option<(String, String, i64)> = conn
                .query_row(
                    "SELECT orig_path, trash_path, size FROM trash_items WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            row.ok_or_else(|| format!("记录不存在: {}", id))?
        };
        let tp = PathBuf::from(&tpath);
        if !tp.exists() {
            let (_, guard) = state.conn()?;
            let _ = guard
                .get()?
                .execute("DELETE FROM trash_items WHERE id = ?1", params![id]);
            continue;
        }
        let orig_p = PathBuf::from(&orig);
        if let Some(parent) = orig_p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let final_target = if orig_p.exists() {
            let name = tp
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let real_name = name.splitn(2, '_').nth(1).unwrap_or(&name).to_string();
            let parent = orig_p.parent().unwrap_or(Path::new("/"));
            unique_target(parent, &real_name)
        } else {
            orig_p.clone()
        };
        std::fs::rename(&tp, &final_target).map_err(|e| format!("恢复失败: {}", e))?;
        // 从回收站还原后刷新修改时间
        let final_str = final_target.to_string_lossy().to_string();
        crate::util::touch_now(&final_str);
        // 恢复（等同于新增到原位置）：各祖先目录占用实时增加，并为目录自身播种占用行
        {
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            adjust_dir_sizes(conn, &root, &final_target, tsize);
            if tsize > 0 {
                let _ = conn.execute(
                    "INSERT INTO dir_sizes (path, size) VALUES (?1, ?2)
                     ON CONFLICT(path) DO UPDATE SET size = MAX(dir_sizes.size, ?2)",
                    rusqlite::params![final_target.to_string_lossy(), tsize],
                );
            }
        }
        // 搬回曾被收藏的路径（含子级），路径按实际恢复位置修正
        let fav_rows: Vec<String> = {
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            let mut stmt = conn
                .prepare(
                    "SELECT path FROM favorites_trash WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![orig], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };
        for old_fav in fav_rows {
            let new_fav = if old_fav == orig {
                final_str.clone()
            } else {
                format!("{}{}", final_str, &old_fav[orig.len()..])
            };
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            conn.execute(
                "INSERT OR REPLACE INTO favorites (path, name, added_at, cat_id)
                 SELECT ?2, name, added_at, cat_id FROM favorites_trash WHERE path = ?1",
                params![old_fav, new_fav],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM favorites_trash WHERE path = ?1", params![old_fav])
                .map_err(|e| e.to_string())?;
        }
        // 搬回曾被标记的路径（含子级显式标记），按实际恢复位置修正
        let tag_stash: Vec<String> = {
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            let mut stmt = conn
                .prepare(
                    "SELECT path FROM tags_trash WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![orig], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.flatten().collect()
        };
        for old_tag in tag_stash {
            let new_tag = if old_tag == orig {
                final_str.clone()
            } else {
                format!("{}{}", final_str, &old_tag[orig.len()..])
            };
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            conn.execute(
                "INSERT OR REPLACE INTO tags (path, color) SELECT ?2, color FROM tags_trash WHERE path = ?1",
                params![old_tag, new_tag],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM tags_trash WHERE path = ?1", params![old_tag])
                .map_err(|e| e.to_string())?;
        }
        let (_, guard) = state.conn()?;
        let _ = guard
            .get()?
            .execute("DELETE FROM trash_items WHERE id = ?1", params![id]);
    }
    Ok(())
}

pub fn delete_forever(state: &AppState, ids: Vec<String>) -> Result<(), String> {
    for id in ids {
        let (tpath, orig): (Option<String>, Option<String>) = {
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            let r = conn
                .query_row(
                    "SELECT trash_path, orig_path FROM trash_items WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            r.unwrap_or((None, None))
        };
        if let Some(tp) = tpath {
            let p = PathBuf::from(&tp);
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else if p.exists() {
                let _ = std::fs::remove_file(&p);
            }
            let (_, guard) = state.conn()?;
            let conn = guard.get()?;
            let _ = conn.execute(
                "DELETE FROM trash_items WHERE id = ?1",
                params![id],
            );
            // 彻底删除后暂存的收藏与标签一并清除
            if let Some(o) = orig {
                let _ = conn.execute(
                    "DELETE FROM favorites_trash WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
                    params![o],
                );
                let _ = conn.execute(
                    "DELETE FROM tags_trash WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
                    params![o],
                );
            }
        }
    }
    Ok(())
}

pub fn empty_trash(state: &AppState) -> Result<(), String> {
    let ids: Vec<String> = {
        let (_, guard) = state.conn()?;
        let conn = guard.get()?;
        let mut stmt = conn
            .prepare("SELECT id FROM trash_items")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    delete_forever(state, ids)?;
    // 清理无记录的遗留文件
    let root = state.ensure_open()?;
    let tdir = trash_dir(&root);
    if let Ok(rd) = std::fs::read_dir(&tdir) {
        for item in rd.flatten() {
            let p = item.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    // 回收站清空后暂存的收藏与标签全部清除
    let (_, guard) = state.conn()?;
    let _ = guard.get()?.execute("DELETE FROM favorites_trash", []);
    let _ = guard.get()?.execute("DELETE FROM tags_trash", []);
    Ok(())
}

// ---------- 字幕（1.0.2-r7 播放器字幕） ----------

const SUBTITLE_EXTS: [&str; 2] = ["srt", "vtt"];

/// 扫描视频同目录下与视频同名的 .srt/.vtt 字幕文件（含语言后缀，如 Movie.zh.srt、
/// Movie.en.vtt、Movie_zh-Hans.srt）。精确同名优先返回，不匹配其他视频的字幕。
pub fn probe_subtitles(video: &str) -> Vec<crate::types::SubtitleFile> {
    let p = Path::new(video);
    let dir = match p.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    if stem.is_empty() {
        return vec![];
    }
    let mut out = vec![];
    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for e in read_dir.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let Some(dot) = lower.rfind('.') else { continue };
        let ext = &lower[dot + 1..];
        if !SUBTITLE_EXTS.contains(&ext) {
            continue;
        }
        let base = &lower[..dot];
        // 前缀匹配：`Movie.srt` / `Movie.zh.srt` / `Movie_zh-Hans.vtt`
        if base != stem
            && !base.starts_with(&format!("{}.", stem))
            && !base.starts_with(&format!("{}_", stem))
        {
            continue;
        }
        out.push(crate::types::SubtitleFile {
            path: e.path().to_string_lossy().to_string(),
            name,
        });
    }
    // 精确同名（Movie.srt）最短，排最前
    out.sort_by(|a, b| a.name.len().cmp(&b.name.len()));
    out
}

/// 读取字幕文本并统一转为 UTF-8：按 BOM（UTF-8 / UTF-16LE / UTF-16BE）→ 严格 UTF-8 →
/// GBK（Windows 导出的 srt 常见）顺序解码，保证中文不乱码。
pub fn read_subtitle(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取字幕失败: {}", e))?;
    if bytes.len() >= 2 {
        if bytes[0] == 0xFF && bytes[1] == 0xFE {
            let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
            return Ok(cow.into_owned());
        }
        if bytes[0] == 0xFE && bytes[1] == 0xFF {
            let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
            return Ok(cow.into_owned());
        }
        if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
            return Ok(String::from_utf8_lossy(&bytes[3..]).into_owned());
        }
    }
    if let Ok(s) = String::from_utf8(bytes.clone()) {
        return Ok(s);
    }
    // 严格 UTF-8 失败 → 按 GBK（GB18030 超集）解码
    let (cow, _, _) = encoding_rs::GBK.decode(&bytes);
    Ok(cow.into_owned())
}

// ---------- 回收站自动清除（1.0.2-r6）单元测试 ----------
#[cfg(test)]
mod trash_ttl_tests {
    use super::*;
    use crate::state::AppState;

    fn tmp_lib(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vtm-trash-{}-{}-{}",
            tag,
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn trash_auto_purge_lifecycle() {
        const DAY: i64 = 86_400_000;
        let dir = tmp_lib("ttl");
        let state = AppState::new();
        state.open_library(&dir).unwrap();
        // 1.0.2-r8：设置存全局 prefs.json，测试注入隔离路径
        state.set_prefs_path(dir.join("prefs.json"));

        // 未设置时默认 3 天
        assert_eq!(trash_ttl_days(&state), DEFAULT_TRASH_TTL_DAYS);

        // 造文件并删入回收站
        let f = dir.join("a.txt");
        std::fs::write(&f, b"hello").unwrap();
        delete_entries(&state, vec![f.to_string_lossy().to_string()]).unwrap();
        assert!(!f.exists(), "文件应已移出原位置");

        let items = list_trash(&state).unwrap();
        assert_eq!(items.len(), 1);
        let it = &items[0];
        let now = now_ms();
        assert!(
            it.expire_at > now + 2 * DAY && it.expire_at <= now + 3 * DAY + 5_000,
            "默认应为 3 天后到期，实际 {}",
            it.expire_at - now
        );
        let trash_file = PathBuf::from(&it.trash_path);
        assert!(trash_file.exists());

        // 未到期：清扫不动
        assert_eq!(sweep_expired_trash(&state).unwrap(), 0);
        assert_eq!(list_trash(&state).unwrap().len(), 1);

        // 改成 7 天：在站条目的到期时间按「当前时间」重置
        set_trash_ttl_days(&state, 7).unwrap();
        assert_eq!(trash_ttl_days(&state), 7);
        let it = &list_trash(&state).unwrap()[0];
        assert!(it.expire_at > now_ms() + 6 * DAY, "改设置后应从此刻重新计时");

        // 设为 0（永不自动清除）：到期时刻清零，清扫不删
        set_trash_ttl_days(&state, 0).unwrap();
        assert_eq!(trash_ttl_days(&state), 0);
        assert_eq!(list_trash(&state).unwrap()[0].expire_at, 0);
        assert_eq!(sweep_expired_trash(&state).unwrap(), 0);
        assert_eq!(list_trash(&state).unwrap().len(), 1);

        // 手动把到期时刻拨到过去 → 清扫真删（文件与记录一起消失）
        {
            let (_, guard) = state.conn().unwrap();
            let conn = guard.get().unwrap();
            conn.execute(
                "UPDATE trash_items SET expire_at = ?1",
                params![now_ms() - 1],
            )
            .unwrap();
        }
        assert_eq!(sweep_expired_trash(&state).unwrap(), 1);
        assert!(list_trash(&state).unwrap().is_empty(), "到期条目应被清除");
        assert!(!trash_file.exists(), "到期条目应被真删而非只删记录");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---------- 字幕（1.0.2-r7）单元测试 ----------
#[cfg(test)]
mod subtitle_tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vtm-sub-{}-{}-{}",
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

    #[test]
    fn probe_subtitles_matches_same_dir_prefix() {
        let dir = tmp_dir("probe");
        std::fs::write(dir.join("Movie.mp4"), b"x").unwrap();
        std::fs::write(dir.join("Movie.srt"), b"x").unwrap();
        std::fs::write(dir.join("Movie.zh.srt"), b"x").unwrap();
        std::fs::write(dir.join("Movie.en.vtt"), b"x").unwrap();
        std::fs::write(dir.join("Other.srt"), b"x").unwrap(); // 别的视频字幕，不匹配
        std::fs::write(dir.join("Movie.jpg"), b"x").unwrap(); // 非字幕扩展，忽略
        std::fs::write(dir.join("Movie.en.srt.bak"), b"x").unwrap(); // 扩展名不是 srt/vtt

        let found = probe_subtitles(&dir.join("Movie.mp4").to_string_lossy());
        let names: Vec<&str> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(found.len(), 3, "应命中 Movie.srt / Movie.zh.srt / Movie.en.vtt，实际 {names:?}");
        assert!(names.contains(&"Movie.srt"));
        assert!(names.contains(&"Movie.zh.srt"));
        assert!(names.contains(&"Movie.en.vtt"));
        // 精确同名排最前
        assert_eq!(names[0], "Movie.srt");
        // 大小写不敏感
        let upper = probe_subtitles(&dir.join("MOVIE.MP4").to_string_lossy());
        assert_eq!(upper.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_subtitle_decodes_utf8_utf16_gbk() {
        let dir = tmp_dir("enc");
        // UTF-8
        let p1 = dir.join("a.srt");
        std::fs::write(&p1, "1\n00:00:01,000 --> 00:00:02,000\n你好，世界\n").unwrap();
        assert!(read_subtitle(&p1.to_string_lossy()).unwrap().contains("你好，世界"));
        // UTF-8 with BOM
        let p1b = dir.join("a2.srt");
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice("中文BOM".as_bytes());
        std::fs::write(&p1b, &bom).unwrap();
        assert!(read_subtitle(&p1b.to_string_lossy()).unwrap().contains("中文BOM"));
        // UTF-16LE with BOM
        let p2 = dir.join("b.srt");
        let mut data = vec![0xFF, 0xFE];
        for u in "测试字幕".encode_utf16() {
            data.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(&p2, &data).unwrap();
        assert!(read_subtitle(&p2.to_string_lossy()).unwrap().contains("测试字幕"));
        // UTF-16BE with BOM
        let p2b = dir.join("b2.srt");
        let mut data = vec![0xFE, 0xFF];
        for u in "倒序解码".encode_utf16() {
            data.extend_from_slice(&u.to_be_bytes());
        }
        std::fs::write(&p2b, &data).unwrap();
        assert!(read_subtitle(&p2b.to_string_lossy()).unwrap().contains("倒序解码"));
        // GBK（无 BOM，非 UTF-8）
        let p3 = dir.join("c.srt");
        let (gbk_bytes, _, _) = encoding_rs::GBK.encode("简体字幕");
        std::fs::write(&p3, &gbk_bytes).unwrap();
        assert!(read_subtitle(&p3.to_string_lossy()).unwrap().contains("简体字幕"));
        // 不存在的文件 → Err
        assert!(read_subtitle(&dir.join("nope.srt").to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
