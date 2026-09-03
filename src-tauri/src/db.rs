use rusqlite::Connection;
use std::path::Path;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS covers (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cover_file TEXT NOT NULL,
  source TEXT,
  frame_time REAL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS dir_meta (
  path TEXT PRIMARY KEY,
  title TEXT,
  year INTEGER,
  overview TEXT,
  rating REAL,
  tmdb_id INTEGER,
  poster_file TEXT,
  extra TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS index_entries (
  path TEXT PRIMARY KEY,
  parent TEXT NOT NULL,
  name TEXT NOT NULL,
  name_py TEXT,
  py_initial TEXT,
  is_dir INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ext TEXT,
  size INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT 0,
  modified_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_index_parent ON index_entries(parent);
CREATE INDEX IF NOT EXISTS idx_index_name ON index_entries(name);
CREATE TABLE IF NOT EXISTS favorites (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  added_at INTEGER,
  cat_id INTEGER NOT NULL DEFAULT 0
);
-- 收藏暂存：文件被删入回收站时搬入，恢复时搬回，彻底删除时清除
CREATE TABLE IF NOT EXISTS favorites_trash (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  added_at INTEGER,
  cat_id INTEGER NOT NULL DEFAULT 0
);
-- 收藏夹分类（cat_id = 0 表示收藏夹根目录）
CREATE TABLE IF NOT EXISTS fav_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER
);
-- 彩色标签
CREATE TABLE IF NOT EXISTS tags (
  path TEXT PRIMARY KEY,
  color TEXT NOT NULL
);
-- 标签暂存：被标记项删入回收站时搬入，恢复时搬回，彻底删除时清除
CREATE TABLE IF NOT EXISTS tags_trash (
  path TEXT PRIMARY KEY,
  color TEXT NOT NULL
);
-- 目录占用大小（扫描索引时聚合，单位字节）
CREATE TABLE IF NOT EXISTS dir_sizes (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trash_items (
  id TEXT PRIMARY KEY,
  orig_path TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL,
  size INTEGER DEFAULT 0,
  deleted_at INTEGER,
  -- 1.0.2-r6：自动清除到期时刻（epoch ms）；0 = 永不自动清除
  expire_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
"#;

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开数据库失败: {}", e))?;
    // 性能优化（1.0.1-r13）：WAL 模式让浏览（读）与扫描/写入并发不互锁，
    // NORMAL 同步级在掉电安全前提下减少 fsync 次数，busy_timeout 避免并发写报「数据库被锁」。
    // 1.0.2 追加：cache_size 扩大页缓存（8MB）提升频繁查询命中率；
    // mmap_size 让大范围顺序读（全库扫描/统计）走内存映射，减少 syscall。
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; \
         PRAGMA synchronous=NORMAL; \
         PRAGMA busy_timeout=5000; \
         PRAGMA foreign_keys=ON; \
         PRAGMA cache_size=-8000; \
         PRAGMA mmap_size=268435456;",
    )
    .map_err(|e| format!("初始化数据库 PRAGMA 失败: {}", e))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("初始化数据库失败: {}", e))?;
    migrate(&conn)?;
    Ok(conn)
}

/// 旧库升级：为收藏相关表补 cat_id 列（CREATE TABLE IF NOT EXISTS 不会改动已存在的表）
fn migrate(conn: &Connection) -> Result<(), String> {
    for table in ["favorites", "favorites_trash"] {
        if !has_column(conn, table, "cat_id")? {
            conn.execute(
                &format!("ALTER TABLE {} ADD COLUMN cat_id INTEGER NOT NULL DEFAULT 0", table),
                [],
            )
            .map_err(|e| format!("升级 {} 表失败: {}", table, e))?;
        }
    }
    // 1.0.2-r6：回收站条目增加「自动清除到期时刻」（旧库补列；默认 0 = 永不自动清除）
    if !has_column(conn, "trash_items", "expire_at")? {
        conn.execute(
            "ALTER TABLE trash_items ADD COLUMN expire_at INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("升级 trash_items 表失败: {}", e))?;
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, col: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(names.iter().any(|n| n == col))
}

/// 重命名/移动后同步更新数据库中的路径引用（含子级）
/// Windows 下路径分隔符为 `\`，索引中两种分隔符都可能出现，因此各做一次替换
pub fn rename_refs(conn: &Connection, old: &str, new: &str) -> Result<(), String> {
    // Windows 分支会再 push 一组「反斜杠转正斜杠」变体；非 Windows 下 mut 无用，抑制警告
    #[allow(unused_mut)]
    let mut variants = vec![(old.to_string(), new.to_string())];
    #[cfg(target_os = "windows")]
    {
        let o2 = old.replace('\\', "/");
        let n2 = new.replace('\\', "/");
        if o2 != old {
            variants.push((o2, n2));
        }
    }
    for (o, n) in variants {
        rename_refs_once(conn, &o, &n)?;
    }
    Ok(())
}

fn rename_refs_once(conn: &Connection, old: &str, new: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE index_entries SET path = ?2 || substr(path, length(?1)+1)
         WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
        rusqlite::params![old, new],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE index_entries SET parent = ?2 WHERE parent = ?1",
        rusqlite::params![old, new],
    )
    .map_err(|e| e.to_string())?;
    // 直接受影响项的显示名同步为新 basename
    let new_name = std::path::Path::new(new)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    conn.execute(
        "UPDATE index_entries SET name = ?2 WHERE path = ?1",
        rusqlite::params![new, new_name],
    )
    .map_err(|e| e.to_string())?;
    for sql in [
        "UPDATE covers SET path = ?2 WHERE path = ?1",
        "UPDATE dir_meta SET path = ?2 WHERE path = ?1",
    ] {
        conn.execute(sql, rusqlite::params![old, new])
            .map_err(|e| e.to_string())?;
    }
    // tags：精确路径 + 子级标记路径都同步到新位置（子级颜色为继承/显式标记，需跟随移动）
    conn.execute(
        "UPDATE tags SET path = ?2 WHERE path = ?1",
        rusqlite::params![old, new],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tags SET path = ?2 || substr(path, length(?1)+1)
         WHERE length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/'",
        rusqlite::params![old, new],
    )
    .map_err(|e| e.to_string())?;
    // dir_sizes：被移动目录自身及其子目录的占用行同步迁移（大小不变，祖先链增减由调用方处理）
    conn.execute(
        "UPDATE dir_sizes SET path = ?2 || substr(path, length(?1)+1)
         WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
        rusqlite::params![old, new],
    )
    .map_err(|e| e.to_string())?;
    // favorites：精确路径 + 子级收藏路径都同步到新位置
    conn.execute(
        "UPDATE favorites SET path = ?2 WHERE path = ?1",
        rusqlite::params![old, new],
    )
    .map_err(|e| e.to_string())?;
    // 直接受影响的收藏项显示名同步为新 basename（侧边栏与分类内展示用）
    conn.execute(
        "UPDATE favorites SET name = ?2 WHERE path = ?1",
        rusqlite::params![new, new_name],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE favorites SET path = ?2 || substr(path, length(?1)+1)
         WHERE length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/'",
        rusqlite::params![old, new],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn remove_refs(conn: &Connection, path: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM index_entries WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
        rusqlite::params![path],
    )
    .map_err(|e| e.to_string())?;
    for sql in [
        "DELETE FROM covers WHERE path = ?1",
        "DELETE FROM dir_meta WHERE path = ?1",
    ] {
        conn.execute(sql, rusqlite::params![path])
            .map_err(|e| e.to_string())?;
    }
    // favorites：精确路径 + 子级收藏一并删除（进入回收站前已由调用方暂存到 favorites_trash）
    conn.execute(
        "DELETE FROM favorites WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
        rusqlite::params![path],
    )
    .map_err(|e| e.to_string())?;
    // tags：显式标记（含子级）删除；进入回收站前已由调用方暂存到 tags_trash
    conn.execute(
        "DELETE FROM tags WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
        rusqlite::params![path],
    )
    .map_err(|e| e.to_string())?;
    // dir_sizes：被删目录自身及其子目录的占用行一并清理，避免孤儿数据
    conn.execute(
        "DELETE FROM dir_sizes WHERE path = ?1 OR (length(path) > length(?1) AND substr(path, 1, length(?1)+1) = ?1 || '/')",
        rusqlite::params![path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
