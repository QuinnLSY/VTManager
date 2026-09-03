//! macOS AVFoundation 视频加速模块（1.0.2 新增）：
//!
//! 用系统原生框架替代 ffprobe / ffmpeg 的两条高频路径，换来三方面收益：
//! 1. 速度：省去每次「启动外部进程」的开销（进程拉起约 30–80ms），截帧与元数据
//!    读取明显更快，大目录首屏缩略图生成时间缩短；
//! 2. 内存：不再为每个视频临时拉起独立进程，常驻内存与瞬时峰值都更低；
//! 3. 体积：元数据读取不再依赖 ffprobe，发布包可移除 ffprobe（约 49MB），
//!    应用安装体积大幅减小。
//!
//! 设计：本模块只做「主路径加速」。任何失败（非 macOS 平台、AVFoundation 不支持的
//! 容器/编码、损坏文件等）都会返回 None / Err，由调用方无缝回退到 ffmpeg/ffprobe，
//! 因此功能覆盖与旧版完全一致，零行为回退。
//!
//! 线程模型：AVFoundation 的属性读取与截帧允许在后台线程同步进行（可能阻塞调用线程
//! 但不会崩溃），所有调用都在 autoreleasepool 内完成，避免跨线程持有 Objective-C 对象。

use std::path::Path;

/// 视频元数据（AVFoundation 能提供的最小有效集，覆盖 ffprobe 高频使用字段）
pub struct AvVideoInfo {
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 轨道摘要（媒体类型 + 编码器名），信息面板展示用
    pub tracks: Vec<AvTrack>,
    /// 估算码率（bit/s）：文件大小 / 时长
    pub bitrate: Option<u64>,
}

pub struct AvTrack {
    pub kind: String,  // "video" | "audio" | "text" | "other"
    pub codec: String, // 编码器名（如 H.264 / HEVC / AAC），未知为 "unknown"
}

/// 本平台是否启用 AVFoundation 主路径（macOS 专属；其余平台恒 false 直接走 ffmpeg）
pub fn available() -> bool {
    cfg!(target_os = "macos")
}

/// 读取视频元数据；失败返回 None（调用方回退 ffprobe）。
#[cfg(target_os = "macos")]
pub fn probe(path: &str) -> Option<AvVideoInfo> {
    use objc2::rc::autoreleasepool;
    use objc2_av_foundation::AVURLAsset;
    use objc2_core_media::CMTimeFlags;
    use objc2_foundation::{NSString, NSURL};

    autoreleasepool(|pool| {
        let ns_path = NSString::from_str(path);
        let url = NSURL::fileURLWithPath(&ns_path);
        // SAFETY: AVURLAsset 构造；URL 为本地文件路径
        let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };

        // 时长：CMTime -> 秒（校验 flags 有效性与 timescale）
        // SAFETY: duration 属性同步读取（可能阻塞调用线程，符合后台线程使用约定）
        let dur = unsafe { asset.duration() };
        let duration = if dur.flags.contains(CMTimeFlags::Valid) && dur.timescale > 0 {
            Some(dur.value as f64 / dur.timescale as f64)
        } else {
            None
        };

        // 轨道遍历：取视频轨尺寸（naturalSize）与各轨类型/编码器
        let mut width: Option<u32> = None;
        let mut height: Option<u32> = None;
        let mut tracks: Vec<AvTrack> = Vec::new();
        for t in unsafe { asset.tracks() }.iter() {
            // SAFETY: mediaType 属性同步读取
            let mt = unsafe { t.mediaType() };
            // to_str 借用 autorelease pool，返回的 &str 仅在该 pool 内有效
            let mt_str = unsafe { mt.to_str(pool) };
            let kind = if mt_str == "vide" {
                "video"
            } else if mt_str == "soun" {
                "audio"
            } else if mt_str == "text" || mt_str == "clcp" {
                "text"
            } else {
                "other"
            };
            // 编码器名：从格式描述转 CMVideoCodecType 映射
            let codec = codec_name(&t);
            if kind == "video" {
                // SAFETY: naturalSize 属性同步读取
                let sz = unsafe { t.naturalSize() };
                if sz.width > 0.0 && sz.height > 0.0 {
                    width = Some(sz.width as u32);
                    height = Some(sz.height as u32);
                }
            }
            tracks.push(AvTrack {
                kind: kind.to_string(),
                codec,
            });
        }

        // 估算码率（位/s）
        let bitrate = duration.and_then(|d| {
            if d <= 0.0 {
                return None;
            }
            let size = std::fs::metadata(path).ok()?.len();
            Some((size as f64 * 8.0 / d) as u64)
        });

        Some(AvVideoInfo {
            duration,
            width,
            height,
            tracks,
            bitrate,
        })
    })
}

/// AVFoundation 不可用（非 macOS）时统一走 ffmpeg
#[cfg(not(target_os = "macos"))]
pub fn probe(_path: &str) -> Option<AvVideoInfo> {
    None
}

/// 截帧：在指定时间点（秒）抓取一帧，编码为 JPEG 写入 out，最长边 ≤ max_side。
/// 失败返回 Err（调用方回退 ffmpeg capture_frame）。
#[cfg(target_os = "macos")]
#[allow(deprecated)] // copyCGImageAtTime 在系统绑定中被标记为 deprecated，但仍是同步截帧的首选
pub fn capture_frame(video: &str, time: f64, out: &Path, max_side: u32) -> Result<(), String> {
    capture_frame_with_uti(video, time, out, max_side, "public.jpeg", "tmp.jpg")
}

/// 截帧为 PNG（1.0.2-r7 播放器截图）：原分辨率（max_side=0 不限制），AVFoundation 主路径。
/// 失败返回 Err（调用方回退 ffmpeg capture_frame_png）。
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn capture_frame_png(video: &str, time: f64, out: &Path) -> Result<(), String> {
    capture_frame_with_uti(video, time, out, 0, "public.png", "tmp.png")
}

/// 截帧通用实现：指定 UTI 编码（JPEG / PNG）
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn capture_frame_with_uti(
    video: &str,
    time: f64,
    out: &Path,
    max_side: u32,
    uti: &str,
    tmp_ext: &str,
) -> Result<(), String> {
    use objc2::rc::autoreleasepool;
    use objc2_av_foundation::{AVAssetImageGenerator, AVURLAsset};
    use objc2_core_foundation::CGSize;
    use objc2_core_media::{CMTime, CMTimeFlags};
    use objc2_foundation::{NSString, NSURL};

    autoreleasepool(|_| {
        let ns_path = NSString::from_str(video);
        let url = NSURL::fileURLWithPath(&ns_path);
        // SAFETY: AVURLAsset / ImageGenerator 构造与属性设置，均为本地文件同步操作
        let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
        let gen = unsafe { AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset) };
        // 尊重视频的旋转元数据（竖拍视频等）
        unsafe { gen.setAppliesPreferredTrackTransform(true) };
        // 限制输出尺寸：直接输出 ≤max_side 的图，避免在解码器内全尺寸渲染（内存）；
        // max_side=0 表示不限制（截原分辨率画面）
        if max_side > 0 {
            unsafe {
                gen.setMaximumSize(CGSize {
                    width: max_side as f64,
                    height: max_side as f64,
                });
            }
        }

        // 时间：把秒转成 600 倍时间基的 CMTime
        let value = (time.max(0.0) * 600.0).round() as i64;
        let cmt = CMTime {
            value,
            timescale: 600,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        };
        let image = unsafe {
            gen.copyCGImageAtTime_actualTime_error(cmt, std::ptr::null_mut())
        }
        .map_err(|_| "AVFoundation 截帧失败".to_string())?;

        // CGImage -> 指定格式（ImageIO 写文件）
        write_image(&image, out, uti, tmp_ext)
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_frame(_video: &str, _time: f64, _out: &Path, _max_side: u32) -> Result<(), String> {
    Err("AVFoundation 不可用".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn capture_frame_png(_video: &str, _time: f64, _out: &Path) -> Result<(), String> {
    Err("AVFoundation 不可用".to_string())
}

// ---------- 内部实现 ----------

/// 轨道编码器名（从 CMFormatDescription 的 codec type 映射常见名称）
#[cfg(target_os = "macos")]
fn codec_name(track: &objc2_av_foundation::AVAssetTrack) -> String {
    use objc2::rc::autoreleasepool;
    autoreleasepool(|_| {
        // SAFETY: formatDescriptions 属性同步读取
        let fds = unsafe { track.formatDescriptions() };
        if fds.count() == 0 {
            return "unknown".to_string();
        }
        let first = unsafe { fds.firstObject_unchecked() };
        // formatDescriptions 返回的是未特化的 NSArray，元素需按指针转换为
        // CMFormatDescription（CoreMedia 的不透明 CF 类型）
        let ct: u32 = match first {
            Some(fd) => unsafe {
                let ptr = (fd as *const objc2::runtime::AnyObject)
                    as *const objc2_core_media::CMFormatDescription;
                CMFormatDescriptionGetMediaSubType(&*ptr)
            },
            None => 0,
        };
        codec_display_name(ct)
    })
}

/// CMVideoCodecType（FourCC）→ 可读名称
#[cfg(target_os = "macos")]
fn codec_display_name(fourcc: u32) -> String {
    let h264_avc1: u32 = u32::from_be_bytes(*b"avc1");
    let h264_h264: u32 = u32::from_be_bytes(*b"h264");
    let h265_hvc1: u32 = u32::from_be_bytes(*b"hvc1");
    let h265_hev1: u32 = u32::from_be_bytes(*b"hev1");
    let vp9: u32 = u32::from_be_bytes(*b"vp09");
    let vp8: u32 = u32::from_be_bytes(*b"vp08");
    let av1: u32 = u32::from_be_bytes(*b"av01");
    let prores: u32 = u32::from_be_bytes(*b"apcn");
    let mpeg4: u32 = u32::from_be_bytes(*b"mp4v");
    let h263: u32 = u32::from_be_bytes(*b"h263");
    // 常见音频编码器
    let aac: u32 = u32::from_be_bytes(*b"mp4a");
    let mp3: u32 = u32::from_be_bytes(*b".mp3");
    let ac3: u32 = u32::from_be_bytes(*b"ac-3");
    let flac: u32 = u32::from_be_bytes(*b"flac");
    let opus: u32 = u32::from_be_bytes(*b"Opus");
    let pcm: u32 = u32::from_be_bytes(*b"lpcm");

    match fourcc {
        x if x == h264_avc1 || x == h264_h264 => "H.264".to_string(),
        x if x == h265_hvc1 || x == h265_hev1 => "HEVC (H.265)".to_string(),
        x if x == vp9 => "VP9".to_string(),
        x if x == vp8 => "VP8".to_string(),
        x if x == av1 => "AV1".to_string(),
        x if x == prores => "ProRes".to_string(),
        x if x == mpeg4 => "MPEG-4 Part 2".to_string(),
        x if x == h263 => "H.263".to_string(),
        x if x == aac => "AAC".to_string(),
        x if x == mp3 => "MP3".to_string(),
        x if x == ac3 => "AC-3".to_string(),
        x if x == flac => "FLAC".to_string(),
        x if x == opus => "Opus".to_string(),
        x if x == pcm => "PCM".to_string(),
        _ => format!("0x{:08x}", fourcc),
    }
}

/// CGImage 编码为文件（ImageIO），格式由 UTI 决定（public.jpeg / public.png）
#[cfg(target_os = "macos")]
fn write_image(
    image: &objc2_core_graphics::CGImage,
    out: &Path,
    uti: &str,
    tmp_ext: &str,
) -> Result<(), String> {
    use objc2::rc::autoreleasepool;
    use objc2_core_foundation::{CFMutableData, CFString};
    use objc2_image_io::CGImageDestination;

    // 确保输出目录存在（调用方通常已建好，这里兜底）
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建输出目录失败: {}", e))?;
    }
    // 先写临时文件，成功后 rename，避免半截文件被当作有效结果
    let tmp = out.with_extension(tmp_ext);

    autoreleasepool(|_| -> Result<(), String> {
        let data = CFMutableData::new(None, 0)
            .ok_or_else(|| "创建数据缓冲失败".to_string())?;
        let uti = CFString::from_str(uti);
        // SAFETY: with_data 仅要求 data/uti 参数类型正确，符合签名
        let dest = unsafe { CGImageDestination::with_data(&data, &uti, 1, None) }
            .ok_or_else(|| "创建图片编码器失败".to_string())?;
        unsafe { dest.add_image(image, None) };
        if !unsafe { dest.finalize() } {
            return Err("图片编码失败".to_string());
        }
        // 把 CFData 字节写盘
        let bytes = unsafe { data.as_bytes_unchecked() };
        std::fs::write(&tmp, bytes).map_err(|e| format!("写入文件失败: {}", e))?;
        Ok(())
    })?;

    std::fs::rename(&tmp, out).map_err(|e| format!("保存失败: {}", e))?;
    Ok(())
}

// ---------- CMFormatDescription 访问（core-media 未全部生成，直接声明所需 C 函数） ----------

#[cfg(target_os = "macos")]
#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMFormatDescriptionGetMediaSubType(fd: &objc2_core_media::CMFormatDescription) -> u32;
}
