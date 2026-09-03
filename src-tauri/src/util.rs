use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "webm", "ts", "mpg", "mpeg", "rmvb", "rm",
    "3gp", "vob", "m2ts", "f4v", "ogv", "asf", "divx", "m4p", "mxf",
];
pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "heic", "heif", "svg", "avif",
    "jfif", "ico", "avifs",
];

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把文件/目录的修改时间刷新为当前时间（重命名、移动、还原、标记等操作后调用，
/// 让「修改时间」反映最近一次管理操作；失败静默忽略，不影响主流程）
pub fn touch_now(path: &str) {
    let ft = filetime::FileTime::from_system_time(SystemTime::now());
    let _ = filetime::set_file_mtime(path, ft);
}

/// 解析 ISO8601 时间字符串（如 2024-01-02T03:04:05.123Z / 2024-01-02 03:04:05）
/// 为 epoch 毫秒（按 UTC 处理，忽略时区偏移）；格式不符返回 None
pub fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || se > 60 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    let mut ms = ((days * 24 + h) * 60 + mi) * 60 * 1000 + se * 1000;
    if b.len() > 20 && b[19] == b'.' {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if !frac.is_empty() {
            let mut f = frac;
            while f.len() < 3 {
                f.push('0');
            }
            ms += f[..3].parse::<i64>().unwrap_or(0);
        }
    }
    Some(ms)
}

/// 公历转自 1970-01-01 起的天数（Howard Hinnant days_from_civil 算法）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn hash_hex(parts: &[&str]) -> String {
    let mut h = DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}

pub fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn kind_of(name: &str, is_dir: bool) -> String {
    if is_dir {
        return "dir".into();
    }
    let e = ext_of(name);
    if VIDEO_EXTS.contains(&e.as_str()) {
        "video".into()
    } else if IMAGE_EXTS.contains(&e.as_str()) {
        "image".into()
    } else if ["mp3", "flac", "aac", "wav", "m4a", "ogg", "ape"].contains(&e.as_str()) {
        "audio".into()
    } else if ["pdf", "doc", "docx", "xls", "xlsx", "txt", "md", "srt", "ass", "ssa"].contains(&e.as_str()) {
        "doc".into()
    } else {
        "other".into()
    }
}

/// 校验新文件/目录名：不允许路径分隔符与非法字符
pub fn validate_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名称不能为空".into());
    }
    if n == "." || n == ".." {
        return Err("名称不合法".into());
    }
    if n.contains('/') || n.contains('\\') || n.contains(':') || n.contains('\0') {
        return Err("名称不能包含 / \\ : 等字符".into());
    }
    #[cfg(target_os = "windows")]
    for c in ['*', '?', '"', '<', '>', '|'] {
        if n.contains(c) {
            return Err(format!("名称不能包含字符 {}", c));
        }
    }
    Ok(())
}

const SKIP_ENTRY_NAMES: &[&str] = &["System Volume Information", "$RECYCLE.BIN"];

/// 隐藏/系统文件判断（跨平台）
pub fn is_hidden(name: &str, path: &Path) -> bool {
    if name.starts_with('.') {
        return true;
    }
    if SKIP_ENTRY_NAMES.contains(&name) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        if name.eq_ignore_ascii_case("desktop.ini") {
            return true;
        }
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(md) = path.metadata() {
            if md.attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
                return true;
            }
        }
    }
    let _ = path;
    false
}

/// 目标重名时自动追加 " (2)"、" (3)"...
pub fn unique_target(dir: &Path, name: &str) -> std::path::PathBuf {
    let mut target = dir.join(name);
    if !target.exists() {
        return target;
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..10000 {
        target = dir.join(format!("{} ({}){}", stem, i, ext));
        if !target.exists() {
            return target;
        }
    }
    target
}

/// "YYYY:MM:DD HH:MM:SS" -> epoch ms（无时区修正，按本地日期理解）
pub fn parse_exif_datetime(s: &str) -> Option<i64> {
    let s = s.trim();
    let parts: Vec<&str> = s.splitn(2, ' ').collect();
    if parts.len() < 2 {
        return None;
    }
    let d: Vec<i64> = parts[0].split(':').filter_map(|x| x.parse().ok()).collect();
    let t: Vec<i64> = parts[1].split(':').filter_map(|x| x.parse().ok()).collect();
    if d.len() < 3 || t.len() < 3 {
        return None;
    }
    let (y, mo, da) = (d[0], d[1], d[2]);
    let (hh, mm, ss) = (t[0], t[1], t[2]);
    if !(1..=12).contains(&mo)
        || !(1..=31).contains(&da)
        || !(0..=23).contains(&hh)
        || !(0..=59).contains(&mm)
        || !(0..=60).contains(&ss)
        || !(1..=9999).contains(&y)
    {
        return None;
    }
    Some(civil_to_ms(y, mo, da, hh, mm, ss))
}

pub fn civil_to_ms(y: i64, m: i64, d: i64, hh: i64, mm: i64, ss: i64) -> i64 {
    // Howard Hinnant's days_from_civil
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    (days * 86400 + hh * 3600 + mm * 60 + ss) * 1000
}

/// epoch ms -> (年, 月)（本地日期理解，用于按日期归类）
pub fn ms_to_ym(ms: i64) -> (i64, i64) {
    let days = ms.div_euclid(86400_000);
    // civil_from_days
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let _d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m)
}
