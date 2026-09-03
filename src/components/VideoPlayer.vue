<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, assetUrl, b64url, type Entry } from "../api";
import {
  cleanupRemuxCache,
  closePipWindow,
  loadSubtitle,
  loadThumbs,
  openExternalWith,
  pickCaptureDir,
  pickSubtitleFile,
  probeSubtitlesFor,
  setSubtitleEnabled,
  setSubtitleSize,
  snapshotCurrentFrame,
  store,
  toggleMediaFullscreen,
  trashConfirm,
  trashPaths,
} from "../store";
import { cueAt } from "../subtitles";
import { useChrome, useHoldBoost, stripWheelScroll } from "../chrome";
import VideoControls from "./VideoControls.vue";

// 播放队列：与图片查看器一致的上一个/下一个逻辑（列表 = 所在列表的全部视频，循环切换）
// 关闭播放器时 store.modals.player 会先变 null，组件再卸载；这中间若有 watcher / 事件
// 回调被触发，直接取 `!` 断言会抛 "Cannot read properties of null"。这里退化成空队列，
// 让所有读取点拿到 undefined 而不是崩溃（各处对空值都有兜底）。
const queue = computed(() => store.modals.player || { list: [] as Entry[], index: 0 });
const entry = computed<Entry>(
  () => queue.value.list[queue.value.index] || ({} as Entry)
);
const info = ref<{ duration: number | null; width: number | null; height: number | null } | null>(null);
const unsupported = ref(false);
// 播放链路：loading → direct（本地流直连）→ remux（非 MP4 容器/直连失败，无损转封装缓存）→ failed（回退外部播放）
const phase = ref<"loading" | "direct" | "remux" | "failed">("loading");
const percent = ref(0);
const remuxError = ref("");
const src = ref("");
const videoEl = ref<HTMLVideoElement | null>(null);
// 自定义控制栏实例：供快捷键复用其倍速/快进快退实现
const controlsEl = ref<InstanceType<typeof VideoControls> | null>(null);
// 控件伴随即隐：与原生播放控件同一节奏（上一/下一按钮、全屏按钮）
const { chromeVisible, wake, reveal, onLeave, setHideCondition, dispose } = useChrome();
setHideCondition(() => {
  const v = videoEl.value;
  return !!(v && !v.paused && !v.ended);
});
// 快捷键 HUD（音量/静音/续播提示）：短暂显示后淡出
const hud = ref("");
let hudTimer: number | null = null;
function showHud(text: string) {
  hud.value = text;
  if (hudTimer) window.clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => (hud.value = ""), 1400);
}
let pollTimer: number | null = null;
let disposed = false;
let suppressSave = false; // 删除视频后关闭时不留脏进度条目
let playSeq = 0; // 切换视频后使在途的转封装/轮询回调失效
let base = "";
let remuxRetry = 0; // 缓存 URL 加载失败重试次数（避免无限循环）
let remuxStallSince: number | null = null; // 进度卡死计时（连续 90s 无变化即放弃）
let pendingSeek: number | null = null; // 退出独立全屏窗口后要续播的时间点
let pipResumeAt: number | null = null; // 进入全屏前主窗口自身的播放位置（回传状态缺失时的兜底）

// ---- 播放进度记忆（localStorage，最多 300 条，近结尾视为看完即清除） ----
const PROGRESS_KEY = "vt_progress";
function loadProgress(): Record<string, number> {
  try {
    const m = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}
function saveProgress(path: string, t: number, dur?: number) {
  if (!path || !isFinite(t) || t <= 0) return;
  const map = loadProgress();
  if (t < 5 || (dur && isFinite(dur) && dur > 0 && t >= dur - 5)) delete map[path];
  else {
    delete map[path]; // 重新插入保证 LRU 顺序
    map[path] = Math.floor(t);
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete map[k];
  }
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {
    /* 存储满时静默放弃 */
  }
}
function clearProgress(path: string) {
  const map = loadProgress();
  if (!(path in map)) return;
  delete map[path];
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}
function saveCurrent() {
  const v = videoEl.value;
  if (v) saveProgress(entry.value.path, v.currentTime, v.duration);
}

/** 1.0.2 内存优化：主动清空 video 元素 src 并重新 load，
 * 让 WebKit 立即释放解码器/缓冲内存（仅移除元素由 GC 回收有时不及时） */
function releaseDecoder(v: HTMLVideoElement | null) {
  if (!v) return;
  try {
    v.pause();
    v.removeAttribute("src");
    v.load();
  } catch {
    /* 释放解码资源失败忽略 */
  }
}
let lastSave = 0;
function onTimeupdate() {
  const v = videoEl.value;
  if (!v) return;
  subTime.value = v.currentTime; // 字幕 overlay 按当前时间渲染
  const now = Date.now();
  if (now - lastSave < 3000) return;
  lastSave = now;
  saveProgress(entry.value.path, v.currentTime, v.duration);
}
function onLoadedmetadata() {
  tryResume();
}
// 恢复进度：loadedmetadata 与 canplay 双触发点 + 一次性 flag，规避部分 WebKit 版本
// autoplay 起播把 currentTime 短暂归零导致的 seek 竞态
let resumeDone = false;
function tryResume() {
  if (resumeDone) return;
  const v = videoEl.value;
  if (!v || !isFinite(v.duration) || v.duration <= 0) return;
  resumeDone = true;
  // 优先用「退出全屏」回传的节点，其次才是 localStorage 里上次观看的位置
  let t = pendingSeek;
  pendingSeek = null;
  if (t == null) t = loadProgress()[entry.value.path];
  if (t && t > 0 && t < v.duration - 2) {
    v.currentTime = t;
    showHud(`已恢复至 ${dur(t)}`);
  }
}
function onResumeReady() {
  tryResume();
}
// 禁止 WebKit 原生视频元素全屏（双击画面 / 原生全屏按钮触发，Tauri WKWebView 下
// 会脱离应用窗口层级甚至导致进程退出）；满屏一律走组件级独立全屏窗口
function onNativeFs(e: Event) {
  e.preventDefault();
}
function onPause() {
  reveal();
  saveCurrent();
}
function onEnded() {
  reveal();
  clearProgress(entry.value.path);
}

/**
 * 单击画面 = 暂停/继续；双击画面 = 进入/退出全屏。
 * 浏览器会先派发 click 再派发 dblclick，直接监听两者会导致双击时
 * 先触发一次多余的暂停，因此改用 230ms 计时器自行判定：
 * 第二次点击在窗口内到达就撤销待执行的「单击」语义、转为双击。
 */
let stageClickTimer: number | undefined;
function onStageClick() {
  reveal();
  if (stageClickTimer !== undefined) {
    window.clearTimeout(stageClickTimer);
    stageClickTimer = undefined;
    toggleMediaFullscreen();
    return;
  }
  stageClickTimer = window.setTimeout(() => {
    stageClickTimer = undefined;
    const v = videoEl.value;
    if (!v) return;
    if (v.paused || v.ended) {
      v.play().catch(() => {});
      showHud("▶ 继续播放");
    } else {
      v.pause();
      showHud("⏸ 已暂停");
    }
  }, 230);
}

function closePlayer(save = true) {
  if (store.pipLabel) closePipWindow(); // 同步关闭独立全屏窗口
  if (save) saveCurrent();
  // 1.0.2-r3「关闭即删」：清理本片的转封装缓存副本（等大副本，可再生；设置可关）
  cleanupRemuxCache(entry.value?.path);
  store.modals.player = null;
}

function streamUrl(kind: "raw" | "cache"): string {
  return `${base}${kind}/${b64url(entry.value.path)}`;
}

async function init() {
  const seq = ++playSeq;
  const path = entry.value.path;
  if (!path) return; // 播放器已关闭：不要再走建流/转封装链路
  phase.value = "loading";
  percent.value = 0;
  remuxError.value = "";
  src.value = "";
  unsupported.value = false;
  resumeDone = false;
  remuxRetry = 0;
  remuxStallSince = null;
  try {
    base = await api.streamBase();
    if (seq !== playSeq) return;
    const moov = await api.moovPosition(path).catch(() => "unknown");
    if (seq !== playSeq) return;
    // front：moov 在前，浏览器可直接流播
    // late：moov 在尾部 —— 关键修复：过去只要不是 front 就强制先把整份文件无损转封装
    //       （`-c copy +faststart` 要读完再写一遍），几百 MB 的片源因此长期卡在
    //       "正在为大文件准备流式播放 → 处理中…"，完全无法起播。
    //       实际上 WKWebView 对支持 Range 的 HTTP 源会自己取尾部字节定位 moov，
    //       所以这里**直接播**；万一失败，onVideoError 会再走转封装兜底。
    // unknown：64 个 atom 内既无 moov 也无 mdat，多为 MKV/AVI/RMVB 等非 MP4 容器，
    //          WKWebView 基本无法解码，直接预转封装，省掉一次必然失败的等待。
    if (moov === "unknown") {
      await runRemux(seq, path);
      return;
    }
    src.value = streamUrl("raw");
    phase.value = "direct";
  } catch {
    if (seq !== playSeq) return;
    // 流服务不可用：退回 asset 协议直连（小文件通常仍可播）
    src.value = assetUrl(path);
    phase.value = "direct";
  }
}

async function onVideoError() {
  // 仅在「直连播放」阶段（phase === "direct"）触发的 error 才走转封装兜底：
  //  - 初次尝试 raw（直连原始文件）失败 → 走 remux
  //  - remux 完成后 phase 切回 direct；缓存 URL 加载异常时再次走 remux，但此时
  //    start_remux 会立即返回 done（缓存已存在），于是又会进到同一个失败 URL，
  //    因此加 retry 计数器防止无限循环：连续失败 ≥2 次则放弃并提示用户
  if (phase.value !== "direct") return;
  if (remuxRetry >= 2) {
    remuxError.value = "播放失败：缓存文件无法加载，请关闭播放器用外部应用打开";
    unsupported.value = true;
    return;
  }
  remuxRetry++;
  await runRemux(playSeq, entry.value.path);
}

async function runRemux(seq: number, path: string) {
  if (!base) {
    // 流服务不可用（转封装结果也无法经流播放）：直接走外部播放器兜底
    if (seq === playSeq) unsupported.value = true;
    return;
  }
  if (seq !== playSeq) return;
  phase.value = "remux";
  percent.value = 0;
  remuxError.value = "";
  src.value = "";
  try {
    const st = await api.startRemux(path);
    if (seq !== playSeq) return;
    if (st.status === "error") {
      remuxError.value = st.error;
      unsupported.value = true;
      return;
    }
    await pollRemux(seq, path);
  } catch {
    if (seq === playSeq) unsupported.value = true;
  }
}

async function pollRemux(seq: number, path: string) {
  if (disposed || seq !== playSeq) return;
  if (pollTimer) window.clearTimeout(pollTimer);
  const st = await api.remuxStatus(path).catch(() => null);
  if (disposed || seq !== playSeq || path !== entry.value.path) return;
  if (!st) {
    // Rust 端不可达：兜底走外部播放器
    unsupported.value = true;
    return;
  }
  // 进度卡死检测：若连续 90 秒内进度纹丝不动，认为 ffmpeg 异常退出但状态没刷新，
  // 主动报错并放弃（避免用户在界面上看到永远不动的进度条）
  if (st.percent === percent.value && st.status === "running") {
    if (!remuxStallSince) remuxStallSince = Date.now();
    else if (Date.now() - remuxStallSince > 90_000) {
      remuxError.value = "转封装进度停滞（90 秒无变化），请重试或用外部播放器打开";
      unsupported.value = true;
      return;
    }
  } else {
    remuxStallSince = null;
  }
  percent.value = st.percent;
  if (st.status === "done") {
    src.value = streamUrl("cache");
    // 转封装完成 → 切回 direct 阶段；后续 onVideoError 命中"直连失败"分支，
    // 缓存 URL 加载异常时能再次走转封装兜底
    phase.value = "direct";
    return;
  }
  if (st.status === "error") {
    remuxError.value = st.error;
    unsupported.value = true;
    return;
  }
  // 后台转封装进行中：保持 600ms 间隔轮询（ffmpeg 进度正常情况下数百毫秒更新一次，
  // 600ms 既能及时反映进度，也避免高频 invoke 把 IPC 队列堵满）
  pollTimer = window.setTimeout(() => pollRemux(seq, path), 600);
}

function nav(delta: number) {
  const n = queue.value.list.length;
  if (n < 2) return;
  queue.value.index = (queue.value.index + delta + n) % n;
}

function dur(n: number | null): string {
  if (!n || !isFinite(n)) return "";
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- 字幕 overlay（1.0.2-r7） ----------
// 字幕数据流：store.probeSubtitlesFor 探测/加载 → 解析成 cues；
// 这里仅按 video.currentTime 查找命中 cue 渲染文本（每 250ms 一次，性能无忧）。
const subTime = ref(0);
const subText = computed(() => {
  const sub = store.subtitle;
  if (!sub.enabled || !sub.cues.length) return null;
  return cueAt(sub.cues, subTime.value);
});

/** 截图当前帧（S 键 / 控制栏按钮） */
async function captureNow() {
  const v = videoEl.value;
  if (!v || !entry.value.path) return;
  await snapshotCurrentFrame(entry.value.path, v.currentTime);
}

/** 选择字幕轨道（控制栏 CC 菜单；空字符串 = 关闭字幕） */
function selectSubtitleTrack(path: string) {
  if (!path) {
    loadSubtitle(null);
    return;
  }
  const t = store.subtitle.tracks.find((x) => x.path === path) || null;
  loadSubtitle(t);
}

// ---------- 缩略图条（与图片查看器一致：底部 60×45，可拖动横滑、点击跳转） ----------
const stripEl = ref<HTMLElement | null>(null);

function thumbSrc(e: { path: string; cover: string | null }): string {
  if (store.thumbs[e.path]) return store.thumbs[e.path];
  if (e.cover) return assetUrl(`${store.coversDir}/${e.cover}`);
  return "";
}

function jump(i: number) {
  if (i === queue.value.index) return;
  queue.value.index = i;
  reveal();
}

function scrollStripActive() {
  const strip = stripEl.value;
  if (!strip) return;
  const cur = strip.querySelector(".cur") as HTMLElement | null;
  if (!cur) return;
  strip.scrollLeft = cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2;
}

let stripDragging = false;
let stripMoved = false;
let stripStartX = 0;
let stripStartScroll = 0;
const STRIP_DRAG_THRESHOLD = 4;
function onStripDown(e: MouseEvent) {
  const strip = stripEl.value;
  if (!strip) return;
  stripDragging = true;
  stripMoved = false;
  stripStartX = e.clientX;
  stripStartScroll = strip.scrollLeft;
}
function onStripMove(e: MouseEvent) {
  if (!stripDragging) return;
  const strip = stripEl.value;
  if (!strip) return;
  const dx = e.clientX - stripStartX;
  if (!stripMoved && Math.abs(dx) > STRIP_DRAG_THRESHOLD) {
    stripMoved = true;
    strip.classList.add("dragging");
  }
  if (stripMoved) strip.scrollLeft = stripStartScroll - dx;
}
function onStripUp() {
  if (!stripDragging) return;
  stripDragging = false;
  if (stripMoved) stripEl.value?.classList.remove("dragging");
}
// 缩略图条滚轮：悬停条带转动滚轮即前后浏览（纵向滚轮转横向滚动），滚动时保持控件常驻
function onStripWheel(e: WheelEvent) {
  if (stripWheelScroll(e, stripEl.value)) wake();
}
// 在 strip 上拦截 click：当本次按下发生过拖动，不让点击穿透到缩略图触发 jump
function onStripClickCapture(e: MouseEvent) {
  if (stripMoved) {
    e.stopPropagation();
    e.preventDefault();
  }
}

// ---------- 独立窗口全屏：主窗口隐藏 + 暂停 ⇄ 恢复 + 续播 ----------
watch(
  () => store.pipActive,
  (on) => {
    const v = videoEl.value;
    if (on) {
      // 进入全屏：暂停并记住当前位置（画面保持挂载，仅 v-show 隐藏）
      if (v) {
        pipResumeAt = v.currentTime;
        saveProgress(entry.value.path, v.currentTime, v.duration);
        v.pause();
      }
    } else {
      nextTick(applyPipResume);
    }
  }
);

/** 退出全屏：按独立窗口回传的 index/进度继续播放（元素未销毁 → 零重新缓冲） */
function applyPipResume() {
  if (!store.modals.player) return;
  const st = store.pipResult;
  const want = st ? st.index : queue.value.index;
  if (want >= 0 && want < queue.value.list.length && want !== queue.value.index) {
    // 换了条目：改 index 会触发 init() 重建 video 元素，
    // pendingSeek 会在新元素 loadedmetadata 时生效
    queue.value.index = want;
  }
  const target = st && st.time > 0 ? st.time : pipResumeAt;
  if (target && target > 0) {
    pendingSeek = target;
    resumeDone = false;
  }
  pipResumeAt = null;
  nextTick(() => {
    const v = videoEl.value;
    if (!v) return; // 条目已切换 → 等新元素的 tryResume 处理
    if (
      pendingSeek != null &&
      isFinite(v.duration) &&
      v.duration > 0 &&
      pendingSeek < v.duration - 2
    ) {
      v.currentTime = pendingSeek;
      pendingSeek = null;
      resumeDone = true;
    }
    v.play().catch(() => {});
    reveal();
  });
}

// 切换视频 → 保存上一部进度并重新走完整播放链路；顺带唤醒控件（隐藏态下键盘切视频时按钮不至消失）
watch(
  () => entry.value?.path,
  (p, old) => {
    if (!p) return;
    if (old) {
      const v = videoEl.value; // pre-flush：此刻 DOM 未更新，videoEl 仍是旧元素
      if (v) saveProgress(old, v.currentTime, v.duration);
      rightHold.reset(); // 1.0.2-r10：切条目先撤销长按加速，避免倍速状态被带到新视频
      releaseDecoder(v); // 1.0.2：切换视频立即释放旧解码器内存
      cleanupRemuxCache(old); // 1.0.2-r3：切走即删上一部的转封装副本
    }
    info.value = null;
    reveal();
    init();
    probeSubtitlesFor(p); // 1.0.2-r7：探测同目录字幕并自动加载同名轨道
    api
      .videoInfo(p)
      .then((v) => {
        if (p === entry.value.path) info.value = v;
      })
      .catch(() => {});
    nextTick(scrollStripActive);
  }
);

function onKey(e: KeyboardEvent) {
  // 确认弹窗（如删除确认）打开时，快捷键只作用于确认层
  if (store.confirm) return;
  if (store.pipActive) return; // 全屏交互全在独立窗口，主窗口快捷键让位
  const v = videoEl.value;
  if (e.key === "Escape" && !e.repeat) {
    // 独立全屏窗口存在时 Esc 优先关闭它；否则按传统逻辑（先退出满屏，再关播放器）
    if (store.pipLabel) closePipWindow();
    else closePlayer();
    return;
  }
  // 带修饰键的组合（如 Cmd+M 最小化 / Ctrl+F 查找）不当作播放快捷键
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " " && !e.repeat && v) {
    e.preventDefault();
    if (v.paused) {
      v.play().catch(() => {});
      showHud("▶ 继续播放");
    } else {
      v.pause();
      showHud("⏸ 已暂停");
    }
    return;
  }
  if ((e.key === "m" || e.key === "M") && !e.repeat && v) {
    v.muted = !v.muted;
    showHud(v.muted ? "🔇 已静音" : `🔊 音量 ${Math.round(v.volume * 100)}%`);
    return;
  }
  if ((e.key === "f" || e.key === "F") && !e.repeat) {
    toggleMediaFullscreen();
    return;
  }
  // J / L：快退 / 快进 10 秒（YouTube 习惯）
  if ((e.key === "j" || e.key === "J") && !e.repeat && v) {
    e.preventDefault();
    controlsEl.value?.seekBy(-10);
    showHud("⏪ 快退 10 秒");
    return;
  }
  if ((e.key === "l" || e.key === "L") && !e.repeat && v) {
    e.preventDefault();
    controlsEl.value?.seekBy(10);
    showHud("⏩ 快进 10 秒");
    return;
  }
  // [ / ]：按 0.25 步长降 / 升倍速（夹在 0.25 – 6，1.0.2-r8）
  if ((e.key === "[" || e.key === "]") && !e.repeat && v) {
    e.preventDefault();
    controlsEl.value?.stepRate(e.key === "[" ? -0.25 : 0.25);
    showHud(`⏱ ${v.playbackRate}×`);
    return;
  }
  // C：字幕显示开关（1.0.2-r7）
  if ((e.key === "c" || e.key === "C") && !e.repeat) {
    const sub = store.subtitle;
    if (!sub.cues.length) {
      showHud("无可用字幕");
      return;
    }
    setSubtitleEnabled(!sub.enabled);
    showHud(sub.enabled ? "💬 字幕已开启" : "💬 字幕已关闭");
    return;
  }
  // S：截图当前帧（1.0.2-r7）
  if ((e.key === "s" || e.key === "S") && !e.repeat && v) {
    captureNow();
    return;
  }
  if (e.key === "ArrowUp" && v) {
    e.preventDefault();
    v.muted = false;
    v.volume = Math.min(1, v.volume + 0.1);
    showHud(`🔊 音量 ${Math.round(v.volume * 100)}%`);
    return;
  }
  if (e.key === "ArrowDown" && v) {
    e.preventDefault();
    v.volume = Math.max(0, v.volume - 0.1);
    showHud(v.volume === 0 ? "🔇 已静音" : `🔊 音量 ${Math.round(v.volume * 100)}%`);
    return;
  }
  // 视频元素聚焦时 ←/→ 交给原生快进快退
  if ((e.target as HTMLElement)?.tagName === "VIDEO") return;
  // ← / →：切换上一个 / 下一个视频（队列不足 2 个时不动作）。
  // 1.0.2-r10：右方向键长按（约 400ms）= 临时进入当前倍速的 2 倍速，松开恢复；
  // 判定窗内松开 = 短按，仍走「下一个视频」（语义不变，触发时机移到 keyup）。
  if (e.key === "ArrowRight") rightHold.down();
  else if (e.key === "ArrowLeft") nav(-1);
}

// 1.0.2-r10：长按右方向键临时 2× 播放（短按仍为「下一个视频」）
const rightHold = useHoldBoost({
  video: () => videoEl.value,
  hud: showHud,
  tap: () => nav(1),
});
function onKeyUp(e: KeyboardEvent) {
  if (e.key !== "ArrowRight") return;
  if (store.pipActive) return; // 与 keydown 对称：全屏交互在独立窗口，主窗口让位
  rightHold.up();
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  wake();
  init();
  probeSubtitlesFor(entry.value.path); // 1.0.2-r7：播放器打开即探测/加载字幕（watch 不 immediate，需显式首调）
  loadThumbs(queue.value.list); // 补齐缩略图条所需（网格可能只加载了当前目录）
  api
    .videoInfo(entry.value.path)
    .then((v) => info.value = v)
    .catch(() => {});
  nextTick(scrollStripActive);
  window.addEventListener("keyup", onKeyUp); // 1.0.2-r10：右方向键短按/长按判定收尾
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKeyUp); // 1.0.2-r10
  rightHold.reset(); // 1.0.2-r10：关闭播放器撤销未决的长按加速状态
  if (stageClickTimer !== undefined) window.clearTimeout(stageClickTimer);
  if (pollTimer) window.clearTimeout(pollTimer);
  if (hudTimer) window.clearTimeout(hudTimer);
  const v = videoEl.value;
  if (v && !suppressSave && entry.value.path) {
    saveProgress(entry.value.path, v.currentTime, v.duration);
  }
  releaseDecoder(v); // 1.0.2：关闭播放器立即释放解码器内存
  cleanupRemuxCache(entry.value?.path); // 1.0.2-r3：兜底清理转封装副本（App 层直接卸载时走这里）
  dispose();
});
</script>

<template>
  <div class="player-mask" @mousemove="wake()" @mouseleave="onLeave">
    <!-- 顶部信息栏：文件名、计数、分辨率/时长、文件操作（删除 / 用默认播放器打开 / 关闭）
         与自定义按钮、缩略图条同一节奏：鼠标静止后一起淡出，鼠标一动一起浮现 -->
    <div class="player-head" :class="{ 'nav-hidden': !chromeVisible }">
      <div class="t">{{ entry.name }}</div>
      <span v-if="queue.list.length > 1" style="font-size: 12px; color: #7f9db8; flex-shrink: 0">
        {{ queue.index + 1 }} / {{ queue.list.length }}
      </span>
      <span v-if="info && info.width" style="font-size: 12px; color: #7f9db8">
        {{ info.width }}×{{ info.height }}{{ dur(info.duration) ? " · " + dur(info.duration) : "" }}
      </span>
      <button
        class="btn danger"
        @click="trashConfirm('删除视频', `确定将「${entry.name}」移入回收站吗？可在回收站中恢复。`, () => { trashPaths([entry.path]); clearProgress(entry.path); suppressSave = true; closePlayer(false); })"
      >
        删除
      </button>
      <button class="btn" @click="openExternalWith(entry.path, 'video')">用默认播放器打开</button>
      <button class="btn" @click="closePlayer()">关闭</button>
    </div>
    <div class="player-body">
      <template v-if="phase === 'loading'">
        <div class="player-fallback" style="color: #9db8d0; font-size: 13px">正在准备播放…</div>
      </template>
      <template v-else-if="phase === 'remux' && !src">
        <!-- 转封装进行中：无损复制数据流，首次需读完整个文件 -->
        <div class="player-fallback">
          <div class="big">🎬</div>
          <p>
            正在为大文件准备流式播放（无损转封装，不重新编码）<br />
            首次需要读取整个文件，之后直接秒开
          </p>
          <div class="remux-bar">
            <div class="remux-fill" :style="{ width: (percent || 4) + '%' }"></div>
          </div>
          <div style="font-size: 12px; color: #9db8d0; margin-top: 8px">
            {{ percent > 0 ? percent + "%" : "处理中…" }}
          </div>
        </div>
      </template>
      <video
        v-else-if="!unsupported && src"
        ref="videoEl"
        :key="entry.path"
        :src="src"
        class="fill"
        autoplay
        playsinline
        webkit-playsinline
        @play="reveal"
        @pause="onPause"
        @ended="onEnded"
        @timeupdate="onTimeupdate"
        @loadedmetadata="onLoadedmetadata"
        @canplay="onResumeReady"
        @click="onStageClick"
        @webkitbeginfullscreen.prevent="onNativeFs"
        @error="onVideoError"
      ></video>
      <!-- 1.0.2-r7 字幕 overlay：命中当前时间点的 cue 即显示（位于视频下部，避开控制栏/缩略条） -->
      <div
        v-if="subText"
        class="player-sub"
        :style="{ fontSize: 15 * store.subtitle.size + 'px' }"
      >{{ subText }}</div>
      <!-- 1.0.2-r5 自定义控制栏：进度条悬停实时帧预览（替换原生 controls） -->
      <VideoControls
        v-if="!unsupported && src"
        ref="controlsEl"
        :video="videoEl"
        :path="entry.path"
        :visible="chromeVisible"
        :bottom-offset="queue.list.length > 1 ? 66 : 0"
        pip-mode="native"
        :sub-active="store.subtitle.cues.length > 0"
        :sub-enabled="store.subtitle.enabled"
        :sub-size="store.subtitle.size"
        :sub-tracks="store.subtitle.tracks"
        :sub-active-path="store.subtitle.active"
        :sub-busy="store.subtitle.busy"
        @toggle-sub="setSubtitleEnabled(!store.subtitle.enabled)"
        @sub-size="setSubtitleSize"
        @sub-track="selectSubtitleTrack"
        @sub-pick="pickSubtitleFile()"
        @capture="captureNow()"
        @capture-dir="pickCaptureDir()"
      />
      <div v-else class="player-fallback">
        <div class="big">🎬</div>
        <p>
          {{ remuxError || "浏览器内核无法解码该格式（如 MKV / RMVB / AV1 等）" }}<br />
          请关闭播放器后用外部播放器打开
        </p>
      </div>
      <div v-if="hud" class="player-hud">{{ hud }}</div>
      <!-- 进入独立窗口全屏（占满整屏）：置于「下一个」按钮正下方（间距半个图标高度 22px），
           与上/下一个按钮同风格（44px 圆形 + 白色线条图标）。点击后主窗口画面隐藏+暂停，
           视频在独立 OS 窗口中继续；退出全屏后主窗口从当前节点无缝续播。 -->
      <button
        class="fs-btn"
        :class="{ 'nav-hidden': !chromeVisible }"
        title="全屏播放（双击画面 / F 键切换）"
        @click="toggleMediaFullscreen()"
        @dblclick.stop
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
        </svg>
      </button>
      <!-- 上一个 / 下一个视频（列表内循环）：跟随播放控件一同显隐 -->
      <button
        v-if="queue.list.length > 1"
        class="img-nav prev"
        :class="{ 'nav-hidden': !chromeVisible }"
        title="上一个视频（←）"
        @click="nav(-1)"
      >‹</button>
      <button
        v-if="queue.list.length > 1"
        class="img-nav next"
        :class="{ 'nav-hidden': !chromeVisible }"
        title="下一个视频（→）"
        @click="nav(1)"
      >›</button>
      <!-- 底部缩略图条：60×45px（不遮挡主画面）；支持鼠标拖动横向滑动 + 点击跳转 -->
      <div
        v-if="queue.list.length > 1"
        ref="stripEl"
        class="img-strip"
        :class="{ 'strip-hidden': !chromeVisible }"
        @dblclick.stop
        @wheel="onStripWheel"
        @mousedown.prevent="onStripDown"
        @mousemove="onStripMove"
        @mouseup="onStripUp"
        @mouseleave="onStripUp"
        @click.capture="onStripClickCapture"
      >
        <template v-for="(e, i) in queue.list" :key="e.path">
          <img
            v-if="thumbSrc(e)"
            :src="thumbSrc(e)"
            :class="{ cur: i === queue.index }"
            loading="lazy"
            decoding="async"
            draggable="false"
            :title="e.name"
            @click="jump(i)"
          />
          <div
            v-else
            class="thumb-ph"
            :class="{ cur: i === queue.index }"
            :title="e.name"
            @click="jump(i)"
          >🎬</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 上一/下一按钮与原生播放控件同步显隐：浮现/淡出均不可点击 */
.img-nav {
  transition: opacity 0.35s ease, background 0.15s;
}
/* 1.0.2-r6：自定义控制栏为两行紧凑布局且可整体上移，缩略图条恢复贴底（12px），
   控制栏（queue>1 时 bottom=76px）与缩略条之间留有间隙，互不遮挡。 */
.img-strip {
  bottom: 12px;
}
.img-nav.nav-hidden {
  opacity: 0;
  pointer-events: none;
}
.remux-bar {
  width: min(420px, 70vw);
  height: 10px;
  margin: 14px auto 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.remux-fill {
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, #3e8fd6, #6db5ee);
  transition: width 0.4s ease;
}
/* 1.0.2-r7 字幕 overlay：半透明底、居中、位于视频下部 13%（避开底部控制栏/缩略条） */
.player-sub {
  position: absolute;
  left: 50%;
  bottom: 13%;
  transform: translateX(-50%);
  max-width: 84%;
  padding: 6px 14px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 15px;
  line-height: 1.5;
  text-align: center;
  white-space: pre-wrap;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.65);
  z-index: 4;
  pointer-events: none;
  user-select: none;
}
</style>
