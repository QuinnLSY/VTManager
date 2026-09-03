use crate::state::{previews_dir, scrubs_dir, thumbs_dir};
use crate::types::VideoInfo;
use crate::util::{hash_hex, parse_exif_datetime};
use image::ImageDecoder;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

/// 解析 ffmpeg / ffprobe 可执行文件路径：
/// 1. 环境变量 VT_FFMPEG_DIR
/// 2. 应用可执行文件同目录（.app/Contents/MacOS，由打包脚本放入）
/// 3. 开发模式：项目 bin/ 目录
pub fn tool_path(name: &str) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("VT_FFMPEG_DIR") {
        for n in [name.to_string(), format!("{}.exe", name)] {
            let p = Path::new(&dir).join(&n);
            if p.exists() {
                return Ok(p);
            }
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(dir) = exe.parent() {
        for n in [name.to_string(), format!("{}.exe", name)] {
            let p = dir.join(&n);
            if p.exists() {
                return Ok(p);
            }
        }
        if let Some(fw) = dir.parent() {
            for n in [name.to_string(), format!("{}.exe", name)] {
                let p = fw.join("Resources").join(&n);
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../bin").join(name);
    if dev.exists() {
        return Ok(dev);
    }
    let dev_exe = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../bin")
        .join(format!("{}.exe", name));
    if dev_exe.exists() {
        return Ok(dev_exe);
    }
    Err(format!("未找到 {}，请确保 ffmpeg 随应用分发", name))
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| format!("启动进程失败: {}", e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("执行失败").to_string())
    }
}

pub fn ffprobe_info(path: &str) -> VideoInfo {
    let empty = VideoInfo { duration: None, width: None, height: None };
    // 1.0.2：优先走 AVFoundation（macOS 原生，无外部进程开销，读取更快）；
    // 失败（非 macOS / 不支持的容器）回退 ffprobe。
    if crate::av::available() {
        if let Some(info) = crate::av::probe(path) {
            return VideoInfo {
                duration: info.duration,
                width: info.width,
                height: info.height,
            };
        }
    }
    let Some(v) = ffprobe_raw(path) else { return empty };
    let duration = v["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| v["format"]["duration"].as_f64());
    let mut width = None;
    let mut height = None;
    if let Some(streams) = v["streams"].as_array() {
        for s in streams {
            if s["codec_type"] == "video" {
                width = s["width"].as_u64().map(|x| x as u32);
                height = s["height"].as_u64().map(|x| x as u32);
                break;
            }
        }
    }
    VideoInfo { duration, width, height }
}

/// ffprobe 原始 JSON（媒体详情面板用）
pub fn ffprobe_raw(path: &str) -> Option<serde_json::Value> {
    let tool = tool_path("ffprobe").ok()?;
    let out = Command::new(tool)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

pub fn capture_frame(video: &str, time: f64, out: &Path) -> Result<(), String> {
    let tool = tool_path("ffmpeg")?;
    let t = time.max(0.0).to_string();
    let r = run(Command::new(&tool).args([
        "-y", "-ss", &t, "-i", video, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3",
    ]).arg(out));
    if r.is_err() && time > 0.0 {
        // 指定时间点可能超出视频末尾，回退到开头
        return run(Command::new(&tool).args([
            "-y", "-ss", "0", "-i", video, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3",
        ]).arg(out));
    }
    r
}

/// 原分辨率 PNG 截帧（1.0.2-r7 播放器截图，AVFoundation 失败时的 ffmpeg 回退路径）。
/// 不带 scale 滤镜（保留原始分辨率），输出格式由扩展名 .png 决定。
pub fn capture_frame_png(video: &str, time: f64, out: &Path) -> Result<(), String> {
    let tool = tool_path("ffmpeg")?;
    let t = time.max(0.0).to_string();
    let r = run(Command::new(&tool).args([
        "-y", "-ss", &t, "-i", video, "-frames:v", "1",
    ]).arg(out));
    if r.is_err() && time > 0.0 {
        // 指定时间点可能超出视频末尾，回退到开头
        return run(Command::new(&tool).args([
            "-y", "-ss", "0", "-i", video, "-frames:v", "1",
        ]).arg(out));
    }
    r
}

fn ensure_thumb_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = thumbs_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {}", e))?;
    Ok(dir)
}

/// 图片解码尺寸上限（1.0.2 内存优化）：超过此限制的图片解码直接失败并返回占位图标，
/// 避免数亿像素的大图全尺寸解码时产生数百 MB 甚至 GB 级的内存峰值。
pub const DECODE_MAX_DIM: u32 = 16384;

/// 为解码器设置统一的内存/尺寸防御上限（超大图拒绝解码）
fn apply_decode_limits(decoder: &mut impl image::ImageDecoder) {
    use image::Limits;
    let mut limits = Limits::default();
    limits.max_image_width = Some(DECODE_MAX_DIM);
    limits.max_image_height = Some(DECODE_MAX_DIM);
    // 内存上限：解码缓冲区 ≤ 512MB（16384×16384×4 ≈ 1GB，这里再收紧为 512MB）
    limits.max_alloc = Some(512 * 1024 * 1024);
    let _ = decoder.set_limits(limits);
}

/// 以 WebP 有损编码保存图片（1.0.2：缩略图/预览缓存从 JPEG 迁移到 WebP——
/// 体积降约 40%、解码更快、内存更低；WKWebView/Safari 14+ 原生支持）。
/// quality 0.0..=100.0（libwebp）；写临时文件再 rename，避免半截文件被当作有效缓存。
fn save_webp(img: &image::DynamicImage, path: &Path, quality: f32) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let tmp = path.with_extension("tmp");
    let rgb = img.to_rgb8();
    let enc = webp::Encoder::from_rgb(&rgb, rgb.width(), rgb.height());
    let data = enc.encode(quality);
    std::fs::write(&tmp, &*data).map_err(|e| format!("写入失败: {}", e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存失败: {}", e))?;
    Ok(())
}

pub fn image_thumb(root: &Path, path: &Path, mtime_ms: i64) -> Result<PathBuf, String> {
    let dir = ensure_thumb_dir(root)?;
    let key = hash_hex(&[&path.to_string_lossy(), &mtime_ms.to_string()]);
    // 1.0.2：WebP 后缀；旧 JPEG 缓存文件不冲突（hash 唯一），残留会被缓存清理统一回收
    let out = dir.join(format!("{}.webp", key));
    if out.exists() {
        crate::cache::touch_cache_file(&out); // 命中即续期（1.0.2-r4 缓存过期清理依据 mtime）
        return Ok(out);
    }
    let file = std::fs::File::open(path).map_err(|e| format!("打开图片失败: {}", e))?;
    let reader = image::ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    apply_decode_limits(&mut decoder);
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("解码图片失败（该格式可能不被支持）: {}", e))?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    let thumb = img.thumbnail(THUMB_MAX, THUMB_MAX);
    save_webp(&thumb, &out, THUMB_QUALITY)?;
    Ok(out)
}

/// 缩略图最长边（1.0.2-r4 不变）与 WebP 质量（80 → 70）：
/// 缩略图数量 = 媒体文件数，是最占"条目数"的一类缓存；q70 在 480px 尺寸下
/// 肉眼几乎无差别，体积再降约 25%。
pub const THUMB_MAX: u32 = 480;
pub const THUMB_QUALITY: f32 = 70.0;

pub fn video_thumb(root: &Path, path: &str, mtime_ms: i64) -> Result<PathBuf, String> {
    let dir = ensure_thumb_dir(root)?;
    let key = hash_hex(&[path, &mtime_ms.to_string()]);
    let out = dir.join(format!("{}.jpg", key));
    if out.exists() {
        crate::cache::touch_cache_file(&out); // 命中即续期
        return Ok(out);
    }
    let info = ffprobe_info(path);
    let base = info.duration.unwrap_or(10.0);
    let tmp = dir.join(format!(".{}.tmp.jpg", key));
    let mut last_err = String::new();
    for frac in [0.25, 0.05, 0.0] {
        let t = (base * frac).max(0.0);
        // 1.0.2：主路径用 AVFoundation 截帧（原生、更快、无进程开销），
        // 失败再回退 ffmpeg（mkv/avi 等系统不直接支持的容器、损坏文件等）。
        let r = if crate::av::available() {
            crate::av::capture_frame(path, t, &tmp, 640)
                .or_else(|_| capture_frame(path, t, &tmp))
        } else {
            capture_frame(path, t, &tmp)
        };
        match r {
            Ok(()) => {
                std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
                return Ok(out);
            }
            Err(e) => last_err = e,
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(format!("生成视频缩略图失败: {}", last_err))
}

// ---------- 1.0.2-r5：进度条悬停帧预览（scrub sprite sheet） ----------
// 播放器时间轴上悬停时显示鼠标所在时间的画面。为避免每次悬停都抽帧
// （ffmpeg 单帧 seek 约 100-300ms，拖动时完全跟不上），采用「精灵图」方案：
// 打开播放器后按 ~10s 间隔把全片抽成 ≤120 张 160×90 贴片，拼成一张网格图
// 缓存到 cache/scrubs/<hash>.webp（hash = path+mtime，与缩略图同规则）。
// 悬停时把时间映射到贴片下标，纯 CSS 定位显示——零延迟、跨会话复用、
// 参与 TTL 过期（cache_ttl_hours）。抽帧主路径 AVFoundation（每帧 ~20ms），
// 失败回退 ffmpeg。

pub const SCRUB_TILE_W: u32 = 160;
pub const SCRUB_TILE_H: u32 = 90;
/// 每行贴片数（网格固定 10 列，行数按时长算）
pub const SCRUB_COLS: u32 = 10;

/// 采样张数：目标 ~10s/张，夹在 24..=120（10s×120=20 分钟粗粒度上限，
/// 更长的视频间隔自动变稀，精灵图体积与生成时间恒定可控）
pub fn scrub_tile_count(duration: f64) -> u32 {
    ((duration / 10.0).ceil() as u32).clamp(24, 120).max(1)
}

/// 精灵图元数据（缓存为 <hash>.json；serde 默认 snake_case，前端按此读取）
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ScrubSheetMeta {
    pub duration: f64,
    pub tiles: u32,
    pub cols: u32,
    pub rows: u32,
    pub interval: f64,
    pub tile_w: u32,
    pub tile_h: u32,
}

/// 返回给前端的生成状态
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrubSheetStatus {
    /// generating | ready | failed
    pub status: String,
    pub percent: u32,
    #[serde(flatten)]
    pub meta: Option<ScrubSheetMeta>,
    /// ready 时的网格图路径（前端 assetUrl 转资产地址）
    pub path: Option<String>,
}

struct ScrubJob {
    status: String, // generating | failed
    done: u32,
    total: u32,
}

static SCRUB_JOBS: OnceLock<Mutex<HashMap<String, ScrubJob>>> = OnceLock::new();
fn scrub_jobs() -> &'static Mutex<HashMap<String, ScrubJob>> {
    SCRUB_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 查询/触发精灵图生成。缓存命中立即 ready；否则后台线程生成并轮询本接口。
/// duration 由前端 loadedmetadata 提供（比后端再 probe 一次更省）。
pub fn scrub_sheet(root: &Path, path: &str, mtime_ms: i64, duration: f64) -> ScrubSheetStatus {
    let empty = ScrubSheetStatus {
        status: "failed".into(),
        percent: 0,
        meta: None,
        path: None,
    };
    if duration <= 0.0 {
        return empty;
    }
    let dir = scrubs_dir(root);
    if std::fs::create_dir_all(&dir).is_err() {
        return empty;
    }
    let key = hash_hex(&[path, &mtime_ms.to_string()]);
    let out = dir.join(format!("{}.webp", key));
    let meta_f = dir.join(format!("{}.json", key));

    // 缓存命中：读元数据直接返回（顺带续期，参与按时间过期）
    if out.exists() && meta_f.exists() {
        if let Ok(m) = serde_json::from_str::<ScrubSheetMeta>(
            &std::fs::read_to_string(&meta_f).unwrap_or_default(),
        ) {
            crate::cache::touch_cache_file(&out);
            crate::cache::touch_cache_file(&meta_f);
            return ScrubSheetStatus {
                status: "ready".into(),
                percent: 100,
                meta: Some(m),
                path: Some(out.to_string_lossy().into_owned()),
            };
        }
    }

    let tiles = scrub_tile_count(duration);
    let interval = duration / tiles as f64;
    let meta = ScrubSheetMeta {
        duration,
        tiles,
        cols: SCRUB_COLS,
        rows: (tiles + SCRUB_COLS - 1) / SCRUB_COLS,
        interval,
        tile_w: SCRUB_TILE_W,
        tile_h: SCRUB_TILE_H,
    };

    let mut jobs = scrub_jobs().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(j) = jobs.get(&key) {
        // 已有任务在跑（或曾失败）：失败粘滞到本次会话结束，避免坏文件反复重试
        return ScrubSheetStatus {
            status: j.status.clone(),
            percent: if j.total > 0 { j.done * 100 / j.total } else { 0 },
            meta: Some(meta),
            path: None,
        };
    }
    jobs.insert(
        key.clone(),
        ScrubJob { status: "generating".into(), done: 0, total: tiles },
    );
    drop(jobs);

    let root = root.to_path_buf();
    let path = path.to_string();
    let meta_t = meta.clone();
    std::thread::spawn(move || {
        let r = gen_scrub_sheet(&root, &path, &meta_t, &out, &meta_f, &key);
        let mut jobs = scrub_jobs().lock().unwrap_or_else(|p| p.into_inner());
        match r {
            Ok(()) => {
                jobs.remove(&key); // 完成后文件即事实来源，任务表可清
            }
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                let _ = std::fs::remove_file(&meta_f);
                if let Some(j) = jobs.get_mut(&key) {
                    j.status = "failed".into();
                }
                eprintln!("[scrub] 生成精灵图失败 {}: {}", path, e);
            }
        }
    });

    ScrubSheetStatus {
        status: "generating".into(),
        percent: 0,
        meta: Some(meta),
        path: None,
    }
}

/// 后台生成：逐时间点抽帧 → 居中裁剪成 160×90 贴片 → 拼网格 → WebP 落盘
fn gen_scrub_sheet(
    root: &Path,
    path: &str,
    meta: &ScrubSheetMeta,
    out: &Path,
    meta_f: &Path,
    key: &str,
) -> Result<(), String> {
    let dir = scrubs_dir(root);
    let tmp = dir.join(format!(".{}.tmp.jpg", key));
    let canvas_w = meta.cols * SCRUB_TILE_W;
    let canvas_h = meta.rows * SCRUB_TILE_H;
    let mut canvas = image::RgbImage::new(canvas_w, canvas_h);
    let mut done: u32 = 0;

    for i in 0..meta.tiles {
        let t = ((i as f64 + 0.5) * meta.interval).min((meta.duration - 0.05).max(0.0));
        // 主路径 AVFoundation（快 ~10 倍），失败回退 ffmpeg
        let r = if crate::av::available() {
            crate::av::capture_frame(path, t, &tmp, 320)
                .or_else(|_| capture_frame(path, t, &tmp))
        } else {
            capture_frame(path, t, &tmp)
        };
        let img = match r {
            Ok(()) => image::open(&tmp).map_err(|e| format!("读取帧失败: {}", e))?,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("第 {} 帧抽帧失败: {}", i, e));
            }
        };
        let tile = img.resize_to_fill(
            SCRUB_TILE_W,
            SCRUB_TILE_H,
            image::imageops::FilterType::Triangle,
        );
        let col = i % meta.cols;
        let row = i / meta.cols;
        image::imageops::overlay(
            &mut canvas,
            &tile.to_rgb8(),
            (col * SCRUB_TILE_W) as u32 as i64,
            (row * SCRUB_TILE_H) as u32 as i64,
        );
        done += 1;
        if let Ok(mut jobs) = scrub_jobs().lock() {
            if let Some(j) = jobs.get_mut(key) {
                j.done = done;
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);

    save_webp(
        &image::DynamicImage::ImageRgb8(canvas),
        out,
        78.0,
    )?;
    std::fs::write(meta_f, serde_json::to_string(meta).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写入元数据失败: {}", e))?;
    Ok(())
}

pub fn exif_taken_ms(path: &Path) -> Option<i64> {
    let file = std::fs::File::open(path).ok()?;
    let mut buf = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut buf).ok()?;
    for tag in [exif::Tag::DateTimeOriginal, exif::Tag::DateTime] {
        if let Some(f) = exif.get_field(tag, exif::In::PRIMARY) {
            if let Some(ms) = parse_exif_datetime(&f.display_value().to_string()) {
                return Some(ms);
            }
        }
    }
    None
}

/// 视频拍摄/创建时间：优先 ffprobe 元数据里的 creation_time（mp4/mov 常见）
pub fn video_taken_ms(path: &Path) -> Option<i64> {
    let v = ffprobe_raw(path.to_str()?)?;
    let t = v["format"]["tags"]["creation_time"].as_str()?;
    crate::util::parse_iso8601_ms(t)
}

/// 读取图片 EXIF 拍摄详情（信息面板用）
pub fn exif_detail(path: &Path) -> (Option<i64>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) {
    let empty = (None, None, None, None, None, None, None, None);
    let Ok(file) = std::fs::File::open(path) else { return empty };
    let mut buf = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut buf) else { return empty };
    let get = |tag: exif::Tag| -> Option<String> {
        exif.get_field(tag, exif::In::PRIMARY)
            .map(|f| f.display_value().to_string().trim_matches('"').to_string())
            .filter(|s| !s.is_empty() && s != "-")
    };
    // Rational 字段第 i 项转 f64
    let rat = |tag: exif::Tag, i: usize| -> Option<f64> {
        let f = exif.get_field(tag, exif::In::PRIMARY)?;
        match &f.value {
            exif::Value::Rational(rs) => {
                let r = rs.get(i)?;
                if r.denom == 0 {
                    None
                } else {
                    Some(r.num as f64 / r.denom as f64)
                }
            }
            _ => None,
        }
    };
    let taken = exif_taken_ms(path);
    let camera = match (get(exif::Tag::Make), get(exif::Tag::Model)) {
        (Some(m), Some(mo)) => Some(format!("{} {}", m, mo)),
        (None, Some(mo)) => Some(mo),
        (Some(m), None) => Some(m),
        _ => None,
    };
    let lens = get(exif::Tag::LensModel);
    let iso = get(exif::Tag::ISOSpeed).map(|s| format!("ISO {}", s));
    let aperture = rat(exif::Tag::FNumber, 0).map(|v| format!("f/{:.1}", v));
    let shutter = rat(exif::Tag::ExposureTime, 0).map(|v| {
        if v >= 1.0 {
            format!("{:.0}s", v)
        } else if v > 0.0 {
            format!("1/{}", (1.0 / v).round() as i64)
        } else {
            String::new()
        }
    });
    let focal = rat(exif::Tag::FocalLength, 0).map(|v| format!("{:.0}mm", v));
    // GPS 十进制坐标
    let gps = {
        let dms = |tag: exif::Tag| -> Option<f64> {
            Some(rat(tag, 0)? + rat(tag, 1)? / 60.0 + rat(tag, 2)? / 3600.0)
        };
        let lat = dms(exif::Tag::GPSLatitude);
        let lon = dms(exif::Tag::GPSLongitude);
        let lat_ref = get(exif::Tag::GPSLatitudeRef).map(|s| s.to_uppercase());
        let lon_ref = get(exif::Tag::GPSLongitudeRef).map(|s| s.to_uppercase());
        match (lat, lon, lat_ref, lon_ref) {
            (Some(mut la), Some(mut lo), Some(lr), Some(orf)) => {
                if lr == "S" {
                    la = -la;
                }
                if orf == "W" {
                    lo = -lo;
                }
                Some(format!("{:.6}, {:.6}", la, lo))
            }
            _ => None,
        }
    };
    let clean = |o: Option<String>| -> Option<String> { o.filter(|s| !s.is_empty()) };
    (
        taken,
        camera,
        clean(lens),
        clean(iso),
        clean(aperture),
        clean(shutter),
        clean(focal),
        gps,
    )
}

/// 图片查看器预览图（1.0.1-r13）：大图查看不再直接加载原图（可占数百 MB 内存），
/// 改为加载降采样预览（缓存到 cache/previews/，可再生成）。
/// 小图（最长边 ≤ PREVIEW_MAX）返回 None，前端直接用原图，避免无谓缓存。
///
/// 1.0.2-r4 瘦身：2048px/q88 → 1600px/q74。实测（4000×3000 合成高熵图）体积从
/// 799KB 降到 328KB，**减少 59%**；1600px 仍足以在 4K/5K 全屏下保持可接受锐度，
/// 而真实照片（低于合成图的熵）压缩收益更高。
pub const PREVIEW_MAX: u32 = 1600;
pub const PREVIEW_QUALITY: f32 = 74.0;

pub fn preview_image(root: &Path, path: &Path, mtime_ms: i64) -> Result<Option<PathBuf>, String> {
    let dir = previews_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建预览缓存目录失败: {}", e))?;
    let key = hash_hex(&[&path.to_string_lossy(), &mtime_ms.to_string()]);
    // 1.0.2：预览缓存改 WebP（体积与解码速度均优于 JPEG）
    let out = dir.join(format!("{}.webp", key));
    if out.exists() {
        crate::cache::touch_cache_file(&out); // 命中即续期（过期清理依据 mtime）
        return Ok(Some(out)); // 缓存命中，无需解码
    }
    let file = std::fs::File::open(path).map_err(|e| format!("打开图片失败: {}", e))?;
    let reader = image::ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    apply_decode_limits(&mut decoder);
    let (w, h) = decoder.dimensions();
    if w <= PREVIEW_MAX && h <= PREVIEW_MAX {
        return Ok(None); // 小图直接看原图
    }
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("解码图片失败（该格式可能不被支持）: {}", e))?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    if img.width() > PREVIEW_MAX || img.height() > PREVIEW_MAX {
        img = img.resize(
            PREVIEW_MAX,
            PREVIEW_MAX,
            image::imageops::FilterType::Triangle,
        );
    }
    save_webp(&img, &out, PREVIEW_QUALITY)?;
    Ok(Some(out))
}

/// 保存任意图片为封面（限制最大边 800，转 jpg）
pub fn save_cover_image(root: &Path, src: &Path, key_seed: &str) -> Result<String, String> {
    let dir = crate::state::covers_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建封面目录失败: {}", e))?;
    let name = format!("{}.jpg", hash_hex(&[key_seed, &std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().to_string()]));
    let out = dir.join(&name);
    let file = std::fs::File::open(src).map_err(|e| format!("打开图片失败: {}", e))?;
    let reader = image::ImageReader::new(std::io::BufReader::new(file))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    apply_decode_limits(&mut decoder);
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("解码图片失败: {}", e))?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    if img.width() > 800 || img.height() > 800 {
        img = img.resize(800, 800, image::imageops::FilterType::Lanczos3);
    }
    img.save_with_format(&out, image::ImageFormat::Jpeg)
        .map_err(|e| format!("保存封面失败: {}", e))?;
    Ok(name)
}

// ---------- 单元测试 ----------
#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vtm-media-{}-{}-{}",
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

    /// 合成一张"照片感"的测试图：低频渐变 + 中频条纹 + 少量噪点，
    /// 熵介于纯色与纯噪声之间，压缩率接近真实照片。
    fn synth_photo(path: &Path, w: u32, h: u32) {
        let mut img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::new(w, h);
        for (x, y, px) in img.enumerate_pixels_mut() {
            let xf = x as f32;
            let yf = y as f32;
            let r = (127.0 + 96.0 * (xf / 90.0).sin() * (yf / 140.0).cos()) as i32;
            let g = (127.0 + 80.0 * ((xf + yf) / 60.0).sin()) as i32;
            let b = (127.0 + 70.0 * (yf / 75.0).sin()) as i32;
            let n = ((x * 7 + y * 13) % 17) as i32 - 8; // 轻微噪点
            *px = Rgb([
                (r + n).clamp(0, 255) as u8,
                (g + n / 2).clamp(0, 255) as u8,
                (b + n).clamp(0, 255) as u8,
            ]);
        }
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(path, image::ImageFormat::Jpeg)
            .unwrap();
    }

    /// 1.0.2-r4：预览缓存体积必须比旧方案（2048px / q88）小一半以上。
    /// 这条断言锁住瘦身效果，防止后续调参被无意回退。
    #[test]
    fn preview_cache_is_at_least_half_smaller_than_legacy() {
        let dir = tmp_dir("preview-size");
        let src = dir.join("src.jpg");
        synth_photo(&src, 3000, 2000);

        let out = preview_image(&dir, &src, 1)
            .unwrap()
            .expect("大图应生成预览缓存");
        let new_size = std::fs::metadata(&out).unwrap().len();

        // 旧方案基线：同一张图按 2048px / q88 编码
        let img = image::open(&src).unwrap();
        let legacy = img.resize(2048, 2048, image::imageops::FilterType::Triangle);
        let rgb = legacy.to_rgb8();
        let legacy_size = webp::Encoder::from_rgb(&rgb, rgb.width(), rgb.height())
            .encode(88.0)
            .len();

        println!(
            "preview: new {} bytes vs legacy {} bytes ({:.1}%)",
            new_size,
            legacy_size,
            new_size as f64 / legacy_size as f64 * 100.0
        );
        assert!(
            (new_size as f64) <= legacy_size as f64 * 0.5,
            "预览缓存未达到减半目标：new={} legacy={}",
            new_size,
            legacy_size
        );
        // 尺寸也应被限制在 PREVIEW_MAX 内
        let got = image::open(&out).unwrap();
        assert!(got.width() <= PREVIEW_MAX && got.height() <= PREVIEW_MAX);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 命中缓存会续期（mtime 刷新），过期清理据此判断「最近是否还在看」
    #[test]
    fn preview_cache_hit_refreshes_mtime() {
        let dir = tmp_dir("preview-touch");
        let src = dir.join("src.jpg");
        synth_photo(&src, 2400, 1600);

        let out = preview_image(&dir, &src, 1).unwrap().expect("应生成预览");
        let before = std::fs::metadata(&out).unwrap().modified().unwrap();
        // 把 mtime 拨回 10 分钟前，再命中一次
        let old = before - std::time::Duration::from_secs(600);
        std::fs::File::options()
            .write(true)
            .open(&out)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let again = preview_image(&dir, &src, 1).unwrap().expect("应命中缓存");
        assert_eq!(again, out);
        let after = std::fs::metadata(&out).unwrap().modified().unwrap();
        assert!(after > old, "命中缓存后 mtime 应被刷新（续期）");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 小图不应产生预览缓存（直接看原图，省一份缓存也省一次解码）
    #[test]
    fn small_image_has_no_preview_cache() {
        let dir = tmp_dir("preview-small");
        let src = dir.join("small.jpg");
        synth_photo(&src, 800, 600);
        assert!(preview_image(&dir, &src, 1).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---------- 精灵图（scrub sheet）单元测试 ----------
#[cfg(test)]
mod scrub_tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vtm-scrub-{}-{}-{}",
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

    /// 采样张数规则：~10s/张，夹在 24..=120
    #[test]
    fn scrub_tile_count_clamps() {
        assert_eq!(scrub_tile_count(5.0), 24); // 短视频最少 24 张
        assert_eq!(scrub_tile_count(260.0), 26);
        assert_eq!(scrub_tile_count(3600.0), 120); // 1 小时封顶 120 张
    }

    /// 端到端：真实 ffmpeg 生成 260s 测试视频 → 生成精灵图 → 缓存命中 → 元数据正确
    #[test]
    fn scrub_sheet_generates_and_caches() {
        let Ok(ffmpeg) = tool_path("ffmpeg") else { return }; // 无内置 ffmpeg 的环境跳过
        let dir = tmp_dir("e2e");
        let src = dir.join("v.mp4");
        let st = std::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-f", "lavfi",
                "-i", "testsrc=duration=260:size=128x96:rate=1",
                "-c:v", "mpeg4",
                "-q:v", "5",
            ])
            .arg(&src)
            .output()
            .expect("启动 ffmpeg 失败");
        assert!(st.status.success(), "生成测试视频失败");

        let mtime = std::fs::metadata(&src).unwrap().modified().unwrap();
        let mtime_ms = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // 触发生成（首查应为 generating 或直接 ready，取决于生成是否快于首查）
        let s1 = scrub_sheet(&dir, src.to_str().unwrap(), mtime_ms, 260.0);
        assert!(s1.status == "generating" || s1.status == "ready", "status={}", s1.status);
        assert_eq!(s1.meta.as_ref().unwrap().tiles, 26);

        // 轮询直到完成（AVFoundation ~1s；ffmpeg 回退也应在 60s 内）
        let mut ready = false;
        for _ in 0..120 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let s = scrub_sheet(&dir, src.to_str().unwrap(), mtime_ms, 260.0);
            if s.status == "ready" {
                ready = true;
                let m = s.meta.as_ref().unwrap();
                assert_eq!(m.cols, 10);
                assert_eq!(m.rows, 3);
                assert!((m.interval - 10.0).abs() < 0.01);
                assert!(s.path.as_ref().unwrap().ends_with(".webp"));
                break;
            }
            assert_ne!(s.status, "failed", "生成失败");
        }
        assert!(ready, "60s 内未完成生成");

        // 网格尺寸正确（26 张 → 10 列 × 3 行 → 1600×270）
        let files: Vec<_> = std::fs::read_dir(scrubs_dir(&dir))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        let webp = files.iter().find(|p| p.extension().map(|x| x == "webp").unwrap_or(false)).unwrap();
        let img = image::open(webp).unwrap();
        assert_eq!((img.width(), img.height()), (1600, 270));

        // 再次调用：缓存命中立即 ready（不再 generating）
        let s2 = scrub_sheet(&dir, src.to_str().unwrap(), mtime_ms, 260.0);
        assert_eq!(s2.status, "ready");
        assert!(s2.path.is_some());

        // mtime 变化 → 新 hash，重新生成（旧缓存不复用）
        let s3 = scrub_sheet(&dir, src.to_str().unwrap(), mtime_ms + 1, 260.0);
        assert!(s3.status == "generating" || s3.status == "ready");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
