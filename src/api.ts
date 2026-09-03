import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { SubtitleCue } from "./subtitles";

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  kind: string;
  ext: string;
  size: number;
  created_ms: number;
  modified_ms: number;
  cover: string | null;
  tag: string | null;
  dir_size: number | null;
}
export interface DirMeta {
  path: string;
  title: string | null;
  year: number | null;
  overview: string | null;
  rating: number | null;
  tmdb_id: number | null;
  poster_file: string | null;
}
export interface DirListing {
  path: string;
  name: string;
  parent: string | null;
  entries: Entry[];
  meta: DirMeta | null;
}
export interface SearchResult {
  path: string;
  parent: string;
  name: string;
  is_dir: boolean;
  kind: string;
  size: number;
  created_ms: number;
}
export interface TrashItem {
  id: string;
  name: string;
  orig_path: string;
  trash_path: string;
  is_dir: boolean;
  size: number;
  deleted_at: number;
  /** 1.0.2-r6：自动清除到期时刻（epoch ms）；0 = 永不自动清除 */
  expire_at: number;
}
export interface FavoriteItem {
  path: string;
  name: string;
  is_dir: boolean;
  kind: string;
  cat_id: number;
}
export interface FavCategory {
  id: number;
  name: string;
}
export interface DirNode {
  path: string;
  name: string;
  children: DirNode[];
}
export interface InstalledApp {
  name: string;
  path: string;
}
export interface VideoInfo {
  duration: number | null;
  width: number | null;
  height: number | null;
}
export interface PhotoDate {
  path: string;
  taken_ms: number | null;
}
export interface ScanStatus {
  running: boolean;
  last_scan: number | null;
  count: number;
}
export interface Stats {
  files: number;
  dirs: number;
  videos: number;
  images: number;
  total_size: number;
  last_scan: number | null;
}
export interface TmdbMovie {
  id: number;
  title: string;
  original_title: string | null;
  year: number | null;
  overview: string | null;
  rating: number | null;
  poster_url: string | null;
}
export interface MediaTrack {
  kind: string;
  codec: string;
  detail: string;
}
export interface MediaInfo {
  container: string;
  duration: number | null;
  bitrate: number | null;
  size: number;
  tracks: MediaTrack[];
  width: number | null;
  height: number | null;
  taken_ms: number | null;
  camera: string | null;
  lens: string | null;
  iso: string | null;
  aperture: string | null;
  shutter: string | null;
  focal: string | null;
  gps: string | null;
  created_ms: number;
  modified_ms: number;
  dir_size: number | null;
  entry_count: number | null;
}
export interface OrganizePlanItem {
  from: string;
  to: string;
  name: string;
  conflict: boolean;
}
export interface AppInfo {
  version: string;
  ffmpeg_ok: boolean;
  home: string;
}
export interface LibraryCandidate {
  last: string | null;
  candidate: string | null;
}

export interface ThumbReq {
  path: string;
  is_dir: boolean;
  is_video: boolean;
}
export interface ThumbRes {
  path: string;
  thumb: string | null;
}

/** 设置面板「存储空间」占用明细（1.0.1-r13，1.0.2 增加应用本体大小） */
export interface DiskUsage {
  total_bytes: number;
  thumbs_bytes: number;
  previews_bytes: number;
  remux_bytes: number;
  covers_bytes: number;
  trash_bytes: number;
  db_bytes: number;
  /** 应用本体（.app 安装包 / 可执行文件）大小 */
  app_bytes: number;
}

export function assetUrl(p: string): string {
  return convertFileSrc(p);
}

/** PiP 媒体条目（最小字段集，从主窗口传给独立窗口） */
export interface PipMedia {
  path: string;
  name: string;
  kind: string;
  cover: string | null;
}
export interface PipPayload {
  kind: "video" | "image";
  list: PipMedia[];
  index: number;
  root: string;
  covers_dir: string;
  /** 主窗口进入全屏时的画面变换快照（图片专用）：PiP 窗口据此初始化，全屏/非全屏同步共用 */
  init_rot?: number;
  init_scale?: number;
  init_tx?: number;
  init_ty?: number;
  /** 主窗口进入全屏时的字幕快照（视频专用，1.0.2-r7）：PiP 窗口据此渲染同一字幕 */
  subtitle?: { cues: SubtitleCue[]; size: number; enabled: boolean };
}

/** 视频同目录探测到的字幕文件（1.0.2-r7） */
export interface SubtitleTrack {
  path: string;
  name: string;
}

/** 独立全屏窗口回写给主窗口的即时状态（退出全屏后据此续播/续看） */
export interface PipState {
  index: number; // 当前播放/查看的队列下标
  time: number; // 视频当前播放位置（秒）；图片恒为 0
  rot: number; // 图片旋转角度（0/90/180/270）
  scale: number; // 图片缩放系数
  tx: number; // 图片平移 X
  ty: number; // 图片平移 Y
}

const VIDEO_EXTS = new Set([
  "mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "webm", "ts", "mpg", "mpeg",
  "rmvb", "rm", "3gp", "vob", "m2ts", "f4v", "ogv", "asf", "divx", "m4p", "mxf",
]);

export function isVideoName(name: string): boolean {
  const e = name.split(".").pop()?.toLowerCase() || "";
  return VIDEO_EXTS.has(e);
}

export interface RemuxStatus {
  status: "idle" | "running" | "done" | "error";
  percent: number;
  error: string;
}

/** 进度条悬停帧预览精灵图（1.0.2-r5）：后端按 (path+mtime) 缓存生成 */
export interface ScrubSheetStatus {
  status: "generating" | "ready" | "failed";
  percent: number;
  /** ready 时返回（Rust 端 serde(flatten) 平铺输出） */
  duration?: number;
  tiles?: number;
  cols?: number;
  rows?: number;
  interval?: number;
  tile_w?: number;
  tile_h?: number;
  /** ready 时的网格图路径（assetUrl 转资产地址） */
  path?: string | null;
}

/** 路径转 URL 安全 base64（本地流服务寻址用，中文与空格安全） */
export function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  detectLibrary: () => invoke<LibraryCandidate>("detect_library"),
  openLibrary: (root: string) => invoke<string>("open_library", { root }),
  getPaths: () =>
    invoke<{ root: string; covers_dir: string; vtm_dir: string }>("get_paths"),
  listDir: (path: string) => invoke<DirListing>("list_dir", { path }),
  createDir: (parent: string, name: string) =>
    invoke<string>("create_dir", { parent, name }),
  renameEntry: (path: string, newName: string) =>
    invoke<string>("rename_entry", { path, newName }),
  moveEntries: (paths: string[], dest: string) =>
    invoke<void>("move_entries", { paths, dest }),
  copyEntries: (paths: string[], dest: string) =>
    invoke<number>("copy_entries", { paths, dest }),
  deleteEntries: (paths: string[]) => invoke<void>("delete_entries", { paths }),
  listTrash: () => invoke<TrashItem[]>("list_trash"),
  restoreTrash: (ids: string[]) => invoke<void>("restore_trash", { ids }),
  deleteForever: (ids: string[]) => invoke<void>("delete_forever", { ids }),
  emptyTrash: () => invoke<void>("empty_trash"),
  /** 1.0.2-r6：设置回收站自动清除间隔天数（0 = 永不），并重置在站条目的到期时间 */
  setTrashTtlDays: (days: number) => invoke<void>("set_trash_ttl_days", { days }),
  /** 1.0.2-r6：立即清扫已到期条目，返回清除条数 */
  sweepTrash: () => invoke<number>("sweep_trash"),
  getThumbs: (items: ThumbReq[]) => invoke<ThumbRes[]>("get_thumbs", { items }),
  getPreview: (path: string) => invoke<string | null>("get_preview", { path }),
  diskUsage: () => invoke<DiskUsage>("disk_usage"),
  clearCache: () => invoke<number>("clear_cache"),
  /** 1.0.2：数据库一键优化（WAL checkpoint + VACUUM），返回释放的字节数 */
  optimizeDb: () => invoke<number>("optimize_db"),
  /** 1.0.2：后台低优先级预生成当前目录缺失的缩略图（完成后发 thumbs-prewarmed 事件） */
  prewarmThumbs: (dir: string) => invoke<void>("prewarm_thumbs", { dir }),
  captureFrame: (video: string, time: number) =>
    invoke<string>("capture_frame", { video, time }),
  /** 1.0.2-r7：扫描视频同目录的同名字幕文件 */
  probeSubtitles: (video: string) => invoke<SubtitleTrack[]>("probe_subtitles", { video }),
  /** 1.0.2-r7：读取字幕文本（后端自动识别 UTF-8/UTF-16/GBK，返回 UTF-8） */
  readSubtitle: (path: string) => invoke<string>("read_subtitle", { path }),
  /** 1.0.2-r7：播放器截图（当前帧 → 原分辨率 PNG），destDir 缺省为资料库/captures */
  captureSnapshot: (video: string, time: number, destDir?: string | null) =>
    invoke<string>("capture_snapshot", { video, time, destDir: destDir ?? null }),
  /** 1.0.2-r7：系统对话框选择字幕文件（.srt/.vtt），取消返回 null */
  pickSubtitleFile: () => invoke<string | null>("pick_subtitle_file"),
  /** 1.0.2-r7：系统对话框选择截图保存目录，取消返回 null */
  pickFolder: () => invoke<string | null>("pick_folder"),
  setCover: (
    target: string,
    opts: {
      imagePath?: string | null;
      videoPath?: string | null;
      frameTime?: number | null;
      source?: string | null;
    } = {}
  ) =>
    invoke<string>("set_cover", {
      target,
      imagePath: opts.imagePath ?? null,
      videoPath: opts.videoPath ?? null,
      frameTime: opts.frameTime ?? null,
      source: opts.source ?? null,
    }),
  videoInfo: (path: string) => invoke<VideoInfo>("video_info", { path }),
  mediaDates: (dirPath: string) =>
    invoke<PhotoDate[]>("media_dates", { dirPath }),
  dirTree: () => invoke<DirNode[]>("dir_tree"),
  search: (query: string) => invoke<SearchResult[]>("search", { query }),
  scanStart: () => invoke<void>("scan_start"),
  scanStatus: () => invoke<ScanStatus>("scan_status"),
  stats: () => invoke<Stats>("stats"),
  recentFiles: (limit: number) =>
    invoke<SearchResult[]>("recent_files", { limit }),
  addFavorite: (path: string, catId = 0) =>
    invoke<void>("add_favorite", { path, catId }),
  removeFavorite: (path: string) => invoke<void>("remove_favorite", { path }),
  listFavorites: () => invoke<FavoriteItem[]>("list_favorites"),
  listFavCategories: () => invoke<FavCategory[]>("list_fav_categories"),
  addFavCategory: (name: string) => invoke<number>("add_fav_category", { name }),
  renameFavCategory: (id: number, name: string) =>
    invoke<void>("rename_fav_category", { id, name }),
  deleteFavCategory: (id: number) => invoke<void>("delete_fav_category", { id }),
  listApps: () => invoke<InstalledApp[]>("list_apps"),
  openWith: (path: string, app?: string | null) =>
    invoke<void>("open_with", { path, app: app ?? null }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  // 1.0.2-r10：在文件管理器中打开目录并进入（设置「进入缓存目录」）
  openDirectory: (path: string) => invoke<void>("open_directory", { path }),
  streamBase: () => invoke<string>("stream_base"),
  moovPosition: (path: string) => invoke<string>("moov_position", { path }),
  startRemux: (path: string) => invoke<RemuxStatus>("start_remux", { path }),
  remuxStatus: (path: string) => invoke<RemuxStatus>("remux_status", { path }),
  // 1.0.2-r3「关闭即删」：清理某视频的转封装缓存副本（等大副本，可再生）
  cleanupRemux: (path: string) => invoke<boolean>("cleanup_remux", { path }),
  /** 1.0.2-r5：进度条悬停帧预览精灵图（查询/触发生成，轮询至 ready） */
  scrubSheet: (path: string, duration: number) =>
    invoke<ScrubSheetStatus>("scrub_sheet", { path, duration }),
  getSettings: () => invoke<Record<string, string>>("get_settings"),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  // 全局偏好：与资料库无关（存应用数据目录 prefs.json）—— 日夜主题等
  // 全局状态走这里，避免切换资料库时随库级 settings 一起被换掉
  getPref: (key: string) => invoke<string | null>("get_pref", { key }),
  setPref: (key: string, value: string) =>
    invoke<void>("set_pref", { key, value }),
  tmdbSearch: (query: string) => invoke<TmdbMovie[]>("tmdb_search", { query }),
  tmdbApply: (dirPath: string, id: number) =>
    invoke<DirMeta>("tmdb_apply", { dirPath, id }),
  setTag: (path: string, color: string | null) =>
    invoke<void>("set_tag", { path, color }),
  tagRoots: (color: string) => invoke<SearchResult[]>("tag_roots", { color }),
  mediaInfo: (path: string, kind: string) =>
    invoke<MediaInfo>("media_info", { path, kind }),
  smartOrganizePlan: (dir: string) =>
    invoke<OrganizePlanItem[]>("smart_organize_plan", { dir }),
  smartOrganizeApply: (items: OrganizePlanItem[]) =>
    invoke<number>("smart_organize_apply", { items }),
  openPipWindow: (args: {
    kind: "video" | "image";
    list: PipMedia[];
    index: number;
    root: string;
    covers_dir: string;
    init_rot?: number;
    init_scale?: number;
    init_tx?: number;
    init_ty?: number;
    subtitle?: { cues: SubtitleCue[]; size: number; enabled: boolean };
  }) => invoke<string>("open_pip_window", { args }),
  getPipPayload: (label: string) => invoke<PipPayload>("get_pip_payload", { label }),
  closePipWindow: (label: string) => invoke<void>("close_pip_window", { label }),
  setPipState: (label: string, state: PipState) =>
    invoke<void>("set_pip_state", { label, state }),
  takePipState: (label: string) => invoke<PipState | null>("take_pip_state", { label }),
};

export function fmtSize(n: number): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDay(ms: number): string {
  if (!ms) return "未知日期";
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
