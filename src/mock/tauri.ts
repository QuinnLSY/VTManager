// 仅在 VITE_MOCK=1 的浏览器联调环境下替代 @tauri-apps/api/core。
// 模拟后端命令，让真实前端代码（含 ColumnView 分栏逻辑）可在 Chrome 中运行与实测。
// 生产构建（无 VITE_MOCK）不会引用本文件。

import { emitMock } from "./shims";

const ROOT = "/Volumes/VTMock";

interface FakeItem {
  name: string;
  is_dir: boolean;
  kind: string;
  size: number;
}

const NOW = Date.now();

// 静态标签：电影文件夹标红（子项继承）、单个视频标蓝 —— 供浏览器实测标签视图
const TAG_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"];
const TAGS: Record<string, string> = {
  "/Volumes/VTMock/电影": "red",
  "/Volumes/VTMock/千与千寻.mp4": "blue",
};

// 收藏与分类（供浏览器实测收藏夹分类：新建/重命名/删除/归类收藏）
let FAV_CAT_SEQ = 1;
const FAV_CATS: { id: number; name: string }[] = [];
const FAVS: { path: string; name: string; added_at: number; cat_id: number }[] = [];

function tagOf(path: string): string | null {
  if (TAGS[path]) return TAGS[path];
  let cur = path;
  for (;;) {
    const i = Math.max(cur.lastIndexOf("/"), cur.lastIndexOf("\\"));
    if (i <= 0) return null;
    cur = cur.slice(0, i);
    if (TAGS[cur]) return TAGS[cur];
  }
}

const TREE: Record<string, FakeItem[]> = {
  "": [
    { name: "电影", is_dir: true, kind: "dir", size: 0 },
    { name: "照片", is_dir: true, kind: "dir", size: 0 },
    { name: "剧集", is_dir: true, kind: "dir", size: 0 },
    { name: "千与千寻.mp4", is_dir: false, kind: "video", size: 457 * 1024 },
    { name: "海贼王.jpg", is_dir: false, kind: "image", size: 300 * 1024 },
    { name: "火影.png", is_dir: false, kind: "image", size: 200 * 1024 },
  ],
  电影: [
    { name: "千与千寻.mp4", is_dir: false, kind: "video", size: 457 * 1024 },
    { name: "天空之城.mp4", is_dir: false, kind: "video", size: 700 * 1024 },
    { name: "龙猫.mkv", is_dir: false, kind: "video", size: 900 * 1024 },
    { name: "哈尔的移动城堡.mp4", is_dir: false, kind: "video", size: 640 * 1024 },
    { name: "备注.txt", is_dir: false, kind: "doc", size: 12 },
  ],
  照片: [
    { name: "海边.jpg", is_dir: false, kind: "image", size: 300 * 1024 },
    { name: "山上.png", is_dir: false, kind: "image", size: 240 * 1024 },
    { name: "城市.jpg", is_dir: false, kind: "image", size: 180 * 1024 },
  ],
  // 超大目录：160 项 > 虚拟滚动阈值 120，用于浏览器实测虚拟滚动
  //（只渲染可视区卡片、滚动后动态替换、DOM 卡片数远小于条目数）
  剧集: Array.from({ length: 160 }, (_, i) => ({
    name: `剧集第${String(i + 1).padStart(3, "0")}部.mp4`,
    is_dir: false,
    kind: "video",
    size: (i + 1) * 100 * 1024,
  })),
};

function norm(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (s.startsWith(ROOT)) s = s.slice(ROOT.length);
  if (s.startsWith("/")) s = s.slice(1);
  return s;
}

// ---------- 回收站（1.0.2-r6）：可变数组 + localStorage 持久化，支持增删/恢复/到期展示 ----------
interface MockTrashItem {
  id: string;
  name: string;
  orig_path: string;
  trash_path: string;
  is_dir: boolean;
  size: number;
  deleted_at: number;
}
function defaultTrash(): MockTrashItem[] {
  return [
    {
      id: "t1",
      name: "废片.mp4",
      orig_path: `${ROOT}/废片.mp4`,
      trash_path: `${ROOT}/.VTManager/.trash/t1_废片.mp4`,
      is_dir: false,
      size: 100 * 1024,
      deleted_at: Date.now() - 3_600_000,
    },
    {
      id: "t2",
      name: "旧照.jpg",
      orig_path: `${ROOT}/旧照.jpg`,
      trash_path: `${ROOT}/.VTManager/.trash/t2_旧照.jpg`,
      is_dir: false,
      size: 50 * 1024,
      deleted_at: Date.now() - 7_200_000,
    },
  ];
}
let MOCK_TRASH_SEQ = 3;
function mockTrashLoad(): MockTrashItem[] {
  const s = pipStore("__vt_trash");
  return Array.isArray(s.items) && s.items.length ? (s.items as MockTrashItem[]) : defaultTrash();
}
let MOCK_TRASH: MockTrashItem[] = mockTrashLoad();
function mockTrashSave() {
  pipSave("__vt_trash", { items: MOCK_TRASH });
}
function mockTrashList(): (MockTrashItem & { expire_at: number })[] {
  const days = Number(pipStore("__vt_settings")["trash_ttl_days"] ?? 3);
  const ttl = days > 0 ? days * 86_400_000 : 0;
  return [...MOCK_TRASH]
    .sort((a, b) => b.deleted_at - a.deleted_at)
    .map((t) => ({ ...t, expire_at: ttl ? t.deleted_at + ttl : 0 }));
}

function join(root: string, name: string): string {
  return `${root.replace(/\/+$/, "")}/${name}`;
}

function favExists(p: string): boolean {
  if (p === ROOT) return true;
  const rel = norm(p);
  if (rel in TREE) return true;
  const parent = p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
  return (TREE[norm(parent)] || []).some((it) => join(norm(parent) ? `${ROOT}/${norm(parent)}` : ROOT, it.name) === p);
}

// 独立全屏窗口（PiP）的 mock 状态：payload 表 / 状态回写表 / 关闭标记。
// 真实实现里这份数据在 Rust 侧，主窗口与独立窗口通过 invoke 共享；
// 浏览器联调里两个页面共享 localStorage，因此落到 localStorage 上模拟同一份共享状态。
const PIP_PAYLOAD: Record<string, any> = {};
const PIP_STATE: Record<string, any> = {};
const PIP_CLOSED: Record<string, boolean> = {};

function pipStore(key: string): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
}
function pipSave(key: string, obj: Record<string, any>) {
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function favInfo(f: { path: string; name: string; added_at: number; cat_id: number }) {
  const p = f.path;
  const isDir = p === ROOT || Object.keys(TREE).some((k) => k && join(ROOT, k) === p);
  const kind = isDir
    ? "dir"
    : /\.(mp4|mkv|mov)$/i.test(p)
      ? "video"
      : /\.(jpg|jpeg|png|gif|webp)$/i.test(p)
        ? "image"
        : "doc";
  return { path: p, name: f.name, is_dir: isDir, kind, cat_id: f.cat_id };
}

function listing(dirPath: string) {
  const rel = norm(dirPath);
  if (!(rel in TREE)) throw new Error(`mock: 目录不存在 ${dirPath}`);
  const entries = TREE[rel].map((it, i) => ({
    name: it.name,
    path: join(rel ? `${ROOT}/${rel}` : ROOT, it.name),
    is_dir: it.is_dir,
    kind: it.kind,
    ext: it.is_dir ? "" : (it.name.split(".").pop() || "").toLowerCase(),
    size: it.size,
    created_ms: NOW - (i + 1) * 86_400_000,
    modified_ms: NOW - (i + 1) * 3_600_000,
    cover: null,
    tag: tagOf(join(rel ? `${ROOT}/${rel}` : ROOT, it.name)),
    dir_size: it.is_dir ? 1024 * 1024 : null,
  }));
  const parent =
    rel === "" ? null : join(ROOT, rel.split("/").slice(0, -1).join("/")) || ROOT;
  return {
    path: rel ? join(ROOT, rel) : ROOT,
    name: rel ? rel.split("/").pop() || rel : "VTMock",
    parent: parent && parent !== ROOT ? parent : rel === "" ? null : ROOT,
    entries,
    meta: null,
  };
}

export async function invoke(cmd: string, args?: any): Promise<any> {
  switch (cmd) {
    case "app_info":
      return { version: "1.0.2-mock", ffmpeg_ok: true, home: "/tmp" };
    case "list_apps":
      return [];
    case "detect_library":
      return { last: ROOT, candidate: null };
    case "open_library":
      return String(args?.root ?? ROOT);
    case "get_paths":
      return {
        root: ROOT,
        covers_dir: `${ROOT}/.VTManager/covers`,
        vtm_dir: `${ROOT}/.VTManager`,
      };
    case "get_settings":
      // 1.0.2-r8：真实实现存应用数据目录 prefs.json（与资料库无关，切库不重置）；
      // mock 用 localStorage 模拟同一份全局存储，天然满足「切换根目录设置保持」。
      return pipStore("__vt_settings");
    case "list_favorites":
      return FAVS.filter((f) => favExists(f.path)).map((f) => favInfo(f));
    case "list_fav_categories":
      return FAV_CATS.map((c) => ({ ...c }));
    case "add_fav_category": {
      const n = String(args?.name ?? "").trim();
      if (!n) throw new Error("分类名不能为空");
      if (FAV_CATS.some((c) => c.name === n)) throw new Error("同名分类已存在");
      const id = FAV_CAT_SEQ++;
      FAV_CATS.push({ id, name: n });
      return id;
    }
    case "rename_fav_category": {
      const id = Number(args?.id ?? 0);
      const n = String(args?.name ?? "").trim();
      const c = FAV_CATS.find((x) => x.id === id);
      if (!c) throw new Error("分类不存在");
      if (FAV_CATS.some((x) => x.id !== id && x.name === n)) throw new Error("同名分类已存在");
      c.name = n;
      return;
    }
    case "delete_fav_category": {
      const id = Number(args?.id ?? 0);
      for (const f of FAVS) if (f.cat_id === id) f.cat_id = 0;
      const i = FAV_CATS.findIndex((x) => x.id === id);
      if (i >= 0) FAV_CATS.splice(i, 1);
      return;
    }
    case "add_favorite": {
      const p = String(args?.path ?? "");
      const catId = Number(args?.catId ?? 0);
      const name = p.split("/").pop() || p;
      const existed = FAVS.find((f) => f.path === p);
      // 与真实后端一致：catId<=0 时不改变已有收藏的分类归属
      if (existed) {
        if (catId > 0) existed.cat_id = catId;
      } else {
        FAVS.unshift({ path: p, name, added_at: Date.now(), cat_id: Math.max(0, catId) });
      }
      return;
    }
    case "remove_favorite": {
      const i = FAVS.findIndex((f) => f.path === String(args?.path ?? ""));
      if (i >= 0) FAVS.splice(i, 1);
      return;
    }
    case "list_dir":
      return listing(String(args?.path ?? ROOT));
    case "get_thumbs":
      // 1×1 蓝色 PNG，验证缩略图 <img> 渲染链路
      return (args?.items ?? []).map((i: any) => ({
        path: i.path,
        thumb:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      }));
    case "get_preview":
      // 大图查看预览：mock 下返回 null（回退原图即可，真实后端大图才返回降采样路径）
      return null;
    case "disk_usage": {
      const cache = 2 * 1024 * 1024 + 512 * 1024; // 缩略图+预览+转封装 约 2.5MB
      return {
        total_bytes: cache + 1_200_000,
        thumbs_bytes: 1_200_000,
        previews_bytes: 512 * 1024,
        remux_bytes: 384 * 1024,
        covers_bytes: 900_000,
        trash_bytes: 0,
        db_bytes: 120_000,
        app_bytes: 66_000_000, // 应用本体约 63MB（1.0.2 移除 ffprobe 后）
      };
    }
    case "clear_cache":
      return 2_000_000;
    case "optimize_db":
      // 数据库一键优化：mock 下模拟释放 500KB（db 从 620KB 压到 120KB）
      return 500_000;
    case "prewarm_thumbs":
      // 空闲预生成缩略图：mock 下直接成功（无真实文件，无需生成）
      return null;
    case "scan_status":
      return { running: false, last_scan: NOW, count: 42 };
    case "stats":
      return { files: 8, dirs: 2, videos: 4, images: 4, total_size: 3_600_000, last_scan: NOW };
    case "dir_tree":
      return [];
    case "recent_files": {
      // 全部文件按创建时间倒序（供「最近添加 → 点击定位」链路实测）
      const out: any[] = [];
      for (const [rel, items] of Object.entries(TREE)) {
        if (!rel) continue;
        items.forEach((it, i) => {
          if (it.is_dir) return;
          out.push({
            path: join(`${ROOT}/${rel}`, it.name),
            parent: join(ROOT, rel),
            name: it.name,
            is_dir: false,
            kind: it.kind,
            size: it.size,
            created_ms: NOW - (i + 1) * 86_400_000,
          });
        });
      }
      return out.sort((a, b) => b.created_ms - a.created_ms);
    }
    case "search": {
      // 与真实后端一致：文件名任意片段模糊匹配（含 is_dir 目录结果、根目录文件）
      const q = String(args?.query ?? args?.q ?? "").trim().toLowerCase();
      if (!q) return [];
      const out: any[] = [];
      for (const [rel, items] of Object.entries(TREE)) {
        items.forEach((it, i) => {
          if (!it.name.toLowerCase().includes(q)) return;
          out.push({
            path: join(rel ? `${ROOT}/${rel}` : ROOT, it.name),
            parent: rel ? join(ROOT, rel) : ROOT,
            name: it.name,
            is_dir: it.is_dir,
            kind: it.kind,
            size: it.size,
            created_ms: NOW - (i + 1) * 86_400_000,
          });
        });
      }
      return out;
    }
    case "set_tag": {
      const p = String(args?.path ?? "");
      const c = args?.color ?? null;
      if (c && TAG_COLORS.includes(String(c))) TAGS[p] = String(c);
      else delete TAGS[p];
      return;
    }
    case "set_setting": {
      const s = pipStore("__vt_settings");
      s[String(args?.key ?? "")] = String(args?.value ?? "");
      pipSave("__vt_settings", s);
      return;
    }
    // 全局偏好：真实实现存应用数据目录 prefs.json（与资料库无关）。
    // mock 里落 localStorage，主窗口与独立窗口共享同一份。
    case "get_pref":
      return pipStore("__vt_prefs")[String(args?.key ?? "")] ?? null;
    case "set_pref": {
      const p = pipStore("__vt_prefs");
      p[String(args?.key ?? "")] = String(args?.value ?? "");
      pipSave("__vt_prefs", p);
      return;
    }
    case "tag_roots": {      const color = String(args?.color ?? "");
      return Object.entries(TAGS)
        .filter(([, c]) => c === color)
        .filter(([p]) => !Object.keys(TAGS).some((a) => a !== p && (p.startsWith(a + "/") || p.startsWith(a + "\\"))))
        .map(([p]) => {
          const name = p.split("/").pop() || p;
          const isDir = !!TREE[""]?.find((it) => it.name === name && it.is_dir) || name === "电影";
          return {
            path: p,
            parent: p.slice(0, p.lastIndexOf("/")),
            name,
            is_dir: isDir,
            kind: isDir ? "dir" : name.toLowerCase().endsWith(".mp4") ? "video" : "image",
            size: 100 * 1024,
            created_ms: NOW - 86_400_000,
          };
        });
    }
    case "list_trash":
      // 1.0.2-r6：可变回收站 + 到期时刻（ttl 来自设置，默认 3 天；0 = 永不）
      return mockTrashList();
    case "delete_entries": {
      // 移入回收站：为每个路径生成条目（真实后端会移动文件到 .trash，mock 只记录）
      const paths: string[] = args?.paths ?? [];
      for (const p of paths) {
        const name = p.split("/").pop() || p;
        const kind = name.toLowerCase().endsWith(".mp4") ? "video" : /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i.test(name) ? "image" : "doc";
        MOCK_TRASH.push({
          id: `t${MOCK_TRASH_SEQ++}`,
          name,
          orig_path: p,
          trash_path: `${ROOT}/.VTManager/.trash/t${MOCK_TRASH_SEQ - 1}_${name}`,
          is_dir: false,
          size: (kind === "video" ? 300 : kind === "image" ? 100 : 2) * 1024,
          deleted_at: Date.now(),
        });
      }
      mockTrashSave();
      return null;
    }
    case "restore_trash": {
      const ids: string[] = args?.ids ?? [];
      MOCK_TRASH = MOCK_TRASH.filter((t) => !ids.includes(t.id));
      mockTrashSave();
      return null;
    }
    case "delete_forever": {
      const ids: string[] = args?.ids ?? [];
      MOCK_TRASH = MOCK_TRASH.filter((t) => !ids.includes(t.id));
      mockTrashSave();
      return null;
    }
    case "empty_trash":
      MOCK_TRASH = [];
      mockTrashSave();
      return null;
    case "set_trash_ttl_days":
      // 真实后端会顺带重置在站条目的到期时间；mock 只持久化设置，
      // list_trash 每次按设置重算，联调效果等价。
      const s = pipStore("__vt_settings");
      s["trash_ttl_days"] = String(args.days);
      pipSave("__vt_settings", s);
      return null;
    case "sweep_trash":
      return 0;
    case "stream_base":
      // Mock 流服务：由 vite 的 mockStreamPlugin 提供真实可播的 MP4（支持 Range）
      // 见 vite.config.ts —— 这样浏览器联调时播放器/全屏链路可以端到端实测。
      return `${window.location.origin}/__mockstream/`;
    case "moov_position":
      // 浏览器 mock 下视为 "front"，跳过转封装走 raw 路径
      return "front";
    case "start_remux":
      // Mock 转封装：立即返回 done（缓存命中模拟）
      return { status: "done", percent: 100, error: "", cache: "mock-cache.mp4" };
    case "remux_status":
      return { status: "done", percent: 100, error: "", cache: "mock-cache.mp4" };
    case "cleanup_remux":
      // 1.0.2-r3「关闭即删」：mock 下无真实副本，返回未删除
      return false;
    case "scrub_sheet": {
      // 1.0.2-r5 进度条悬停帧预览精灵图：mock 直接 ready，
      // path 会被 convertFileSrc 转成占位渐变图，足够联调 DOM/交互/轮询逻辑
      const d = Number(args?.duration || 0);
      const tiles = d > 0 ? Math.max(24, Math.min(120, Math.round(d / 10))) : 24;
      const cols = Math.min(10, tiles);
      return {
        status: "ready",
        percent: 100,
        duration: d,
        tiles,
        cols,
        rows: Math.ceil(tiles / cols),
        interval: d > 0 ? d / tiles : 10,
        tile_w: 160,
        tile_h: 90,
        path: `/mock-scrub-${encodeURIComponent(String(args?.path || "")).slice(-40)}.webp`,
      };
    }
    case "video_info":
      return { duration: 5, width: 1280, height: 720 };
    case "probe_subtitles": {
      // 1.0.2-r7：同目录字幕探测。mock 下仅「电影/千与千寻.mp4」有同名 srt。
      const video = String(args?.video ?? "");
      const name = video.split("/").pop() || "";
      if (name === "千与千寻.mp4") {
        const dir = video.slice(0, video.lastIndexOf("/"));
        return [{ path: `${dir}/千与千寻.srt`, name: "千与千寻.srt" }];
      }
      return [];
    }
    case "read_subtitle": {
      // 1.0.2-r7：返回 UTF-8 字幕文本（真实后端负责 BOM/UTF-16/GBK 识别；mock 直接给样例）。
      // 时间戳刻意压在 0–5s 内 —— mock 视频固定 5 秒长，回归脚本才能在播放中命中 cue。
      const p = String(args?.path ?? "");
      if (p.endsWith("千与千寻.srt")) {
        return [
          "1",
          "00:00:00,300 --> 00:00:01,700",
          "千与千寻（Spirited Away）",
          "",
          "2",
          "00:00:01,800 --> 00:00:03,200",
          "欢迎来到 VTManager 字幕测试",
          "",
          "3",
          "00:00:03,300 --> 00:00:04,900",
          "下一站：天空之城",
          "",
        ].join("\n");
      }
      throw new Error(`mock: 字幕文件不存在 ${p}`);
    }
    case "capture_snapshot": {
      // 1.0.2-r7：截图命令（真实后端 AVFoundation 原分辨率 PNG，失败回退 ffmpeg）。
      // mock 返回模拟路径（destDir 缺省为资料库/captures）。
      const dir = String(args?.destDir || args?.dest_dir || `${ROOT}/.VTManager/captures`);
      const video = String(args?.video ?? "");
      const stem = (video.split("/").pop() || "video").replace(/\.[^.]+$/, "");
      return `${dir}/${stem}-${Date.now()}.png`;
    }
    case "pick_subtitle_file":
      // mock 无系统对话框：返回电影目录的示例字幕，便于联调「手动选择」链路
      return `${ROOT}/电影/千与千寻.srt`;
    case "pick_folder":
      // mock 无系统对话框：返回固定目录，便于联调「选择截图保存目录」链路
      return `${ROOT}/截图`;
    case "open_directory":
      // 1.0.2-r10：mock 环境不真正打开 Finder，静默成功即可（设置「进入缓存目录」按钮）
      return;
    case "open_pip_window": {
      // 前端是 invoke("open_pip_window", { args })，Rust 端整体反序列化成 PipOpenArgs，
      // mock 里同样是 { args: {...} } 这一层包裹，这里解出来。
      const a = (args?.args ?? args) || {};
      const label = `pip-${a.kind}-${Date.now()}`;
      // 记住主窗口传进来的队列，get_pip_payload 原样返回（贴近真实 Rust 行为）
      const payloads = pipStore("__vt_pip_payload");
      payloads[label] = {
        kind: a.kind ?? "video",
        list: a.list ?? [],
        index: a.index ?? 0,
        root: a.root ?? ROOT,
        covers_dir: a.covers_dir ?? `${ROOT}/.VTManager/covers`,
        // 透传主窗口的画面变换快照（图片专用）：PiP 窗口据此初始化，同步共用旋转状态
        init_rot: a.init_rot ?? 0,
        init_scale: a.init_scale ?? 1,
        init_tx: a.init_tx ?? 0,
        init_ty: a.init_ty ?? 0,
        // 1.0.2-r7：透传主窗口的字幕快照（视频专用），PiP 窗口据此渲染同一字幕
        subtitle: a.subtitle ?? undefined,
      };
      pipSave("__vt_pip_payload", payloads);
      const closed = pipStore("__vt_pip_closed");
      closed[label] = false;
      pipSave("__vt_pip_closed", closed);
      // 供联调脚本读取当前打开的独立窗口 label
      try {
        localStorage.setItem("__vt_pip_label", label);
      } catch {
        /* ignore */
      }
      return label;
    }
    case "get_pip_payload": {
      const p = pipStore("__vt_pip_payload")[args?.label];
      if (!p) throw new Error(`mock: 独立窗口数据不存在 ${args?.label}`);
      return p;
    }
    case "set_pip_state": {
      const st = pipStore("__vt_pip_state");
      st[args?.label] = { ...(args?.state ?? {}) };
      pipSave("__vt_pip_state", st);
      return;
    }
    case "take_pip_state": {
      const st = pipStore("__vt_pip_state");
      const s = st[args?.label];
      delete st[args?.label];
      pipSave("__vt_pip_state", st);
      return s ?? null;
    }
    case "close_pip_window": {
      // 与真实 Rust 一致：先 emit "pip-closed"，再清掉 payload
      const payloads = pipStore("__vt_pip_payload");
      delete payloads[args?.label];
      pipSave("__vt_pip_payload", payloads);
      const closed = pipStore("__vt_pip_closed");
      closed[args?.label] = true;
      pipSave("__vt_pip_closed", closed);
      emitMock("pip-closed", args?.label);
      // 真实实现里 Rust 会 close() 掉独立窗口；浏览器联调由测试脚本关页面
      return;
    }
    default:
      throw new Error(`mock 未实现命令: ${cmd}`);
  }
}

// 浏览器联调：本地文件无法直接用 <img src> 加载，统一换成带文件名的占位图，
// 这样缩略图/封面/图片查看器的渲染链路（含 naturalWidth → computeFit）都能真实跑通。
export function convertFileSrc(p: string): string {
  const name = String(p || "").split(/[\\/]/).pop() || "?";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#24405a"/><stop offset="1" stop-color="#3e7ba6"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="50%" fill="#e8f2fb" font-family="sans-serif" font-size="42" ` +
    `text-anchor="middle" dominant-baseline="middle">${name.replace(/[<>&]/g, "")}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
