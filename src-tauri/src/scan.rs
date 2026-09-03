use crate::state::AppState;
use crate::util::{ext_of, is_hidden, kind_of, now_ms};
use pinyin::ToPinyin;
use rusqlite::params;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

fn py_fields(name: &str) -> (String, String) {
    let has_cjk = name.chars().any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c));
    if !has_cjk {
        let l = name.to_lowercase();
        return (l.clone(), l);
    }
    let mut full = String::new();
    let mut ini = String::new();
    for (c, p) in name.chars().zip(name.to_pinyin()) {
        match p {
            Some(py) => {
                let s = py.plain();
                full.push_str(s);
                if let Some(f) = s.chars().next() {
                    ini.push(f);
                }
            }
            None => {
                let l = c.to_ascii_lowercase();
                full.push(l);
                if l.is_alphanumeric() {
                    ini.push(l);
                }
            }
        }
    }
    (full, ini)
}

pub fn start_scan(app: AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    if st.scanning.load(Ordering::SeqCst) {
        return Err("正在扫描中，请稍候".into());
    }
    let root = st.ensure_open()?;
    st.scanning.store(true, Ordering::SeqCst);
    // 扫描会重建索引与目录占用：作废目录列表缓存，避免扫描期间/结束后返回旧占用
    crate::cache::invalidate_dir_cache();
    std::thread::spawn(move || {
        let result = scan_tree(&app, &root);
        let st = app.state::<AppState>();
        st.scanning.store(false, Ordering::SeqCst);
        crate::cache::invalidate_dir_cache();
        let payload = match result {
            Ok(n) => serde_json::json!({ "count": n }),
            Err(e) => serde_json::json!({ "error": e }),
        };
        let _ = app.emit("scan-done", payload);
    });
    Ok(())
}

fn scan_tree(app: &AppHandle, root: &Path) -> Result<u64, String> {
    let st = app.state::<AppState>();
    let (_, guard) = st.conn()?;
    let conn = guard.get()?;
    // 性能优化（1.0.1-r13）：增量扫描 —— 读取现有索引的 (path -> modified_at) 快照，
    // 遍历时 mtime 未变化的条目直接跳过（不写库），只在最后清理「消失」的条目。
    // 首次扫描（索引为空）时退化为全量插入，行为与旧版一致。
    let mut existing: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT path, modified_at FROM index_entries")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            if let Ok((p, m)) = row {
                existing.insert(p, m);
            }
        }
    }
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_scan', ?1)",
        params![now_ms().to_string()],
    )
    .ok();

    let mut count: u64 = 0;
    let mut buf: Vec<(String, String, String, String, String, i64, String, String, i64, i64, i64)> = Vec::new();
    let mut dir_agg: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut last_emit = now_ms();

    let flush = |conn: &rusqlite::Connection,
                 buf: &mut Vec<(String, String, String, String, String, i64, String, String, i64, i64, i64)>|
     -> Result<(), String> {
        conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
        for row in buf.iter() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO index_entries (path, parent, name, name_py, py_initial, is_dir, kind, ext, size, created_at, modified_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10],
            );
        }
        conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
        buf.clear();
        Ok(())
    };

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|n| !is_hidden(n, e.path()))
                .unwrap_or(false)
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path == root {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(md) = entry.metadata() else { continue };
        let is_dir = md.is_dir();
        let path_str = path.to_string_lossy().to_string();
        let parent = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // 增量命中：mtime 未变 → 跳过写库（目录大小聚合仍需完整统计）
        if let Some(prev_m) = existing.get(&path_str) {
            if *prev_m == modified {
                existing.remove(&path_str);
                if !is_dir {
                    let fsize = md.len() as i64;
                    let mut anc = path.parent();
                    while let Some(a) = anc {
                        if a == root {
                            break;
                        }
                        *dir_agg.entry(a.to_string_lossy().to_string()).or_insert(0) += fsize;
                        anc = a.parent();
                    }
                }
                continue;
            }
        }
        let (py, ini) = py_fields(&name);
        let created = md
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(|| {
                md.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            });
        let kind = kind_of(&name, is_dir);
        let ext = if is_dir { String::new() } else { ext_of(&name) };
        if !is_dir {
            // 文件大小累加到所有祖先目录（用于文件夹占用显示）
            let fsize = md.len() as i64;
            let mut anc = path.parent();
            while let Some(a) = anc {
                if a == root {
                    break;
                }
                *dir_agg
                    .entry(a.to_string_lossy().to_string())
                    .or_insert(0) += fsize;
                anc = a.parent();
            }
        }
        buf.push((
            path_str,
            parent,
            name,
            py,
            ini,
            is_dir as i64,
            kind,
            ext,
            md.len() as i64,
            created,
            modified,
        ));
        count += 1;
        if buf.len() >= 500 {
            flush(conn, &mut buf)?;
        }
        let now = now_ms();
        if now - last_emit > 400 {
            last_emit = now;
            let _ = app.emit(
                "scan-progress",
                serde_json::json!({ "count": count, "current": path.to_string_lossy() }),
            );
            // 让 DB 写入不至于长时间独占
            let _ = std::io::stdout().flush();
        }
    }
    flush(conn, &mut buf)?;
    // 清理「消失」的条目：本次遍历未命中的旧索引（文件被删/移动/改名）
    if !existing.is_empty() {
        conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("DELETE FROM index_entries WHERE path = ?1")
            .map_err(|e| e.to_string())?;
        let mut removed: u64 = 0;
        for p in existing.keys() {
            let _ = stmt.execute(params![p]);
            removed += 1;
        }
        conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
        count += removed;
    }
    // 写入目录占用聚合（dir_sizes 全量重建，与全量扫描口径一致）
    conn.execute("DELETE FROM dir_sizes", [])
        .map_err(|e| e.to_string())?;
    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    for (p, s) in dir_agg.iter() {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO dir_sizes (path, size) VALUES (?1, ?2)",
            params![p, s],
        );
    }
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    Ok(count)
}
