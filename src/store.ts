import { reactive, ref } from "vue";
import {
  api,
  assetUrl,
  type DirListing,
  type Entry,
  type PipState,
  type FavCategory,
  type FavoriteItem,
  type InstalledApp,
  type SearchResult,
  type SubtitleTrack,
  type TrashItem,
} from "./api";
import { parseSubtitle, type SubtitleCue } from "./subtitles";

export type ViewType = "browse" | "search" | "recent" | "trash" | "tag";

/** 标签颜色中文名 */
export const TAG_LABELS: Record<string, string> = {
  red: "红",
  orange: "橙",
  yellow: "黄",
  green: "绿",
  blue: "蓝",
  purple: "紫",
};

interface Modals {
  player: { list: Entry[]; index: number } | null;
  viewer: { list: Entry[]; index: number } | null;
  cover: Entry | null;
  rename: { paths: string[] } | null;
  settings: boolean;
  tmdb: string | false; // false=关闭；字符串=待刮削的目标目录
}

export interface CtxItem {
  label: string;
  danger?: boolean;
  action: () => void;
}

export interface ConfirmState {
  title: string;
  message: string;
  danger?: boolean;
  /** 确认按钮文案（默认：danger 时「确认删除」，否则「确认」） */
  okText?: string;
  onOk: () => void;
}

export interface DirPickerState {
  title: string;
  confirmText?: string;
  exclude?: string[];
  onOk: (path: string) => void;
}

// 开发模式调试钩子（生产构建里 import.meta.env.DEV 为 false，不会挂到 window）：
// 浏览器控制台 / 联调脚本可直接查看与驱动全局状态。
if (import.meta.env.DEV) (window as any).__vtStore = null as any;

export const store = reactive({
  root: "",
  rootName: "",
  coversDir: "",
  version: "",
  ready: false,
  initError: "",
  view: "browse" as ViewType,
  path: "",
  query: "",
  listing: null as DirListing | null,
  loading: false,
  selection: [] as string[],
  highlight: "",
  sortState: {
    active: "name",
    dirs: { name: true, created: true, modified: true },
  } as { active: string; dirs: Record<string, boolean> },
  viewMode: "grid" as "grid" | "timeline" | "columns",
  userViewOverride: false,
  tagFilter: "" as string,
  thumbs: {} as Record<string, string>,
  // 1.0.1-r13：缩略图缓存 LRU 顺序（与 thumbs 配套，超上限淘汰最久未使用的条目，控制内存）
  thumbsOrder: [] as string[],
  favorites: [] as FavoriteItem[],
  favCats: [] as FavCategory[], // 收藏夹分类（cat_id=0 为根目录，不在其中）
  favThumbs: {} as Record<string, string>,
  favThumbsOrder: [] as string[],
  apps: [] as InstalledApp[],
  settings: {} as Record<string, string>,
  searchResults: [] as SearchResult[],
  recent: [] as SearchResult[],
  tagResults: [] as SearchResult[], // 颜色标签全局浏览结果（最高层被标记对象）
  trash: [] as TrashItem[],
  scanRunning: false,
  scanCount: 0,
  modals: {
    player: null as { list: Entry[]; index: number } | null, // 播放队列（同目录全部视频，支持上一/下一）
    viewer: null as { list: Entry[]; index: number } | null,
    cover: null as Entry | null,
    rename: null as { paths: string[] } | null,
    settings: false,
    tmdb: false as string | false, // false=关闭；字符串=待刮削的目标目录
  } as Modals,
  ctx: null as null | { x: number; y: number; items: CtxItem[] },
  confirm: null as ConfirmState | null,
  dirPicker: null as DirPickerState | null,
  newFolder: false,
  sidebarCollapsed: localStorage.getItem("vt_sidebar") === "1",
  appFullscreen: false, // 应用窗口是否处于原生全屏（跟随系统，播放器/查看器头部悬浮据此兼容）
  pipLabel: null as string | null, // 当前打开的独立全屏窗口 label（用于退出全屏时关闭该窗口）
  pipKind: null as "video" | "image" | null, // 当前打开的独立窗口类型（用于同步主窗口关闭 modal）
  // 独立全屏窗口打开中：主窗口的播放器/查看器**保持挂载**但隐藏 + 暂停，
  // 退出全屏时立即显示并从精确节点继续播放/查看（零重新加载、零重新缓冲）
  pipActive: false,
  // 独立窗口关闭时取回的最终状态（index/进度/旋转/缩放），供播放器/查看器续播/续看
  pipResult: null as PipState | null,
  // 图片查看器进入全屏前的画面变换快照（rot/scale/tx/ty）：
  // ImageViewer 触发全屏前写入，openPipFromCurrentModal 读取并随 payload 传给 PiP 窗口，
  // 保证全屏窗口一打开即共用主窗口当前的旋转/缩放/平移状态
  pipSeed: null as { rot: number; scale: number; tx: number; ty: number } | null,
  timelineNewestFirst: localStorage.getItem("vt_tl_newest") !== "0", // 时间轴排序：true=最新在上（正序）
  tagModal: null as null | { paths: string[] },
  infoModal: null as null | { path: string; kind: string; name: string },
  favCatModal: null as null | { mode: "create" } | { mode: "rename"; id: number; name: string },
  organizeModal: false,
  toasts: [] as { id: number; msg: string; type: string }[],
  dropActive: false,
  dragging: null as null | { paths: string[]; x: number; y: number },
  // 1.0.2-r7 播放器字幕状态：主窗口播放器维护，PiP 打开时快照随 payload 传递。
  // 放在 store 里是因为控制栏（VideoControls）是主窗口/PiP 共用的子组件，
  // 且 openPipFromCurrentModal 需要在此读取当前字幕状态组装快照。
  subtitle: {
    tracks: [] as SubtitleTrack[], // 当前视频同目录探测到的轨道
    active: null as string | null, // 当前加载的轨道路径（null = 无字幕）
    cues: [] as SubtitleCue[], // 当前轨道解析结果
    enabled: true, // 字幕显示开关
    size: 1, // 字号系数（0.8 / 1 / 1.2 / 1.5）
    busy: false, // 正在读取/解析字幕
    loadSeq: 0, // 加载序号：切换轨道时使过期回调失效
  },
});

if (import.meta.env.DEV) (window as any).__vtStore = store;
// 1.0.2-r8：联调钩子——回归脚本经此模拟「切换资料库」（openLibrary 为模块导出，
// 不在 store 响应式对象上，单独挂出）；生产构建不含。
if (import.meta.env.DEV) {
  (window as any).__vtActions = {
    openLibrary: (root: string) => openLibrary(root),
  };
}

let toastSeq = 1;

export function toast(msg: string, type: "info" | "ok" | "err" = "info") {
  const id = toastSeq++;
  store.toasts.push({ id, msg, type });
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id);
    if (i >= 0) store.toasts.splice(i, 1);
  }, 2600);
}

export function closeTopModal() {
  if (store.ctx) store.ctx = null;
  else if (store.tagModal) store.tagModal = null;
  else if (store.infoModal) store.infoModal = null;
  else if (store.favCatModal) store.favCatModal = null;
  else if (store.organizeModal) store.organizeModal = false;
  else if (store.confirm) store.confirm = null;
  else if (store.dirPicker) store.dirPicker = null;
  else if (store.newFolder) store.newFolder = false;
  else {
    const m = store.modals;
    // 独立全屏窗口打开时：Esc / 关闭操作先收掉全屏窗口，主窗口的播放器/查看器
    // 保持挂载（只是隐藏），由 finishPip() 负责恢复显示与续播/续看。
    if (store.pipLabel) {
      closePipWindow();
      return;
    }
    if (m.player) m.player = null;
    else if (m.viewer) m.viewer = null;
    else if (m.cover) m.cover = null;
    else if (m.rename) m.rename = null;
    else if (m.tmdb) m.tmdb = false;
    else if (m.settings) m.settings = false;
  }
}

export function hasModal(): boolean {
  const m = store.modals;
  return !!(
    m.player ||
    m.viewer ||
    m.cover ||
    m.rename ||
    m.settings ||
    m.tmdb ||
    store.confirm ||
    store.dirPicker ||
    store.newFolder ||
    store.tagModal ||
    store.infoModal ||
    store.favCatModal ||
    store.organizeModal ||
    store.ctx
  );
}

// ---------- 初始化 ----------

export async function init() {
  try {
    const info = await api.appInfo();
    store.version = info.version;
    store.apps = await api.listApps();
    const cand = await api.detectLibrary();
    if (cand.last) {
      await openLibrary(cand.last);
    } else if (cand.candidate) {
      store.ready = false;
      (store as any)._candidate = cand.candidate;
    }
  } catch (e: any) {
    console.error("init failed:", e);
    store.initError = String(e);
    toast(String(e), "err");
  }
}

export function candidate(): string | null {
  return (store as any)._candidate || null;
}

export async function openLibrary(root: string) {
  await api.openLibrary(root);
  store.root = root;
  store.rootName = root.split(/[\\/]/).filter(Boolean).pop() || root;
  store.ready = true;
  try {
    const paths = await api.getPaths();
    store.coversDir = paths.covers_dir;
    store.settings = await loadSettings();
    // 主题来自全局偏好，不随资料库切换而变；同时覆盖库级 settings 里的历史值
    await initTheme();
    applySortV2();
    await reloadFavorites();
  } catch (e: any) {
    console.error("post-open init failed:", e);
    store.initError = String(e);
  }
  await navigate(root);
  applyTheme();
  refreshScanStatus();
  autoScanIfNever();
  watchPrewarm(); // 1.0.2：监听缩略图预生成完成事件
}

/** 从未建立过索引时自动后台扫描 */
export async function autoScanIfNever() {
  try {
    const s = await api.scanStatus();
    if (!s.running && s.count === 0 && !s.last_scan) {
      await startScan();
      toast("正在后台建立资源索引，搜索功能稍后可用", "info");
    }
  } catch {
    /* ignore */
  }
}

async function loadSettings(): Promise<Record<string, string>> {
  try {
    return await api.getSettings();
  } catch {
    return {};
  }
}

export async function saveSetting(key: string, value: string) {
  store.settings[key] = value;
  try {
    await api.setSetting(key, value);
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export function clickAction(): "internal" | "external" {
  return store.settings.click_action === "external" ? "external" : "internal";
}

// 1.0.2-r3「关闭即删」：关闭播放器/切换视频时清理该视频的转封装缓存副本
// （cache/remux 下与原视频等大的 faststart 副本，可再生）。
// 开关（cleanup_remux_on_close，缺省开）由**后端**读 settings 表统一判断，
// 因为 PiP 独立窗口的 settings 未加载，前端判断会不一致。
// 静默后台执行，不阻塞关闭；失败（如流服务未启动）静默忽略。
export function cleanupRemuxCache(path: string | undefined) {
  if (!path) return;
  api.cleanupRemux(path).catch(() => {});
}

// ---------- 浏览 ----------

let navSeq = 0;

export async function navigate(path: string, keepSelection = false) {
  if (!path) return;
  const seq = ++navSeq;
  // 离开标签浏览：进入任何目录都退出颜色标签视图
  store.tagFilter = "";
  store.loading = true;
  try {
    const listing = await api.listDir(path);
    if (seq !== navSeq) return; // 已被更新的导航取代，丢弃过期结果
    store.listing = listing;
    store.path = listing.path;
    store.view = "browse";
    if (!keepSelection) store.selection = [];
    // 每级目录默认使用分栏展示（用户手动切换过视图后尊重其选择）
    if (!store.userViewOverride) {
      store.viewMode = "columns";
    }
    await loadThumbs(listing.entries);
    schedulePrewarm(listing.path); // 1.0.2：空闲时后台预生成缺失缩略图
  } catch (e: any) {
    toast(String(e), "err");
  } finally {
    if (seq === navSeq) store.loading = false;
  }
}

export async function refresh() {
  if (store.view === "browse" && store.path) {
    await navigate(store.path, true);
  } else if (store.view === "search" && store.query) {
    await doSearch(store.query);
  } else if (store.view === "recent") {
    await loadRecent();
  } else if (store.view === "tag" && store.tagFilter) {
    try {
      const results = await api.tagRoots(store.tagFilter);
      if (store.tagFilter) {
        store.tagResults = results;
        loadThumbs(
          results.map((r) => ({ path: r.path, is_dir: r.is_dir, kind: r.kind }))
        );
      }
    } catch {
      /* ignore */
    }
  } else if (store.view === "trash") {
    await loadTrash();
  }
  // 删除/移动/重命名/恢复后，收藏夹与磁盘实况保持同步
  await reloadFavorites();
}

/** 重新拉取收藏列表与分类（后端会过滤掉已不存在的路径） */
export async function reloadFavorites() {
  try {
    store.favorites = await api.listFavorites();
  } catch {
    /* ignore */
  }
  try {
    store.favCats = await api.listFavCategories();
  } catch {
    /* ignore */
  }
  loadFavThumbs();
}

export function goUp() {
  if (store.listing?.parent) navigate(store.listing.parent);
}

/** 缩略图内存缓存上限（1.0.1-r13：防长期使用内存无限增长，超出淘汰最久未使用） */
const THUMB_CACHE_MAX = 3000;
const FAV_THUMB_CACHE_MAX = 1000;

function cacheThumb(
  map: Record<string, string>,
  order: string[],
  path: string,
  url: string,
  max: number
) {
  if (map[path]) {
    const i = order.indexOf(path);
    if (i >= 0) order.splice(i, 1);
    order.push(path); // 已存在：移到末尾（最近使用）
    return;
  }
  map[path] = url;
  order.push(path);
  if (order.length > max) {
    const evicted = order.splice(0, order.length - max);
    for (const p of evicted) delete map[p];
  }
}

export async function loadThumbs(entries: { path: string; is_dir: boolean; kind: string }[]) {
  const need = entries.filter(
    (e) => !store.thumbs[e.path] && (e.kind === "image" || e.kind === "video")
  );
  for (let i = 0; i < need.length; i += 8) {
    const chunk = need.slice(i, i + 8);
    try {
      const res = await api.getThumbs(
        chunk.map((e) => ({ path: e.path, is_dir: e.is_dir, is_video: e.kind === "video" }))
      );
      for (const r of res) {
        if (r.thumb) cacheThumb(store.thumbs, store.thumbsOrder, r.path, assetUrl(r.thumb), THUMB_CACHE_MAX);
      }
    } catch {
      /* 缩略图失败忽略 */
    }
  }
}

// ---------- 空闲预生成缩略图（1.0.2） ----------
// 浏览目录时首屏缩略图已加载完成，利用浏览器空闲时间通知后端在后台
// 低优先级预生成缺失缩略图；完成后后端发 thumbs-prewarmed 事件，
// 前端再补拉一次（只取仍未缓存的），实现「第二次浏览即秒开」。

let prewarmScheduled = false;

/** 空闲时请求后端预生成当前目录缺失缩略图（节流：同一时刻只排一个） */
export function schedulePrewarm(dir: string) {
  if (prewarmScheduled) return;
  prewarmScheduled = true;
  const run = () => {
    prewarmScheduled = false;
    api.prewarmThumbs(dir).catch(() => {});
  };
  if (typeof (window as any).requestIdleCallback === "function") {
    (window as any).requestIdleCallback(() => run(), { timeout: 5000 });
  } else {
    window.setTimeout(run, 900);
  }
}

let prewarmUnlisten: (() => void) | null = null;

/** 监听后端缩略图预生成完成事件，补拉缺失缩略图（仅 Tauri 环境，mock 无事件系统） */
export async function watchPrewarm() {
  if (prewarmUnlisten || !(window as any).__TAURI_INTERNALS__) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    prewarmUnlisten = await listen<{ dir: string }>("thumbs-prewarmed", (e) => {
      if (e.payload?.dir === store.path && store.view === "browse" && store.listing) {
        loadThumbs(store.listing.entries);
      }
    });
  } catch {
    /* 事件系统不可用则忽略 */
  }
}

export function coverUrl(entry: Entry): string | null {
  if (entry.cover) return assetUrl(`${store.coversDir}/${entry.cover}`);
  return store.thumbs[entry.path] || null;
}

export function isFavorite(path: string): boolean {
  return store.favorites.some((f) => f.path === path);
}

// ---------- 图片查看器预览（1.0.1-r13） ----------
// 大图查看时用 ≤2048px 降采样预览替代原图（大幅降低内存），小图后端返回 null（直接用原图）。
// 结果按 path 缓存于模块级 Map（非响应式，查看器场景数量少，无需进 store）。
const previewCache = new Map<string, string | null>();

/** 获取图片的预览 URL：大图返回预览路径，小图/失败返回 null（调用方回退原图） */
export async function previewUrl(path: string): Promise<string | null> {
  const hit = previewCache.get(path);
  if (hit !== undefined) return hit;
  try {
    const p = await api.getPreview(path);
    const url = p ? assetUrl(p) : null;
    previewCache.set(path, url);
    return url;
  } catch {
    return null; // 失败不缓存，下次重试
  }
}

/** 为收藏项生成/获取缩略图（目录封面、视频封面、图片缩略图） */
export async function loadFavThumbs() {
  const need = store.favorites.filter(
    (f) => !store.favThumbs[f.path] && (f.is_dir || ["video", "image"].includes(f.kind))
  );
  for (let i = 0; i < need.length; i += 8) {
    const chunk = need.slice(i, i + 8);
    try {
      const res = await api.getThumbs(
        chunk.map((f) => ({ path: f.path, is_dir: f.is_dir, is_video: f.kind === "video" }))
      );
      for (const r of res) {
        if (r.thumb) cacheThumb(store.favThumbs, store.favThumbsOrder, r.path, assetUrl(r.thumb), FAV_THUMB_CACHE_MAX);
      }
    } catch {
      /* ignore */
    }
  }
}

export async function toggleFavorite(path: string) {
  try {
    if (isFavorite(path)) {
      await api.removeFavorite(path);
      store.favorites = store.favorites.filter((f) => f.path !== path);
      toast("已取消收藏");
    } else {
      await addFavoriteTo(path, 0);
    }
  } catch (e: any) {
    toast(String(e), "err");
  }
}

/** 收藏到指定分类（catId=0 为收藏夹根目录），成功后刷新侧边栏列表 */
export async function addFavoriteTo(path: string, catId: number) {
  try {
    await api.addFavorite(path, catId);
    await reloadFavorites();
    const cat = store.favCats.find((c) => c.id === catId);
    toast(cat ? `已收藏到「${cat.name}」` : "已收藏", "ok");
  } catch (e: any) {
    toast(String(e), "err");
  }
}

/** 批量收藏：跳过已收藏项，全部完成后统一刷新与提示（避免逐条刷新弹多次 toast） */
export async function addFavoriteBatch(paths: string[], catId: number) {
  let added = 0;
  try {
    for (const p of paths) {
      if (isFavorite(p)) continue; // 已收藏的跳过，不重复添加
      await api.addFavorite(p, catId);
      added++;
    }
    await reloadFavorites();
    if (added === 0) {
      toast("所选项目均已收藏", "info");
      return;
    }
    const cat = store.favCats.find((c) => c.id === catId);
    toast(`已收藏 ${added} 项${cat ? `到「${cat.name}」` : ""}`, "ok");
  } catch (e: any) {
    toast(String(e), "err");
  }
}

/**
 * 封面收藏星标入口：
 *  - 已收藏 → 取消收藏（同原逻辑）
 *  - 无分类 → 直接加入收藏夹根目录（同原逻辑）
 *  - 有分类 → 在按钮旁弹出分类选择（根目录默认置顶），点选即确认
 */
export function starToggle(
  entry: { path: string; name: string; is_dir: boolean; kind: string },
  x: number,
  y: number
) {
  if (isFavorite(entry.path)) {
    toggleFavorite(entry.path);
    return;
  }
  if (!store.favCats.length) {
    addFavoriteTo(entry.path, 0);
    return;
  }
  const items: CtxItem[] = [
    { label: "收藏夹（根目录）", action: () => addFavoriteTo(entry.path, 0) },
    ...store.favCats.map((c) => ({
      label: c.name,
      action: () => addFavoriteTo(entry.path, c.id),
    })),
  ];
  store.ctx = { x, y, items };
}

// ---------- 收藏夹分类 ----------

/** 新建/重命名分类弹窗的确认入口 */
export async function favCatSubmit(name: string) {
  const m = store.favCatModal;
  if (!m || !name.trim()) return;
  try {
    if (m.mode === "create") {
      await api.addFavCategory(name.trim());
      toast("分类已创建", "ok");
    } else {
      await api.renameFavCategory(m.id, name.trim());
      toast("分类已重命名", "ok");
    }
    store.favCatModal = null;
    await reloadFavorites();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

/** 删除分类：其下收藏回到收藏夹根目录（需确认） */
export function removeFavCategory(id: number, name: string) {
  confirmAction(
    "删除分类",
    `确定删除分类「${name}」吗？该分类下的收藏将回到收藏夹根目录。`,
    async () => {
      try {
        await api.deleteFavCategory(id);
        toast("分类已删除", "ok");
        await reloadFavorites();
      } catch (e: any) {
        toast(String(e), "err");
      }
    },
    true
  );
}

// ---------- 定位展示（收藏夹 / 最近添加跳转） ----------

let locateSeq = 0;
let locatePoll: number | null = null;
let locateRecheck: number | null = null;
let locateClear: number | null = null;

function stopLocatePoll() {
  if (locatePoll) {
    window.clearInterval(locatePoll);
    locatePoll = null;
  }
}

/** 在主内容区内查找当前高亮条目（收窄范围，避免误命中侧边栏/弹窗内的 data-path） */
function findHighlightEl(): HTMLElement | null {
  const p = store.highlight;
  if (!p) return null;
  const scope = document.querySelector(".content") || document;
  for (const c of scope.querySelectorAll<HTMLElement>("[data-path]")) {
    if (c.dataset.path === p) return c;
  }
  return null;
}

/** 把元素滚动到可感知位置：完整可见且在中线以上 → 原位；否则滚到容器垂直中线 */
function revealEl(el: HTMLElement) {
  // 元素实际所在的滚动容器：网格/时间轴是 .content，分栏视图是 .col-body
  let sc: HTMLElement | null = null;
  let n: HTMLElement | null = el.parentElement;
  while (n) {
    const st = getComputedStyle(n);
    if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 2) {
      sc = n;
      break;
    }
    n = n.parentElement;
  }
  if (!sc) return;
  const box = sc.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const mid = box.top + box.height / 2;
  if (r.top >= box.top - 2 && r.bottom <= mid) return; // 中线以上完整可见：保持原位置
  // 元素中心滚到容器中线（直接赋值，跨 WebKit/Chromium 内核都可靠；越界由浏览器夹住）
  const delta = r.top + r.height / 2 - mid;
  const target = sc.scrollTop + delta;
  if (Math.abs(target - sc.scrollTop) < 2) return;
  sc.scrollTop = target;
}

function revealHighlight() {
  const el = findHighlightEl();
  if (el) revealEl(el);
}

/**
 * 定位展示一个文件：进入其所在目录 → 条目渲染后滚动到位 → 黄色边框闪烁提醒。
 * 不等待缩略图加载（大目录分块抽帧可能耗时数秒），条目一出现即定位；
 * 时间轴拍摄日期等异步渲染会改变位置，定位后再复核一次。
 */
export function locateEntry(parent: string, target: string) {
  const seq = ++locateSeq;
  stopLocatePoll();
  if (locateRecheck) window.clearTimeout(locateRecheck);
  if (locateClear) window.clearTimeout(locateClear);
  store.highlight = target;
  navigate(parent);
  const t0 = Date.now();
  locatePoll = window.setInterval(() => {
    if (seq !== locateSeq) {
      stopLocatePoll();
      return;
    }
    const el = findHighlightEl();
    if (el) {
      stopLocatePoll();
      revealEl(el);
      locateRecheck = window.setTimeout(() => {
        if (seq === locateSeq) revealHighlight();
      }, 700);
    } else if (Date.now() - t0 > 4000) {
      stopLocatePoll(); // 目录加载失败或条目已不存在，放弃定位
    }
  }, 100);
  // 黄闪动画总时长约 3.2s，清除死线随每次定位重置（重复定位同一目标不会截断动画）
  locateClear = window.setTimeout(() => {
    if (seq === locateSeq && store.highlight === target) store.highlight = "";
  }, 4200);
}

// ---------- 排序 ----------

export function sortedEntries(entries: Entry[]): Entry[] {
  const s = store.sortState;
  const dir = s.dirs[s.active] === false ? -1 : 1;
  const arr = [...entries];
  arr.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let r = 0;
    if (s.active === "name") r = a.name.localeCompare(b.name, "zh-CN");
    else if (s.active === "created") r = a.created_ms - b.created_ms;
    else r = a.modified_ms - b.modified_ms;
    return r * dir;
  });
  return arr;
}

/** 顶栏排序（网格/时间轴视图）：点击已选项切换方向，点击新项按其记忆方向激活 */
export function selectGlobalSort(k: string) {
  const s = store.sortState;
  if (s.active === k) s.dirs[k] = !s.dirs[k];
  else s.active = k;
  saveSetting("sort_v2", JSON.stringify({ active: s.active, dirs: s.dirs }));
}

/** 从设置恢复 v2 排序状态 */
function applySortV2() {
  const raw = store.settings.sort_v2;
  if (!raw) return;
  try {
    const v = JSON.parse(raw);
    if (v && v.active && v.dirs) {
      store.sortState.active = v.active;
      store.sortState.dirs = v.dirs;
    }
  } catch {
    /* ignore */
  }
}

// ---------- 打开 / 播放 ----------

export function imagesInListing(): Entry[] {
  return store.listing ? sortedEntries(store.listing.entries).filter((e) => e.kind === "image") : [];
}

export function videosInListing(): Entry[] {
  return store.listing ? sortedEntries(store.listing.entries).filter((e) => e.kind === "video") : [];
}

/** 应用内播放：队列 = 所在列表的全部视频（搜索/最近=结果列表；网格/分栏=当前目录），支持上一/下一 */
export function playInApp(entry: Entry) {
  let list: Entry[];
  if (store.view === "search" || store.view === "recent") {
    // 搜索/最近视图优先用结果列表，避免同页不同条目队列不一致
    const src = store.view === "search" ? store.searchResults : store.recent;
    list = src.filter((x) => !x.is_dir && x.kind === "video").map(resultToEntry);
  } else if (store.listing?.entries.some((e) => e.path === entry.path)) {
    list = videosInListing();
  } else {
    list = [entry];
  }
  const index = list.findIndex((e) => e.path === entry.path);
  store.modals.player = { list: index >= 0 ? list : [entry], index: Math.max(0, index) };
}

export function openEntry(entry: Entry) {
  if (entry.is_dir) {
    navigate(entry.path);
    return;
  }
  if (entry.kind === "video") {
    if (clickAction() === "external") openExternal(entry.path);
    else playInApp(entry);
    return;
  }
  if (entry.kind === "image") {
    if (clickAction() === "external") openExternal(entry.path);
    else {
      const list = imagesInListing();
      const index = list.findIndex((e) => e.path === entry.path);
      if (index >= 0) {
        store.modals.viewer = { list, index };
      } else {
        // 来自搜索/最近添加等非当前目录的图片：退化为单图查看，避免套用旧目录图集
        store.modals.viewer = { list: [entry], index: 0 };
      }
    }
    return;
  }
  openExternal(entry.path);
}

export async function openExternal(path: string) {
  try {
    await api.openWith(path, null);
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export async function openExternalWith(path: string, kind: "video" | "image") {
  const key = kind === "video" ? "video_app" : "image_app";
  const app = store.settings[key] || null;
  try {
    await api.openWith(path, app);
  } catch (e: any) {
    toast(String(e), "err");
  }
}

/** 把搜索/最近结果转换为 Entry（供应用内播放器/查看器使用） */
export function resultToEntry(r: SearchResult): Entry {
  const dot = r.name.lastIndexOf(".");
  return {
    name: r.name,
    path: r.path,
    is_dir: r.is_dir,
    kind: r.kind,
    ext: dot >= 0 ? r.name.slice(dot + 1).toLowerCase() : "",
    size: r.size,
    created_ms: r.created_ms,
    modified_ms: 0,
    cover: null,
    tag: null,
    dir_size: null,
  };
}

/**
 * 最近添加/搜索结果的「打开」按钮：与单击条目行为一致，
 * 跟随设置——应用内预览(external 时用设置的默认应用)。
 */
export function openResultDefault(r: SearchResult) {
  if (r.kind === "video") {
    if (clickAction() === "internal") playInApp(resultToEntry(r));
    else openExternalWith(r.path, "video");
    return;
  }
  if (r.kind === "image") {
    if (clickAction() === "internal") {
      const src = store.view === "search" ? store.searchResults : store.recent;
      const list = src.filter((x) => !x.is_dir && x.kind === "image").map(resultToEntry);
      const idx = list.findIndex((e) => e.path === r.path);
      store.modals.viewer = { list, index: Math.max(0, idx) };
    } else {
      openExternalWith(r.path, "image");
    }
    return;
  }
  openExternal(r.path);
}

/** 取父目录（同时兼容 / 与 \ 分隔符） */
export function parentDirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

// ---------- 选择 ----------

export function isSelected(path: string): boolean {
  return store.selection.includes(path);
}

export function selectOnly(path: string) {
  store.selection = [path];
}

export function toggleSelect(path: string) {
  const i = store.selection.indexOf(path);
  if (i >= 0) store.selection.splice(i, 1);
  else store.selection.push(path);
}

export function selectAll() {
  if (store.listing) store.selection = store.listing.entries.map((e) => e.path);
}

export function clearSelection() {
  store.selection = [];
}

export function setCoverDialog(entry: Entry) {
  store.modals.cover = entry;
}

/** 打开标记颜色弹窗（单选或批量） */
export function setTagDialog(paths: string[]) {
  store.tagModal = { paths };
}

/** 打开媒体详情面板 */
export function openMediaInfo(entry: { path: string; kind: string; name: string }) {
  store.infoModal = { path: entry.path, kind: entry.kind, name: entry.name };
}

/** 设置视图模式（用户手动选择后不再自动切换） */
export function setViewMode(mode: "grid" | "timeline" | "columns") {
  store.userViewOverride = true;
  store.viewMode = mode;
}

// ---------- 播放器字幕 / 截图（1.0.2-r7） ----------
//
// 字幕数据流：后端 probe_subtitles 探测同目录轨道 → read_subtitle 读文本（自动
// 识别 UTF-8/UTF-16/GBK）→ 前端 parseSubtitle 解析成 cue 数组 → 播放器 overlay
// 用 cueAt 按当前时间渲染。PiP 打开时把 cues/size/enabled 快照随 payload 传给
// 独立窗口（快照语义：全屏期间主窗口的字幕调整不回写）。

/** 探测视频同目录字幕并自动加载同名轨道；换视频时重置旧字幕状态 */
export async function probeSubtitlesFor(video: string) {
  const sub = store.subtitle;
  if (!video) return;
  let tracks: SubtitleTrack[] = [];
  try {
    tracks = await api.probeSubtitles(video);
  } catch {
    tracks = []; // 后端不可用时静默降级为无字幕
  }
  // 旧字幕不属于新视频的轨道列表 → 立即清空（防止新视频起播瞬间闪现旧字幕）
  if (sub.active && !tracks.some((t) => t.path === sub.active)) {
    sub.active = null;
    sub.cues = [];
  }
  sub.tracks = tracks;
  if (!sub.active && tracks.length) {
    // 自动加载第一个（后端已把完全同名排最前，如 Movie.srt 优先于 Movie.zh.srt）
    await loadSubtitle(tracks[0]);
  }
}

/** 加载指定字幕轨道；null = 关闭字幕 */
export async function loadSubtitle(track: SubtitleTrack | null) {
  const sub = store.subtitle;
  const seq = ++sub.loadSeq;
  if (!track) {
    sub.active = null;
    sub.cues = [];
    sub.busy = false;
    return;
  }
  sub.busy = true;
  sub.active = track.path;
  try {
    const text = await api.readSubtitle(track.path);
    if (seq !== sub.loadSeq) return; // 期间已切换轨道，丢弃过期结果
    const kind = track.name.toLowerCase().endsWith(".vtt") ? "vtt" : "srt";
    sub.cues = parseSubtitle(text, kind);
    if (!sub.cues.length) {
      // 解析结果为空：视为无效轨道，不保持"已加载"状态
      sub.active = null;
      toast("字幕文件内容为空或无法解析", "err");
    }
  } catch (e: any) {
    if (seq !== sub.loadSeq) return;
    sub.active = null;
    sub.cues = [];
    toast(`字幕加载失败：${String(e)}`, "err");
  } finally {
    if (seq === sub.loadSeq) sub.busy = false;
  }
}

/** 手动选择字幕文件（系统对话框，过滤 .srt/.vtt） */
export async function pickSubtitleFile() {
  try {
    const p = await api.pickSubtitleFile();
    if (!p) return;
    const name = p.split(/[\\/]/).pop() || p;
    await loadSubtitle({ path: p, name });
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export function setSubtitleEnabled(v: boolean) {
  store.subtitle.enabled = v;
}

export function setSubtitleSize(s: number) {
  store.subtitle.size = s;
}

/** 播放器截图：当前帧保存为 PNG（默认资料库/captures，可自定义目录，localStorage 记忆） */
export async function snapshotCurrentFrame(video: string, time: number) {
  const dir = localStorage.getItem("vt_capture_dir") || null;
  try {
    const saved = await api.captureSnapshot(video, time, dir);
    toast(`已保存截图：${saved}`, "ok");
  } catch (e: any) {
    toast(`截图失败：${String(e)}`, "err");
  }
}

/** 自定义截图保存目录（系统对话框；记忆于 localStorage，跨会话保留） */
export async function pickCaptureDir() {
  try {
    const d = await api.pickFolder();
    if (!d) return;
    localStorage.setItem("vt_capture_dir", d);
    toast(`截图将保存到：${d}`, "ok");
  } catch (e: any) {
    toast(String(e), "err");
  }
}

// ---------- 播放器 / 查看器全屏（独立 PiP 窗口，不动应用窗口全屏） ----------

let fsUnlisten: (() => void) | null = null;
let pipUnlisten: (() => void) | null = null;

/**
 * 进入/退出全屏（只针对播放器/查看器本身，不改变应用窗口全屏）。
 *
 * 进入：
 *   1. 从当前主窗口 modal（player / viewer）取出媒体队列与当前索引
 *   2. 调 Rust 创建独立 OS 窗口（先 show() 上屏，再切全屏 —— macOS 上必须按此顺序）
 *   3. 主窗口的播放器/查看器**保持挂载**，仅隐藏 + 暂停（不是销毁！），
 *      因此退出全屏时能从精确节点瞬间续播/续看，无需重跑「探测 → 建流 → 转封装」。
 *
 * 退出：
 *   独立窗口通过 set_pip_state 持续回写 index / 播放进度 / 旋转 / 缩放，
 *   关闭时主窗口 take_pip_state 一次性取回 → 播放器/查看器据此恢复并继续。
 */
export async function toggleMediaFullscreen() {
  // 已经处于 PiP：用户主动点按钮应该是「退出 PiP」语义；
  // PiP 窗口内的按钮 / F 键 / 双击 直接调 closePipWindow() 不走这里。
  if (store.pipLabel) {
    await closePipWindow();
    return;
  }
  await openPipFromCurrentModal();
}

/** 从当前主窗口 modal 取出数据 → 创建独立 PiP 窗口 → 主窗口画面隐藏 + 暂停 */
async function openPipFromCurrentModal() {
  const m = store.modals;
  let kind: "video" | "image" | null = null;
  let list: { path: string; name: string; kind: string; cover: string | null }[] = [];
  let index = 0;
  if (m.player) {
    kind = "video";
    list = m.player.list.map((e) => ({
      path: e.path,
      name: e.name,
      kind: e.kind,
      cover: e.cover,
    }));
    index = m.player.index;
  } else if (m.viewer) {
    kind = "image";
    list = m.viewer.list.map((e) => ({
      path: e.path,
      name: e.name,
      kind: e.kind,
      cover: e.cover,
    }));
    index = m.viewer.index;
  }
  if (!kind || !list.length) return;
  // 图片：把主窗口当前的旋转/缩放/平移随初始 payload 传给 PiP 窗口
  //（视频无画面变换，恒为默认 0/1/0/0；读后即清，避免残留污染下一次打开）
  const seed = kind === "image" ? store.pipSeed : null;
  store.pipSeed = null;
  // 视频：把主窗口当前的字幕快照（cues/size/enabled）随 payload 传给 PiP 窗口，
  // 全屏窗口一打开即渲染同一字幕。仅在有已加载字幕时携带，cues 为空则 PiP 无字幕。
  const sub = store.subtitle;
  const subtitle =
    kind === "video" && sub.cues.length
      ? { cues: sub.cues, size: sub.size, enabled: sub.enabled }
      : undefined;
  // 清掉上一次全屏会话的回传结果：否则本次若取回失败（st 为 null），
  // 组件会把上一次的 index/进度当成"本次全屏的结果"来恢复（1.0.2-r4）
  store.pipResult = null;
  try {
    const label = await api.openPipWindow({
      kind,
      list,
      index,
      root: store.root,
      covers_dir: store.coversDir,
      init_rot: seed?.rot ?? 0,
      init_scale: seed?.scale ?? 1,
      init_tx: seed?.tx ?? 0,
      init_ty: seed?.ty ?? 0,
      subtitle,
    });
    store.pipLabel = label;
    store.pipKind = kind;
    // 主窗口 modal 保持挂载，只隐藏 + 暂停（播放器/查看器各自 watch 此标记）
    store.pipActive = true;
  } catch (e: any) {
    // PiP 窗口创建失败：主窗口画面保持原样即可
    store.pipLabel = null;
    store.pipKind = null;
    store.pipActive = false;
    toast(String(e?.message || e), "err");
  }
}

/** 关闭当前 PiP 窗口，并取回其最终状态供主窗口续播/续看 */
export async function closePipWindow() {
  const label = store.pipLabel;
  if (!label) return;
  try {
    await api.closePipWindow(label);
  } catch {
    /* ignore */
  }
  await finishPip(label);
}

/**
 * 抢占式判定：独立窗口关闭时，"pip-closed" 事件与主动调用 closePipWindow()
 * 都可能触发收尾，用 label 比对确保只收尾一次（且 pipResult 只被取走一次）。
 */
function claimPipClose(label: string): boolean {
  if (store.pipLabel !== label) return false;
  store.pipLabel = null;
  return true;
}

/** 取回独立窗口最终状态 → 交还主窗口播放器/查看器继续播放/查看 */
async function finishPip(label: string) {
  if (!claimPipClose(label)) return;
  let st: PipState | null = null;
  try {
    st = await api.takePipState(label);
  } catch {
    /* 窗口已销毁 / 状态丢失：退回主窗口自身记忆的节点 */
  }
  // 先写入结果，再放开 pipActive —— 组件的 watch 里读到的一定是新值
  store.pipResult = st;
  store.pipKind = null;
  store.pipActive = false;
}

/** 应用启动时挂一次：跟随系统/用户手势引起的全屏变化（如 Esc 退出全屏） */
export async function watchFullscreen() {
  if (fsUnlisten) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    store.appFullscreen = await w.isFullscreen();
    fsUnlisten = await w.onResized(async () => {
      try {
        store.appFullscreen = await getCurrentWindow().isFullscreen();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* 浏览器联调环境 / 不支持时静默降级 */
  }
  // PiP 独立窗口关闭事件监听：用户主动关闭（点 X）或 Rust 端 close 调用
  // 都会触发此事件，主窗口借此同步 pipLabel / pipKind 状态 + 恢复主窗口 modal。
  if (!pipUnlisten) {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<string>("pip-closed", (e) => {
        if (store.pipLabel && e.payload === store.pipLabel) {
          finishPip(e.payload);
        }
      });
      pipUnlisten = unlisten;
    } catch {
      /* 浏览器联调环境静默忽略 */
    }
  }
}

/** 时间轴排序：正序=最新在上（与网格相反的直觉按需求约定），点击切换 */
export function toggleTimelineSort() {
  store.timelineNewestFirst = !store.timelineNewestFirst;
  localStorage.setItem("vt_tl_newest", store.timelineNewestFirst ? "1" : "0");
}

/** 侧边栏收起/展开 */
export function toggleSidebar() {
  store.sidebarCollapsed = !store.sidebarCollapsed;
  localStorage.setItem("vt_sidebar", store.sidebarCollapsed ? "1" : "0");
}

let tagReqSeq = 0;

/** 侧边栏颜色标签：开启全库标签浏览；再次点击取消并回到之前浏览的文件夹 */
export async function toggleTagFilter(color: string) {
  if (store.tagFilter === color) {
    store.tagFilter = "";
    store.selection = [];
    if (store.view === "tag") store.view = "browse";
    return;
  }
  const seq = ++tagReqSeq;
  try {
    const results = await api.tagRoots(color);
    if (seq !== tagReqSeq) return; // 期间已选择其他颜色，丢弃过期结果
    store.tagResults = results;
    store.tagFilter = color;
    store.view = "tag";
  } catch (e: any) {
    if (seq !== tagReqSeq) return;
    toast(String(e), "err");
    if (store.view === "tag" && !store.tagFilter) store.view = "browse";
  }
}

/** 共享的过滤后条目（标签筛选） */
export function filterByTag(entries: Entry[]): Entry[] {
  if (!store.tagFilter) return entries;
  return entries.filter((e) => e.tag === store.tagFilter);
}

// ---------- 通用确认 / 目录选择 / 新建文件夹 ----------

export function confirmAction(title: string, message: string, onOk: () => void, danger = false) {
  store.confirm = { title, message, onOk, danger };
}

export function openDirPicker(title: string, onOk: (path: string) => void, opts: { confirmText?: string; exclude?: string[] } = {}) {
  store.dirPicker = { title, onOk, confirmText: opts.confirmText, exclude: opts.exclude };
}

export function openNewFolder() {
  store.newFolder = true;
}

// ---------- 主题 ----------
//
// 日夜模式是**全局状态**：存在应用数据目录的 prefs.json（Rust 侧 get_pref /
// set_pref），与资料库无关。此前存在库级 settings 表里，open_library 换库即换
// 数据库 → 主题被重置。现在切换资料库、进入/返回任意目录都不会改变主题，
// 只有「日夜切换按钮」和「设置 → 日夜选择」（都走 toggleTheme）能修改它。

export function applyTheme() {
  const t = store.settings.theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = t;
}

/**
 * 读取全局主题并应用。库级 settings 里遗留的 theme 值只作首次迁移来源：
 * 全局偏好尚未写入时，把它提升为全局值，之后一律以全局值为准。
 */
export async function initTheme() {
  const legacy = store.settings.theme; // 库级 settings（历史遗留）
  try {
    const g = await api.getPref("theme");
    if (g === "dark" || g === "light") store.settings.theme = g;
    else if (legacy === "dark" || legacy === "light") {
      store.settings.theme = legacy;
      api.setPref("theme", legacy).catch(() => {}); // 迁移到全局
    } else store.settings.theme = "light";
  } catch {
    store.settings.theme = legacy === "dark" ? "dark" : "light";
  }
  applyTheme();
}

export function toggleTheme() {
  const next = store.settings.theme === "dark" ? "light" : "dark";
  store.settings.theme = next; // 立即生效，不等后端往返
  const root = document.documentElement;
  root.classList.add("theme-anim");
  applyTheme();
  api.setPref("theme", next).catch(() => {}); // 全局持久化
  setTimeout(() => root.classList.remove("theme-anim"), 700);
}

// ---------- 删除 / 移动 / 复制 ----------

export async function trashPaths(paths: string[]) {
  if (!paths.length) return;
  try {
    await api.deleteEntries(paths);
    toast(paths.length > 1 ? `已将 ${paths.length} 项移入回收站` : "已移入回收站（可恢复）", "ok");
    store.selection = [];
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

/** 共享右键菜单构建：网格卡片与列表行（最近添加/搜索）通用 */
export function entryMenuFor(
  entry: { path: string; name: string; is_dir: boolean; kind: string },
  x: number,
  y: number
) {
  const multi = store.selection.includes(entry.path) && store.selection.length > 1;
  const items: CtxItem[] = [];
  if (multi) {
    const sel = [...store.selection];
    items.push(
      {
        label: `批量重命名（${sel.length} 项）`,
        action: () => (store.modals.rename = { paths: sel }),
      },
      { label: `移动到…（${sel.length} 项）`, action: () => batchMoveTo(sel) },
      { sep: true } as any,
      {
        label: `删除（${sel.length} 项）`,
        danger: true,
        action: () => batchDeleteTo(sel),
      }
    );
    store.ctx = { x, y, items };
    return;
  }
  if (entry.is_dir) {
    items.push(
      { label: "打开", action: () => navigate(entry.path) },
      {
        label: isFavorite(entry.path) ? "取消收藏" : "收藏此目录…",
        action: () => starToggle(entry, x, y),
      },
      { sep: true } as any,
      { label: "选择封面（上传图片）…", action: () => setCoverDialog(entry as Entry) },
      { label: "标记颜色…", action: () => setTagDialog([entry.path]) },
      { label: "详细信息…", action: () => openMediaInfo({ ...entry, kind: "dir" }) },
      { label: "移动到…", action: () => batchMoveTo([entry.path]) },
      { label: "重命名…", action: () => (store.modals.rename = { paths: [entry.path] }) },
      { sep: true } as any,
      { label: "在 Finder 中显示", action: () => api.reveal(entry.path) },
      { label: "删除", danger: true, action: () => batchDeleteTo([entry.path]) }
    );
  } else if (entry.kind === "video") {
    items.push(
      { label: "▶ 播放（应用内）", action: () => playInApp(entry as Entry) },
      { label: "用默认播放器打开", action: () => openExternalWith(entry.path, "video") },
      { sep: true } as any,
      { label: "刮削电影信息（TMDB）…", action: () => (store.modals.tmdb = parentDirOf(entry.path)) },
      { label: "选择封面（上传 / 截帧）…", action: () => setCoverDialog(entry as Entry) },
      { label: "标记颜色…", action: () => setTagDialog([entry.path]) },
      { label: "详细信息…", action: () => openMediaInfo(entry) },
      { label: "移动到…", action: () => batchMoveTo([entry.path]) },
      { label: "重命名 / 修改格式…", action: () => (store.modals.rename = { paths: [entry.path] }) },
      { sep: true } as any,
      { label: "在 Finder 中显示", action: () => api.reveal(entry.path) },
      { label: "删除", danger: true, action: () => batchDeleteTo([entry.path]) }
    );
  } else if (entry.kind === "image") {
    items.push(
      { label: "查看大图", action: () => openEntry(entry as Entry) },
      { label: "用默认看图软件打开", action: () => openExternalWith(entry.path, "image") },
      { sep: true } as any,
      { label: "标记颜色…", action: () => setTagDialog([entry.path]) },
      { label: "详细信息…", action: () => openMediaInfo(entry) },
      { label: "移动到…", action: () => batchMoveTo([entry.path]) },
      { label: "重命名 / 修改格式…", action: () => (store.modals.rename = { paths: [entry.path] }) },
      { sep: true } as any,
      { label: "在 Finder 中显示", action: () => api.reveal(entry.path) },
      { label: "删除", danger: true, action: () => batchDeleteTo([entry.path]) }
    );
  } else {
    items.push(
      { label: "用默认应用打开", action: () => openEntry(entry as Entry) },
      { label: "标记颜色…", action: () => setTagDialog([entry.path]) },
      { label: "移动到…", action: () => batchMoveTo([entry.path]) },
      { label: "重命名 / 修改格式…", action: () => (store.modals.rename = { paths: [entry.path] }) },
      { sep: true } as any,
      { label: "在 Finder 中显示", action: () => api.reveal(entry.path) },
      { label: "删除", danger: true, action: () => batchDeleteTo([entry.path]) }
    );
  }
  store.ctx = { x, y, items };
}

function batchDeleteTo(paths: string[]) {
  trashConfirm(
    "删除",
    `确定将选中的 ${paths.length} 项移入回收站吗？删除后可在回收站中恢复。`,
    () => trashPaths(paths)
  );
}

function batchMoveTo(paths: string[]) {
  openDirPicker(`移动 ${paths.length} 项到…`, (dest: string) => movePaths(paths, dest), {
    exclude: paths,
    confirmText: "移动到这里",
  });
}

export async function movePaths(paths: string[], dest: string) {
  if (!paths.length) return;
  const filtered = paths.filter((p) => p !== dest && !dest.startsWith(p + "/") && !dest.startsWith(p + "\\"));
  if (!filtered.length) return;
  try {
    await api.moveEntries(filtered, dest);
    toast(`已移动 ${filtered.length} 项`, "ok");
    store.selection = [];
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export async function importPaths(paths: string[]) {
  if (!store.path) return;
  try {
    const n = await api.copyEntries(paths, store.path);
    toast(`已导入 ${n} 项到当前目录`, "ok");
    await refresh();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

// ---------- 搜索 / 最近 / 回收站 ----------

let searchTimer: any = null;

export function searchInput(q: string) {
  store.query = q;
  clearTimeout(searchTimer);
  if (!q.trim()) {
    if (store.view === "search") store.view = "browse";
    return;
  }
  searchTimer = setTimeout(() => doSearch(q), 260);
}

export async function doSearch(q: string) {
  try {
    const res = await api.search(q);
    store.searchResults = res;
    store.view = "search";
    // 搜索结果里的视频/图片条目异步加载真实缩略图（SearchView 据此替换 emoji 图标）
    loadThumbs(res.map((r) => ({ path: r.path, is_dir: r.is_dir, kind: r.kind })));
    if (!res.length) {
      const s = await api.scanStatus();
      if (!s.running && s.count === 0) {
        await startScan();
        toast("索引尚未建立，正在后台扫描，完成后结果会自动出现", "info");
      }
    }
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export function openSearchResult(r: SearchResult) {
  if (r.is_dir) {
    store.query = "";
    navigate(r.path);
  } else {
    // 跳转到文件所在位置：中线定位 + 黄色闪烁（与收藏夹点击同一逻辑）
    locateEntry(r.parent, r.path);
  }
}

export async function loadRecent() {
  try {
    store.recent = await api.recentFiles(120);
    store.view = "recent";
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export async function loadTrash() {
  try {
    // 1.0.2-r6：先触发一次清扫（后端按 expire_at 真删已到期条目），再列列表
    try {
      await api.sweepTrash();
    } catch {
      /* 旧后端无此命令时忽略 */
    }
    store.trash = await api.listTrash(); // 后端列之前会先清掉已到期的条目
    store.view = "trash";
  } catch (e: any) {
    toast(String(e), "err");
  }
}

/** 仅刷新回收站数据（不切换视图）：1.0.2-r8 设置改回收站天数后，条目剩余天数/到期时间立即同步 */
export async function refreshTrashData() {
  try {
    store.trash = await api.listTrash();
  } catch {
    /* ignore */
  }
}

/** 回收站自动清除间隔天数（设置项 trash_ttl_days，缺省 3；0 = 永不自动清除） */
export function trashTtlDays(): number {
  const n = Number(store.settings.trash_ttl_days);
  if (!Number.isFinite(n) || n <= 0) return Number(store.settings.trash_ttl_days) === 0 ? 0 : 3;
  return Math.min(3650, Math.floor(n));
}

/** 天数 → 人话（不足 1 天按小时/分钟，用于回收站条目上的倒计时） */
export function fmtCountdown(msLeft: number): string {
  if (msLeft <= 0) return "即将清除";
  const min = Math.floor(msLeft / 60_000);
  if (min < 60) return `${Math.max(1, min)} 分钟后`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时后`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d} 天 ${rh} 小时后` : `${d} 天后`;
}

/**
 * 移入回收站的统一确认弹窗（1.0.2-r6）。
 * 各入口（右键菜单 / 批量条 / Delete 键 / 播放器 / 图片查看器）都走这里，
 * 以保证「xx 天后自动清除」的提醒措辞与天数口径完全一致。
 */
export function trashConfirm(title: string, what: string, onOk: () => void) {
  const days = trashTtlDays();
  const tail =
    days > 0
      ? `\n\n文件将于 ${days} 天后自动清除，请及时查验。`
      : "\n\n（当前设为「永不自动清除」，可在「设置 → 回收站」中修改）";
  confirmAction(title, `${what}${tail}`, onOk, true);
}

export async function restoreTrash(ids: string[]) {
  try {
    await api.restoreTrash(ids);
    toast("已恢复", "ok");
    await loadTrash();
    await reloadFavorites();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export async function deleteForever(ids: string[]) {
  try {
    await api.deleteForever(ids);
    toast("已彻底删除", "ok");
    await loadTrash();
    await reloadFavorites();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

export async function emptyTrash() {
  try {
    await api.emptyTrash();
    toast("回收站已清空", "ok");
    await loadTrash();
    await reloadFavorites();
  } catch (e: any) {
    toast(String(e), "err");
  }
}

// ---------- 索引扫描 ----------

export async function refreshScanStatus() {
  try {
    const s = await api.scanStatus();
    store.scanRunning = s.running;
    store.scanCount = s.count;
  } catch {
    /* ignore */
  }
}

export async function startScan() {
  try {
    await api.scanStart();
    store.scanRunning = true;
    store.scanCount = 0;
  } catch (e: any) {
    toast(String(e), "err");
  }
}
