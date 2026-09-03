use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub kind: String, // dir | video | image | audio | doc | other
    pub ext: String,
    pub size: u64,
    pub created_ms: i64,
    pub modified_ms: i64,
    pub cover: Option<String>,
    pub tag: Option<String>,    // 彩色标签：red/orange/yellow/green/blue/purple
    pub dir_size: Option<i64>,  // 文件夹占用（字节，来自索引聚合）
}

#[derive(Serialize, Clone, Debug)]
pub struct MediaTrack {
    pub kind: String,           // video | audio | subtitle
    pub codec: String,
    pub detail: String,         // 分辨率/声道/语言等
}

/// 视频同目录探测到的字幕文件（1.0.2-r7 播放器字幕）
#[derive(Serialize, Clone, Debug)]
pub struct SubtitleFile {
    pub path: String,
    pub name: String,
}

/// 字幕时间轴 cue（1.0.2-r7）：前端解析 .srt/.vtt 后随 PiP payload 传给独立窗口
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SubtitleCue {
    pub s: f64, // 开始时间（秒）
    pub e: f64, // 结束时间（秒）
    pub text: String,
}

/// PiP 窗口的字幕快照（1.0.2-r7）：主窗口打开全屏时把当前字幕状态整体带上
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PipSubtitleSnapshot {
    pub cues: Vec<SubtitleCue>,
    pub size: f64,
    pub enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct MediaInfo {
    pub container: String,
    pub duration: Option<f64>,
    pub bitrate: Option<u64>,
    pub size: u64,
    pub tracks: Vec<MediaTrack>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub taken_ms: Option<i64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<String>,
    pub aperture: Option<String>,
    pub shutter: Option<String>,
    pub focal: Option<String>,
    pub gps: Option<String>,
    pub created_ms: i64,
    pub modified_ms: i64,
    pub dir_size: Option<i64>,
    pub entry_count: Option<i64>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct OrganizePlanItem {
    pub from: String,
    pub to: String,
    pub name: String,
    pub conflict: bool, // 目标已存在同名文件
}

#[derive(Serialize, Clone, Debug)]
pub struct DirMeta {
    pub path: String,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub overview: Option<String>,
    pub rating: Option<f64>,
    pub tmdb_id: Option<i64>,
    pub poster_file: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DirListing {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    pub meta: Option<DirMeta>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TrashItem {
    pub id: String,
    pub name: String,
    pub orig_path: String,
    pub trash_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub deleted_at: i64,
    /// 1.0.2-r6：自动清除到期时刻（epoch ms）；0 = 永不自动清除
    pub expire_at: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct FavoriteItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub kind: String,
    pub cat_id: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct FavCategory {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchResult {
    pub path: String,
    pub parent: String,
    pub name: String,
    pub is_dir: bool,
    pub kind: String,
    pub size: u64,
    pub created_ms: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct InstalledApp {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct VideoInfo {
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
pub struct PhotoDate {
    pub path: String,
    pub taken_ms: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ScanStatus {
    pub running: bool,
    pub last_scan: Option<i64>,
    pub count: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Stats {
    pub files: i64,
    pub dirs: i64,
    pub videos: i64,
    pub images: i64,
    pub total_size: i64,
    pub last_scan: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TmdbMovie {
    pub id: i64,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i64>,
    pub overview: Option<String>,
    pub rating: Option<f64>,
    pub poster_url: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AppInfo {
    pub version: String,
    pub ffmpeg_ok: bool,
    pub home: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct LibraryCandidate {
    pub last: Option<String>,
    pub candidate: Option<String>,
}
