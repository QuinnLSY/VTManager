use crate::db;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

pub struct AppState {
    pub root: Mutex<Option<PathBuf>>,
    pub db: Mutex<Option<Connection>>,
    pub scanning: AtomicBool,
    /// 全局偏好文件（应用数据目录 prefs.json，1.0.2-r8 起承载**全部应用设置**）。
    /// 与资料库无关——切换根目录只是换 db 连接，prefs 不重置。
    prefs_path: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            root: Mutex::new(None),
            db: Mutex::new(None),
            scanning: AtomicBool::new(false),
            prefs_path: Mutex::new(None),
        }
    }

    /// 注入全局偏好文件路径（应用启动时由 setup 调用，拿到 app_data_dir）
    pub fn set_prefs_path(&self, p: PathBuf) {
        *self.prefs_path.lock().unwrap() = Some(p);
    }

    pub fn prefs_path(&self) -> Option<PathBuf> {
        self.prefs_path.lock().unwrap().clone()
    }

    pub fn open_library(&self, root: &Path) -> Result<(), String> {
        let vtm = vtm_dir(root);
        std::fs::create_dir_all(vtm.join("covers"))
            .map_err(|e| format!("创建数据目录失败: {}", e))?;
        std::fs::create_dir_all(vtm.join("cache").join("thumbs"))
            .map_err(|e| format!("创建缓存目录失败: {}", e))?;
        std::fs::create_dir_all(vtm.join(".trash"))
            .map_err(|e| format!("创建回收站失败: {}", e))?;
        let conn = db::open(&vtm.join("vtmanager.db"))?;
        *self.root.lock().unwrap() = Some(root.to_path_buf());
        *self.db.lock().unwrap() = Some(conn);
        Ok(())
    }

    pub fn ensure_open(&self) -> Result<PathBuf, String> {
        let root = self.root.lock().unwrap().clone().ok_or("尚未打开资料库")?;
        if self.db.lock().unwrap().is_none() {
            let conn = db::open(&vtm_dir(&root).join("vtmanager.db"))?;
            *self.db.lock().unwrap() = Some(conn);
        }
        Ok(root)
    }

    /// 返回 (资料库根目录, 数据库连接守卫)
    pub fn conn(&self) -> Result<(PathBuf, DbGuard<'_>), String> {
        let root = self.ensure_open()?;
        let guard = DbGuard(self.db.lock().unwrap());
        Ok((root, guard))
    }
}

pub struct DbGuard<'a>(MutexGuard<'a, Option<Connection>>);

impl<'a> DbGuard<'a> {
    pub fn get(&self) -> Result<&Connection, String> {
        self.0.as_ref().ok_or_else(|| "数据库未打开".to_string())
    }
}

pub fn vtm_dir(root: &Path) -> PathBuf {
    root.join(".VTManager")
}

// ---------- 全局偏好读写（1.0.2-r8） ----------
//
// prefs.json 存在应用数据目录，承载**所有应用设置**（原库级 settings 表在
// 1.0.2-r8 起只作一次性迁移来源）。主题（theme）自更早版本起就走这里。
// 与资料库无关：open_library 切换根目录只换库内 db 连接，prefs 保持不变，
// 因此「回收站自动清除天数」「缓存保留时长」等设置不会随切库被重置。
//
// 主窗口与 PiP 独立窗口都可能写入，读-改-写序列必须互斥（PREFS_LOCK）；
// 写文件用 .tmp + rename 原子替换，避免进程中断留下半截 JSON 导致设置全丢。

static PREFS_LOCK: Mutex<()> = Mutex::new(());

pub fn read_prefs_file(p: &Path) -> HashMap<String, String> {
    let _g = PREFS_LOCK.lock().unwrap();
    let s = match std::fs::read_to_string(p) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str::<HashMap<String, String>>(&s).unwrap_or_default()
}

pub fn write_prefs_file(p: &Path, m: &HashMap<String, String>) {
    let _g = PREFS_LOCK.lock().unwrap();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(s) = serde_json::to_string_pretty(m) else {
        return;
    };
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, &s).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}

pub fn covers_dir(root: &Path) -> PathBuf {
    vtm_dir(root).join("covers")
}

pub fn cache_dir(root: &Path) -> PathBuf {
    vtm_dir(root).join("cache")
}

pub fn thumbs_dir(root: &Path) -> PathBuf {
    cache_dir(root).join("thumbs")
}

pub fn previews_dir(root: &Path) -> PathBuf {
    cache_dir(root).join("previews")
}

pub fn remux_dir(root: &Path) -> PathBuf {
    cache_dir(root).join("remux")
}

/// 进度条悬停帧预览精灵图（1.0.2-r5）：每部视频一张网格图 + 一份元数据 JSON
pub fn scrubs_dir(root: &Path) -> PathBuf {
    cache_dir(root).join("scrubs")
}

pub fn trash_dir(root: &Path) -> PathBuf {
    vtm_dir(root).join(".trash")
}
