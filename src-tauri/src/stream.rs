//! 本地视频流服务：让 WKWebView 以标准 HTTP Range 方式流式播放超大视频文件
//! （asset 协议对大文件的顺序整读不友好；本地流可按字节区间取数，拖动进度条即取即播）。
//!
//! - 仅监听 127.0.0.1，URL 携带会话令牌，且只允许资料库根目录内的文件
//!   （目标与根目录都做 canonicalize，`..` 与符号链接均无法越界）；
//! - `/raw/<base64url(路径)>`      直连原文件（支持 Range）；
//! - `/cache/<base64url(原路径)>`  播放转封装缓存副本（moov 在尾部等流式不友好的片源，
//!   由 start_remux 用 ffmpeg -c copy 无损转封装生成 faststart 副本后供流）。

use crate::media;
use crate::util::hash_hex;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::Shutdown;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

struct Server {
    port: u16,
    token: String,
    root: Mutex<PathBuf>,
}

static SERVER: Mutex<Option<Arc<Server>>> = Mutex::new(None);
static REQ_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, serde::Serialize)]
pub struct RemuxJob {
    pub status: String, // idle | running | done | error
    pub percent: u32,
    pub error: String,
    pub cache: String, // 该任务的缓存副本路径（/cache 端点按此寻址，切换资料库不错位）
}

static JOBS: OnceLock<Mutex<HashMap<String, RemuxJob>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, RemuxJob>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn b64_decode_path(s: &str) -> Option<String> {
    let bytes = B64.decode(s).ok()?;
    String::from_utf8(bytes).ok()
}

fn server() -> Option<Arc<Server>> {
    SERVER.lock().ok().and_then(|g| g.clone())
}

/// 生成 ≥128 位随机令牌（macOS/Linux 读 /dev/urandom；Windows 回退哈希混淆）
fn random_token() -> String {
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let mut buf = [0u8; 16];
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{:02x}", b)).collect();
        }
    }
    hash_hex(&[
        "vtm-stream",
        &std::process::id().to_string(),
        &std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_string(),
        &REQ_SEQ.fetch_add(1, Ordering::Relaxed).to_string(),
    ])
}

/// 清理转封装残留的临时文件（进程中断留下的孤儿）
fn sweep_tmp_files(remux_dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(remux_dir) {
        for item in rd.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if name.contains(".tmp") {
                let _ = std::fs::remove_file(item.path());
            }
        }
    }
}

/// 更新资料库根目录（切换资料库时调用），并确保服务已启动。
/// 切换时清空转封装任务表（任务键与缓存路径都随库变化）。
pub fn ensure_started(root: &Path) -> Result<(), String> {
    let srv = {
        let mut guard = SERVER.lock().map_err(|_| "流服务锁不可用")?;
        if guard.is_none() {
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let srv = Arc::new(Server {
                port,
                token: random_token(),
                root: Mutex::new(root.to_path_buf()),
            });
            let srv2 = srv.clone();
            std::thread::spawn(move || {
                for inc in listener.incoming() {
                    let Ok(stream) = inc else { continue };
                    let srv3 = srv2.clone();
                    std::thread::spawn(move || {
                        let _ = handle_connection(stream, &srv3);
                    });
                }
            });
            *guard = Some(srv);
        }
        guard.as_ref().unwrap().clone()
    };
    {
        let mut r = srv.root.lock().map_err(|_| "流服务根目录锁不可用")?;
        if *r != root {
            jobs().lock().map_err(|_| "任务表锁不可用")?.clear();
            *r = root.to_path_buf();
        }
    }
    if let Some(dir) = remux_dir(&*srv.root.lock().unwrap_or_else(|e| e.into_inner())) {
        sweep_tmp_files(&dir);
    }
    Ok(())
}

fn remux_dir(root: &Path) -> Option<PathBuf> {
    Some(root.join(".VTManager/cache/remux"))
}

/// 转封装缓存路径（按 原路径 + mtime 失效）
fn remux_cache_path(root: &Path, src: &str) -> PathBuf {
    let mtime = std::fs::metadata(src)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    root.join(".VTManager/cache/remux")
        .join(format!("{}.mp4", hash_hex(&[src, &mtime])))
}

/// 关闭播放时清理某视频的转封装缓存（1.0.2-r3）：
/// 删除 `-c copy` 生成的与原视频等大的 faststart 副本与同 hash 的 .tmp 残留。
/// 副本完全可再生（下次播放自动重建，秒级），删除只影响应用缓存、不触碰本地原文件。
/// 双保险定位：JOBS 任务记录的精确路径（会话内 mtime 变过也能删到）+ 当前 (path, mtime) hash。
/// 返回是否删除了至少一个文件。
pub fn cleanup_remux(root: &Path, src: &str) -> bool {
    let mut removed = false;
    // 1) 移除并取出该路径的任务记录，顺带删掉其记录的副本路径
    if let Some(j) = jobs().lock().unwrap_or_else(|e| e.into_inner()).remove(src) {
        if !j.cache.is_empty() {
            let p = PathBuf::from(&j.cache);
            if p.exists() && std::fs::remove_file(&p).is_ok() {
                removed = true;
            }
        }
    }
    // 2) 当前 mtime 计算出的 hash 副本
    let cache = remux_cache_path(root, src);
    if cache.exists() && std::fs::remove_file(&cache).is_ok() {
        removed = true;
    }
    // 3) 同 hash 的 .tmp 残留（转封装进行中关闭：ffmpeg 继续写入会因文件消失而失败退出，
    //    无副作用；写完 rename 也会因 tmp 不存在而失败，不会留下新副本）
    if let (Some(dir), Some(stem)) = (cache.parent(), cache.file_stem()) {
        let prefix = format!("{}.", stem.to_string_lossy());
        if let Ok(rd) = std::fs::read_dir(dir) {
            for item in rd.flatten() {
                let name = item.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) && name.contains(".tmp") {
                    if std::fs::remove_file(item.path()).is_ok() {
                        removed = true;
                    }
                }
            }
        }
    }
    removed
}

struct Req {
    range: Option<String>,
    head_only: bool,
}

fn handle_connection(mut stream: TcpStream, srv: &Server) {
    // 读超时仅作用于请求头读取（连接刚建立时等客户端发请求）；
    // 写超时则放宽到大文件流式传输的容忍值（几 GB 文件用 512KB chunk 推 → 网络慢时会
    // 持续等到 socket 缓冲区腾出）。系统默认写超时 15s 在大文件下频繁触发 → 客户端拿到
    // 不完整响应 → 浏览器判定失败 → 黑屏。
    stream.set_read_timeout(Some(Duration::from_secs(15))).ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(120)))
        .ok();
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    // 读完请求头（遇到空行即止，最多 16KB）
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let range = lines
        .by_ref()
        .take_while(|l| !l.is_empty())
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("range")
                .then(|| v.trim().to_string())
        });
    let req = Req {
        range,
        head_only: method.eq_ignore_ascii_case("HEAD"),
    };

    // 路由：/{token}/raw|cache/<base64url(路径)>
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if segs.len() != 3 || segs[0] != srv.token || (segs[1] != "raw" && segs[1] != "cache") {
        write_simple(&mut stream, 404, "not found", req.head_only);
        return;
    }
    let Some(target) = b64_decode_path(segs[2]) else {
        write_simple(&mut stream, 400, "bad path", req.head_only);
        return;
    };
    // 安全校验：目标必须位于当前资料库根目录内。
    // canonicalize 归一化 `..` 并解析符号链接，词法绕过与链接外链都行不通。
    let root_now = srv.root.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let (Ok(canon_target), Ok(canon_root)) = (
        std::fs::canonicalize(&target),
        std::fs::canonicalize(&root_now),
    ) else {
        write_simple(&mut stream, 404, "file missing", req.head_only);
        return;
    };
    if !canon_target.starts_with(&canon_root) {
        write_simple(&mut stream, 403, "outside library", req.head_only);
        return;
    }
    let file_path = if segs[1] == "cache" {
        // 优先使用任务表里记录的缓存路径（转封装期间/切换库时不随当前根变化）；
        // 无任务记录（如应用重启后）则按当前根计算
        let job_cache = jobs()
            .lock()
            .ok()
            .and_then(|m| m.get(&target).map(|j| PathBuf::from(&j.cache)))
            .filter(|p| p.exists());
        job_cache.unwrap_or_else(|| remux_cache_path(&canon_root, &target))
    } else {
        canon_target.clone()
    };
    serve_file(&mut stream, &file_path, &req);
    // 优雅关闭：避免残留缓冲被 RST 截断
    let _ = stream.shutdown(Shutdown::Write);
    let mut drain = [0u8; 512];
    let _ = stream.read(&mut drain);
}

fn write_simple(stream: &mut TcpStream, code: u16, msg: &str, head_only: bool) {
    let reason = match code {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        416 => "Range Not Satisfiable",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let body = format!("{{\"error\":\"{}\"}}", msg);
    let mut resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        code,
        reason,
        body.len()
    );
    if !head_only {
        resp.push_str(&body);
    }
    let _ = stream.write_all(resp.as_bytes());
}

fn ext_type(p: &Path) -> &'static str {
    match p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        _ => "video/mp4",
    }
}

fn serve_file(stream: &mut TcpStream, path: &Path, req: &Req) {
    let Ok(meta) = std::fs::metadata(path) else {
        write_simple(stream, 404, "file missing", req.head_only);
        return;
    };
    let total = meta.len();
    let ctype = ext_type(path);
    if total == 0 {
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: 0\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
            ctype
        );
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    // 解析 Range（只取第一段；支持 bytes=a-b / bytes=a- / bytes=-n）。
    // 无法解析的 Range 头按规范整体忽略（返回 200 全量）。
    let (mut start, mut end) = (0u64, total.saturating_sub(1));
    let mut partial = false;
    if let Some(r) = &req.range {
        if let Some(spec) = r.strip_prefix("bytes=") {
            let first = spec.split(',').next().unwrap_or("").trim();
            // split_once 失败说明 range 字符串连 '-' 都没有（如 "bytes=abc"），
            // 整体忽略该 Range 走全量；不再裸 return（会断开连接 → WKWebView 黑屏）
            if let Some((a, b)) = first.split_once('-') {
                if a.is_empty() && !b.is_empty() {
                    // 后缀区间：最后 n 字节；n=0 视为不可满足
                    match b.parse::<u64>() {
                        Ok(n) if n == 0 => {
                            write_simple(stream, 416, "range not satisfiable", req.head_only);
                            return;
                        }
                        Ok(n) => {
                            start = total.saturating_sub(n);
                            partial = true;
                        }
                        Err(_) => {}
                    }
                } else if let Ok(s) = a.parse::<u64>() {
                    if s >= total {
                        write_simple(stream, 416, "range not satisfiable", req.head_only);
                        return;
                    }
                    start = s;
                    end = match b.parse::<u64>() {
                        Ok(e) => e.min(total.saturating_sub(1)),
                        Err(_) => total.saturating_sub(1),
                    };
                    if start <= end {
                        partial = true;
                    }
                }
            }
            // 无法解析的 Range：忽略，按 200 OK 走全量
        }
    }
    if !partial {
        end = total.saturating_sub(1);
    }
    let len = end - start + 1;

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            write_simple(stream, 404, "open failed", req.head_only);
            return;
        }
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        write_simple(stream, 500, "seek failed", req.head_only);
        return;
    }

    let status = if partial { "206 Partial Content" } else { "200 OK" };
    let mut head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n",
        status, ctype, len
    );
    if partial {
        head.push_str(&format!(
            "Content-Range: bytes {}-{}/{}\r\n",
            start, end, total
        ));
    }
    head.push_str("\r\n");
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    if req.head_only {
        return;
    }

    // 按块推送（写超时/写失败即放弃该连接，防止慢客户端占用线程）
    let mut remaining = len;
    let mut buf = vec![0u8; 512 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        match file.read(&mut buf[..want]) {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).is_err() {
                    break;
                }
                remaining -= n as u64;
            }
            Err(_) => break,
        }
    }
    let _ = stream.flush();
}

// ---------- 转封装（moov 置前，-c copy 无损） ----------

/// 快速探测 MP4 moov 位置：front（开头，可直接流播）/ late（在 mdat 之后）/ unknown
/// 「unknown」指头 64 个 atom 中既没找到 moov 也没找到 mdat，通常是 MKV/AVI 等非 MP4 容器；
/// JS 端把 unknown 与 late 同样对待（走转封装），ffmpeg 会处理各种容器。
pub fn moov_position(path: &str) -> &'static str {
    let Ok(mut f) = std::fs::File::open(path) else {
        return "unknown";
    };
    let Ok(meta) = f.metadata() else { return "unknown" };
    let mut pos: u64 = 0;
    for _ in 0..64 {
        if pos + 8 > meta.len() {
            break;
        }
        if f.seek(SeekFrom::Start(pos)).is_err() {
            return "unknown";
        }
        let mut hdr = [0u8; 8];
        if f.read_exact(&mut hdr).is_err() {
            return "unknown";
        }
        let mut size = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        if size == 1 {
            let mut ext = [0u8; 8];
            if f.read_exact(&mut ext).is_err() {
                return "unknown";
            }
            size = u64::from_be_bytes(ext);
        } else if size == 0 {
            break;
        }
        if size < 8 {
            break;
        }
        if &hdr[4..8] == b"moov" {
            return "front";
        }
        if &hdr[4..8] == b"mdat" {
            return "late";
        }
        pos += size;
    }
    "unknown"
}

/// 发起/查询转封装。running 幂等返回；done 且缓存仍有效直接复用；
/// 文件不存在（已被删除/移动）返回 error，避免无谓的转封装。
pub fn start_remux(state_root: &Path, src: &str) -> RemuxJob {
    if !Path::new(src).exists() {
        return RemuxJob {
            status: "error".into(),
            percent: 0,
            error: "文件不存在或已被移动".into(),
            cache: String::new(),
        };
    }
    let cache = remux_cache_path(state_root, src);
    let cache_s = cache.to_string_lossy().to_string();
    if cache.exists() {
        return RemuxJob {
            status: "done".into(),
            percent: 100,
            error: String::new(),
            cache: cache_s,
        };
    }
    {
        let mut map = jobs().lock().unwrap();
        // 查重与占位在同一临界区完成，避免并发双开 ffmpeg；
        // done 任务若缓存路径已变（mtime 失效）则重新转封装
        let need_start = match map.get(src) {
            Some(j) if j.status == "running" => {
                return j.clone();
            }
            Some(j) if j.status == "done" && j.cache == cache_s => {
                return j.clone();
            }
            _ => true,
        };
        if need_start {
            map.insert(
                src.to_string(),
                RemuxJob {
                    status: "running".into(),
                    percent: 0,
                    error: String::new(),
                    cache: cache_s.clone(),
                },
            );
        }
    }
    // 注意：start_remux 是同步 Tauri 命令，**跑在应用主线程**。
    // ffprobe 在大文件上可能耗时数百毫秒到数秒，放在这里会卡死整个 UI（含所有 invoke 响应），
    // 因此时长探测与文件尺寸都推迟到后台线程里做（见 run_remux 开头）。
    let src_s = src.to_string();
    let root = state_root.to_path_buf();
    std::thread::spawn(move || run_remux(root, src_s));
    RemuxJob {
        status: "running".into(),
        percent: 0,
        error: String::new(),
        cache: cache_s,
    }
}

pub fn remux_status(_root: &Path, src: &str) -> RemuxJob {
    jobs().lock().unwrap().get(src).cloned().unwrap_or(RemuxJob {
        status: "idle".into(),
        percent: 0,
        error: String::new(),
        cache: String::new(),
    })
}

fn set_job(src: &str, status: &str, percent: u32, error: &str, cache: &str) {
    jobs().lock().unwrap().insert(
        src.to_string(),
        RemuxJob {
            status: status.into(),
            percent,
            error: error.into(),
            cache: cache.into(),
        },
    );
}

fn run_remux(root: PathBuf, src: String) {
    // 后台线程内做时长/尺寸探测：优先用时长换算百分比；拿不到则回退到字节比例，
    // 保证大文件进度条始终在动，避免用户看到 "处理中…" 卡住。
    let duration = media::ffprobe_info(&src).duration.unwrap_or(0.0);
    let total_size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    let cache = remux_cache_path(&root, &src);
    let cache_s = cache.to_string_lossy().to_string();
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = cache.with_extension(format!("tmp{}", REQ_SEQ.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_file(&tmp);
    let tool = match media::tool_path("ffmpeg") {
        Ok(t) => t,
        Err(e) => {
            set_job(&src, "error", 0, &e, "");
            return;
        }
    };
    // 仅复制视频轨 + 首条音轨（WebKIt 无法渲染字幕轨，部分字幕编码会令 mp4 封装失败）
    let out = std::process::Command::new(&tool)
        .args([
            "-y",
            "-i",
            &src,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            "-progress",
            "pipe:1",
            "-nostats",
        ])
        .arg(&tmp)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let mut child = match out {
        Ok(c) => c,
        Err(e) => {
            set_job(&src, "error", 0, &format!("启动 ffmpeg 失败: {}", e), "");
            return;
        }
    };
    // 后台收集 stderr 尾行（失败时给出可读原因）
    let err_pipe = child.stderr.take();
    let err_handle = std::thread::spawn(move || {
        let mut last = String::new();
        if let Some(p) = err_pipe {
            let mut reader = BufReader::new(p);
            let mut line = Vec::new();
            while matches!(reader.read_until(b'\n', &mut line), Ok(n) if n > 0) {
                let text = String::from_utf8_lossy(&line).trim().to_string();
                if !text.is_empty() {
                    last = text;
                }
                line.clear();
            }
        }
        last
    });
    // 进度：优先按时间（duration>0 时用 out_time_us/1000000 转秒算百分比），
    // duration 缺失时按字节（out_size / total_size）兜底，确保大文件进度条始终在动。
    // ffmpeg -progress 输出末尾的 progress=end 后不再写新行；读 EOF 即结束进度循环。
    if let Some(pipe) = child.stdout.take() {
        let mut reader = BufReader::new(pipe);
        let mut line = Vec::new();
        while matches!(reader.read_until(b'\n', &mut line), Ok(n) if n > 0) {
            let s = String::from_utf8_lossy(&line);
            // 优先按 out_time_us（微秒）；部分 ffmpeg 版本字段名是 out_time_ms
            // （注意：也是微秒，不是毫秒，这是 ffmpeg 历史遗留命名）。
            if let Some(v) = s.strip_prefix("out_time_us=").or_else(|| s.strip_prefix("out_time_ms=")) {
                if let Ok(us) = v.trim().parse::<f64>() {
                    if duration > 0.0 {
                        let p = ((us / 1_000_000.0) / duration * 100.0) as u32;
                        set_job(&src, "running", p.min(99), "", &cache_s);
                    }
                }
            } else if duration <= 0.0 {
                // 时长不可用 → 按已写入字节数算比例；ffmpeg 输出 out_size=N
                if let Some(v) = s.strip_prefix("out_size=") {
                    if let Ok(bytes) = v.trim().parse::<u64>() {
                        if total_size > 0 {
                            let p = (bytes * 100 / total_size) as u32;
                            set_job(&src, "running", p.min(99), "", &cache_s);
                        }
                    }
                }
            }
            // 收到 progress=end 立刻跳出，交给下面 child.wait() 处理收尾
            if s.starts_with("progress=end") {
                line.clear();
                break;
            }
            line.clear();
        }
    }
    match child.wait() {
        Ok(st) if st.success() && tmp.exists() => {
            let _ = std::fs::rename(&tmp, &cache);
            set_job(&src, "done", 100, "", &cache_s);
        }
        Ok(_) => {
            let _ = std::fs::remove_file(&tmp);
            let detail = err_handle.join().unwrap_or_default();
            set_job(
                &src,
                "error",
                0,
                &if detail.is_empty() {
                    "转封装失败（编码可能不被 MP4 容器支持）".to_string()
                } else {
                    format!("转封装失败: {}", detail)
                },
                "",
            );
        }
        Err(e) => {
            set_job(&src, "error", 0, &e.to_string(), "");
        }
    }
}

pub fn stream_base() -> Option<String> {
    server().map(|s| format!("http://127.0.0.1:{}/{}/", s.port, s.token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "vtm-stream-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moov_front_vs_late() {
        let dir = tmp_dir("moov");
        let ffmpeg = media::tool_path("ffmpeg").expect("内置 ffmpeg 缺失");
        let gen = |out: &Path, extra: &[&str]| {
            let st = std::process::Command::new(&ffmpeg)
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=duration=1:size=128x96:rate=10",
                ])
                .args(extra)
                .arg(out)
                .output()
                .unwrap();
            assert!(
                st.status.success(),
                "{}",
                String::from_utf8_lossy(&st.stderr)
            );
        };
        let front = dir.join("front.mp4");
        let late = dir.join("late.mp4");
        gen(&front, &["-movflags", "+faststart"]);
        gen(&late, &[]);
        assert_eq!(moov_position(front.to_str().unwrap()), "front");
        assert_eq!(moov_position(late.to_str().unwrap()), "late");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn start_test_server(root: PathBuf) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = Arc::new(Server {
            port: addr.port(),
            token: "tok".into(),
            root: Mutex::new(root),
        });
        std::thread::spawn(move || {
            for inc in listener.incoming() {
                let Ok(s) = inc else { continue };
                let srv2 = srv.clone();
                std::thread::spawn(move || {
                    let _ = handle_connection(s, &srv2);
                });
            }
        });
        addr
    }

    fn request(addr: std::net::SocketAddr, path: &str, range: Option<&str>) -> Vec<u8> {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut req = format!("GET {} HTTP/1.1\r\nHost: t\r\n", path);
        if let Some(r) = range {
            req.push_str(&format!("Range: {}\r\n", r));
        }
        req.push_str("Connection: close\r\n\r\n");
        s.write_all(req.as_bytes()).unwrap();
        let mut resp = Vec::new();
        s.read_to_end(&mut resp).unwrap();
        resp
    }

    fn split(resp: &[u8]) -> (String, Vec<u8>) {
        let pos = resp
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("no header end");
        (
            String::from_utf8_lossy(&resp[..pos]).to_string(),
            resp[pos + 4..].to_vec(),
        )
    }

    #[test]
    fn range_semantics_and_guard() {
        let dir = tmp_dir("range");
        // 1MB 伪随机确定性数据
        let data: Vec<u8> = (0..1_000_000u32).map(|i| (i % 251) as u8).collect();
        let f = dir.join("movie.mp4");
        std::fs::write(&f, &data).unwrap();
        let addr = start_test_server(dir.clone());
        let p64 = B64.encode(f.to_str().unwrap());

        // 完整请求 → 200 + 全部内容
        let (head, body) = split(&request(addr, &format!("/tok/raw/{}", p64), None));
        assert!(head.contains("200 OK"), "{}", head);
        assert!(head.contains("Accept-Ranges: bytes"), "{}", head);
        assert_eq!(body.len(), data.len());
        assert_eq!(body, data);

        // bytes=100-199 → 206 + 精确区间
        let (head, body) = split(&request(
            addr,
            &format!("/tok/raw/{}", p64),
            Some("bytes=100-199"),
        ));
        assert!(head.contains("206 Partial Content"), "{}", head);
        assert!(head.contains("Content-Range: bytes 100-199/1000000"), "{}", head);
        assert_eq!(body.len(), 100);
        assert_eq!(body, data[100..200]);

        // 开区间 bytes=999999- → 末字节
        let (head, body) = split(&request(
            addr,
            &format!("/tok/raw/{}", p64),
            Some("bytes=999999-"),
        ));
        assert!(head.contains("206"), "{}", head);
        assert_eq!(body, &data[999999..]);

        // 后缀区间 bytes=-10 → 最后 10 字节
        let (head, body) = split(&request(
            addr,
            &format!("/tok/raw/{}", p64),
            Some("bytes=-10"),
        ));
        assert!(head.contains("206"), "{}", head);
        assert_eq!(body, &data[999990..]);

        // 越界 Range → 416
        let (head, _) = split(&request(
            addr,
            &format!("/tok/raw/{}", p64),
            Some("bytes=2000000-"),
        ));
        assert!(head.contains("416"), "{}", head);

        // `..` 词法绕过 → 403（canonicalize 后不再位于根内）
        let parent = B64.encode(
            dir.parent()
                .unwrap()
                .join("escaped.mp4")
                .to_string_lossy()
                .to_string(),
        );
        let (head, _) = split(&request(addr, &format!("/tok/raw/{}", parent), None));
        assert!(head.contains("403") || head.contains("404"), "{}", head);

        // 资料库外的路径 → 403/404
        let outside = B64.encode("/etc/hosts");
        let (head, _) = split(&request(addr, &format!("/tok/raw/{}", outside), None));
        assert!(head.contains("403") || head.contains("404"), "{}", head);

        // 令牌错误 → 404
        let (head, _) = split(&request(addr, &format!("/bad/raw/{}", p64), None));
        assert!(head.contains("404"), "{}", head);

        // cache 端点在缓存缺失时 → 404
        let (head, _) = split(&request(addr, &format!("/tok/cache/{}", p64), None));
        assert!(head.contains("404"), "{}", head);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remux_produces_faststart_cache() {
        let dir = tmp_dir("remux");
        let ffmpeg = media::tool_path("ffmpeg").expect("内置 ffmpeg 缺失");
        let src = dir.join("late.mp4");
        // testsrc 默认是 wrapped_avframe 伪编码（无法流复制），改用内置 mpeg4 编码器
        let st = std::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=2:size=128x96:rate=10",
                "-c:v",
                "mpeg4",
            ])
            .arg(&src)
            .output()
            .unwrap();
        assert!(st.status.success());
        assert_eq!(moov_position(src.to_str().unwrap()), "late");

        let root = dir.clone();
        let job = start_remux(&root, src.to_str().unwrap());
        assert_eq!(job.status, "running");
        // 等待后台转封装完成（小文件秒级）
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(100));
            let j = remux_status(&root, src.to_str().unwrap());
            if j.status == "done" || j.status == "error" {
                assert_eq!(j.status, "done", "remux error: {}", j.error);
                assert!(!j.cache.is_empty());
                break;
            }
        }
        let cache = remux_cache_path(&root, src.to_str().unwrap());
        assert!(cache.exists(), "缓存副本应已生成");
        assert_eq!(moov_position(cache.to_str().unwrap()), "front", "缓存应为 faststart");

        // 已删除文件的转封装应快速返回 error 而不是空跑 ffmpeg
        let gone = dir.join("gone.mp4");
        let j = start_remux(&root, gone.to_str().unwrap());
        assert_eq!(j.status, "error");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 1.0.2-r3「关闭即删」：cleanup_remux 应删除转封装副本与任务记录，
    /// 且删除后再次播放能正常重建副本（可再生的验证）。
    #[test]
    fn cleanup_remux_deletes_cache_and_rebuilds() {
        let dir = tmp_dir("cleanup");
        let ffmpeg = media::tool_path("ffmpeg").expect("内置 ffmpeg 缺失");
        let src = dir.join("late.mp4");
        let st = std::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=2:size=128x96:rate=10",
                "-c:v",
                "mpeg4",
            ])
            .arg(&src)
            .output()
            .unwrap();
        assert!(st.status.success());

        let root = dir.clone();
        // 第一轮：转封装 → 副本存在 → 清理 → 副本与任务记录消失
        let job = start_remux(&root, src.to_str().unwrap());
        assert_eq!(job.status, "running");
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(100));
            if remux_status(&root, src.to_str().unwrap()).status != "running" {
                break;
            }
        }
        let cache = remux_cache_path(&root, src.to_str().unwrap());
        assert!(cache.exists(), "清理前副本应存在");

        assert!(cleanup_remux(&root, src.to_str().unwrap()), "应删除了副本");
        assert!(!cache.exists(), "清理后副本应不存在");
        // 任务记录应被移除（后续 start_remux 不会误判 done）
        assert!(jobs().lock().unwrap().get(src.to_str().unwrap()).is_none());
        // 重复清理应为 no-op（返回 false）
        assert!(!cleanup_remux(&root, src.to_str().unwrap()), "重复清理应返回 false");

        // 第二轮：删除后再次播放能重建（副本可再生）
        let job2 = start_remux(&root, src.to_str().unwrap());
        assert_eq!(job2.status, "running");
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(100));
            if remux_status(&root, src.to_str().unwrap()).status != "running" {
                break;
            }
        }
        assert!(cache.exists(), "重建后副本应再次存在");
        assert_eq!(
            moov_position(cache.to_str().unwrap()),
            "front",
            "重建副本仍应为 faststart"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}