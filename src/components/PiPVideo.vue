<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, assetUrl, b64url, type PipMedia, type PipPayload } from "../api";
import { cleanupRemuxCache } from "../store";
import { cueAt } from "../subtitles";
import { stripWheelScroll, useHoldBoost } from "../chrome";
import VideoControls from "./VideoControls.vue";

const props = defineProps<{
  entry: PipMedia;
  payload: PipPayload;
  index: number;
  chromeVisible: boolean;
}>();
const emit = defineEmits<{
  nav: [delta: number];
  state: [{ time: number }];
  exit: [];
  wake: [];
}>();

const phase = ref<"loading" | "direct" | "remux" | "failed">("loading");
const percent = ref(0);
const remuxError = ref("");
const unsupported = ref(false);
const src = ref("");
const videoEl = ref<HTMLVideoElement | null>(null);
// 自定义控制栏实例：供快捷键复用其倍速/快进快退实现
const controlsEl = ref<InstanceType<typeof VideoControls> | null>(null);
let base = "";
let playSeq = 0;
let pollTimer: number | null = null;
let disposed = false;
let remuxRetry = 0; // 缓存 URL 加载失败重试次数（避免无限循环）
let remuxStallSince: number | null = null; // 进度卡死计时（连续 90s 无变化即放弃）

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
    delete map[path];
    map[path] = Math.floor(t);
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete map[k];
  }
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
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

const hud = ref("");
let hudTimer: number | null = null;
function showHud(text: string) {
  hud.value = text;
  if (hudTimer) window.clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => (hud.value = ""), 1400);
}

// ---------- 字幕（1.0.2-r7）：从主窗口 payload 快照恢复，全屏期间本地调整不回写 ----------
const subCues = ref(props.payload.subtitle?.cues ?? []);
const subEnabled = ref(props.payload.subtitle?.enabled ?? true);
const subSize = ref(props.payload.subtitle?.size ?? 1);
const subActive = computed(() => subCues.value.length > 0);
const subTime = ref(0);
const subText = computed(() => {
  if (!subEnabled.value || !subCues.value.length) return null;
  return cueAt(subCues.value, subTime.value);
});

/** PiP 内「关闭字幕」：快照语义下直接清空本地 cues（不回写主窗口） */
function clearSubTrack(_path: string) {
  subCues.value = [];
}

function streamUrl(kind: "raw" | "cache"): string {
  return `${base}${kind}/${b64url(props.entry.path)}`;
}

async function init() {
  const seq = ++playSeq;
  const path = props.entry.path;
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
    // front：moov 在前，浏览器直接流播
    // late：moov 在尾部 —— WKWebView 对支持 Range 的 HTTP 源会自己取尾部字节找 moov，
    //       因此**不再**强制先转封装整份文件（几百 MB 会卡在"准备中"几十秒到几分钟），
    //       直接播；万一失败，onVideoError 会再走转封装兜底。
    // unknown：64 个 atom 内既无 moov 也无 mdat，多为 MKV/AVI 等非 MP4 容器，
    //          WKWebView 基本无法解码，直接预转封装避免一次无谓的失败等待。
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
  // 仅「直连播放」阶段触发的 error 才走转封装兜底。
  // remux 完成后 phase 切回 direct，缓存 URL 异常时会再次进入这里 → retry 计数防死循环。
  if (phase.value !== "direct") return;
  if (remuxRetry >= 2) {
    remuxError.value = "播放失败：缓存文件无法加载，请用外部播放器打开";
    unsupported.value = true;
    return;
  }
  remuxRetry++;
  await runRemux(playSeq, props.entry.path);
}

async function runRemux(seq: number, path: string) {
  if (!base) {
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
  if (disposed || seq !== playSeq || path !== props.entry.path) return;
  if (!st) {
    // Rust 端不可达：兜底走外部播放器
    unsupported.value = true;
    return;
  }
  // 进度卡死检测：连续 90 秒纹丝不动视为 ffmpeg 异常退出但状态没刷新
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
    phase.value = "direct";
    return;
  }
  if (st.status === "error") {
    remuxError.value = st.error;
    unsupported.value = true;
    return;
  }
  pollTimer = window.setTimeout(() => pollRemux(seq, path), 600);
}

function nav(delta: number) {
  const n = props.payload.list.length;
  if (n < 2) return;
  const v = videoEl.value;
  if (v) saveProgress(props.entry.path, v.currentTime, v.duration);
  props.payload.index = (props.index + delta + n) % n;
  emit("nav", delta);
}

/** 1.0.2 内存优化：主动清空 video src 并重新 load，让 WebKit 立即释放解码器内存 */
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

function onNativeFs(e: Event) {
  e.preventDefault();
}

/**
 * 单击画面 = 暂停/继续；双击画面 = 退出全屏。
 * 浏览器先派发 click 再派发 dblclick，直接监听两者会让双击先触发一次多余暂停，
 * 故用 230ms 计时器自行判定：窗口内第二次点击到达即撤销单击语义、转为双击。
 */
let stageClickTimer: number | undefined;
function onStageClick() {
  if (stageClickTimer !== undefined) {
    window.clearTimeout(stageClickTimer);
    stageClickTimer = undefined;
    void exitPip();
    return;
  }
  stageClickTimer = window.setTimeout(() => {
    stageClickTimer = undefined;
    emit("wake");
    const v = videoEl.value;
    if (!v) return;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  }, 230);
}

function onPlaying() {
  (window as any).__pipPlaying = true;
  emit("wake");
}
function onPauseOrEnded() {
  (window as any).__pipPlaying = false;
  emit("wake");
  const v = videoEl.value;
  if (v && phase.value === "direct") {
    saveProgress(props.entry.path, v.currentTime, v.duration);
    emit("state", { time: v.currentTime });
  }
}

let lastSave = 0;
function onTimeupdate() {
  const v = videoEl.value;
  if (!v) return;
  subTime.value = v.currentTime; // 字幕 overlay 按当前时间渲染
  const now = Date.now();
  // 1s 上报一次给主窗口（退出全屏时按此位置续播）；3s 落一次 localStorage
  if (now - lastSave < 1000) return;
  lastSave = now;
  emit("state", { time: v.currentTime });
  saveProgress(props.entry.path, v.currentTime, v.duration);
}
let resumeDone = false;
function tryResume() {
  if (resumeDone) return;
  const v = videoEl.value;
  if (!v || !isFinite(v.duration) || v.duration <= 0) return;
  resumeDone = true;
  const t = loadProgress()[props.entry.path];
  if (t && t > 5 && t < v.duration - 5) {
    v.currentTime = t;
    showHud(`已恢复至 ${dur(t)}`);
  }
}

/**
 * loadedmetadata：拿到 duration 后尝试恢复进度，并主动调 play() 触发 WKWebView autoplay。
 * PiP 直接全屏打开的场景下没有用户手势，autoplay 必须 muted 才能启动；
 * 用户在 video controls 上调音量或按 M 键即可手动解除静音（与主窗口一致）。
 */
function onLoadedmeta() {
  tryResume();
  const v = videoEl.value;
  if (v && v.paused) v.play().catch(() => {});
}
function onCanPlay() {
  tryResume();
}

function dur(n: number | null): string {
  if (!n || !isFinite(n)) return "";
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function onKey(e: KeyboardEvent) {
  const v = videoEl.value;
  if (e.key === "Escape") {
    void exitPip();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " " && !e.repeat && v) {
    e.preventDefault();
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    return;
  }
  if ((e.key === "m" || e.key === "M") && !e.repeat && v) {
    v.muted = !v.muted;
    showHud(v.muted ? "🔇 已静音" : `🔊 音量 ${Math.round(v.volume * 100)}%`);
    return;
  }
  if ((e.key === "f" || e.key === "F") && !e.repeat) {
    void exitPip();
    return;
  }
  // J / L：快退 / 快进 10 秒
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
  rightHold.up();
}

// ---------- 缩略图条（与图片查看器一致：底部 60×45，可拖动横滑、点击跳转） ----------
const thumbs = ref<Record<string, string>>({});
const stripEl = ref<HTMLElement | null>(null);

async function loadThumbs() {
  const need = props.payload.list.filter((e) => !thumbs.value[e.path]);
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 8) {
    const chunk = need.slice(i, i + 8);
    try {
      const res = await api.getThumbs(
        chunk.map((e) => ({ path: e.path, is_dir: false, is_video: true }))
      );
      for (const r of res) if (r.thumb) thumbs.value[r.path] = assetUrl(r.thumb);
    } catch {
      /* 缩略图失败忽略：条带里回退占位图标 */
    }
  }
}

function thumbSrc(e: PipMedia): string {
  if (thumbs.value[e.path]) return thumbs.value[e.path];
  if (e.cover) return assetUrl(`${props.payload.covers_dir}/${e.cover}`);
  return "";
}

function jumpTo(i: number) {
  if (i === props.index) return;
  const v = videoEl.value;
  if (v) saveProgress(props.entry.path, v.currentTime, v.duration);
  props.payload.index = i;
  emit("nav", 0);
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
// 缩略图条滚轮：悬停条带转动滚轮即前后浏览（与主窗播放器同一实现）
function onStripWheel(e: WheelEvent) {
  if (stripWheelScroll(e, stripEl.value)) emit("wake");
}
function onStripClickCapture(e: MouseEvent) {
  if (stripMoved) {
    e.stopPropagation();
    e.preventDefault();
  }
}

/**
 * 退出 PiP：先由父组件（PiPRoot）落盘当前状态再关窗 ——
 * 主窗口通过 pip-closed + take_pip_state 取回节点并续播。
 */
async function exitPip() {
  const v = videoEl.value;
  if (v) emit("state", { time: v.currentTime });
  emit("exit");
}

watch(
  () => props.entry.path,
  (p, old) => {
    if (!p) return;
    if (old) {
      const v = videoEl.value;
      if (v) saveProgress(old, v.currentTime, v.duration);
      rightHold.reset(); // 1.0.2-r10：切条目先撤销长按加速，避免倍速状态被带到新视频
      releaseDecoder(v); // 1.0.2：切换视频立即释放旧解码器内存
      cleanupRemuxCache(old); // 1.0.2-r3：切走即删上一部的转封装副本（开关后端判断）
    }
    resumeDone = false;
    init();
    nextTick(scrollStripActive);
  }
);

onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp); // 1.0.2-r10：右方向键短按/长按判定收尾
  init();
  void loadThumbs();
  nextTick(scrollStripActive);
});
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKeyUp); // 1.0.2-r10
  rightHold.reset(); // 1.0.2-r10：关闭窗口撤销未决的长按加速状态
  if (stageClickTimer !== undefined) window.clearTimeout(stageClickTimer);
  if (pollTimer) window.clearTimeout(pollTimer);
  if (hudTimer) window.clearTimeout(hudTimer);
  const v = videoEl.value;
  if (v) {
    saveProgress(props.entry.path, v.currentTime, v.duration);
    emit("state", { time: v.currentTime });
    releaseDecoder(v); // 1.0.2：关闭窗口立即释放解码器内存
  }
});
</script>

<template>
  <div class="pip-body">
    <template v-if="phase === 'loading'">
      <div class="pip-fallback" style="margin: auto; color: #9db8d0; font-size: 13px">
        正在准备播放…
      </div>
    </template>
    <template v-else-if="phase === 'remux' && !src">
      <div class="pip-fallback" style="margin: auto">
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
      muted
      playsinline
      webkit-playsinline
      @play="onPlaying"
      @pause="onPauseOrEnded"
      @ended="onPauseOrEnded"
      @timeupdate="onTimeupdate"
      @loadedmetadata="onLoadedmeta"
      @canplay="onCanPlay"
      @click="onStageClick"
      @webkitbeginfullscreen.prevent="onNativeFs"
      @error="onVideoError"
    ></video>
    <!-- 1.0.2-r7 字幕 overlay：与主窗口同一渲染逻辑（数据来自 payload 快照） -->
    <div
      v-if="subText"
      class="pip-sub"
      :style="{ fontSize: 15 * subSize + 'px' }"
    >{{ subText }}</div>
    <!-- 1.0.2-r5 自定义控制栏：进度条悬停实时帧预览（替换原生 controls） -->
    <VideoControls
      v-if="!unsupported && src"
      ref="controlsEl"
      :video="videoEl"
      :path="entry.path"
      :visible="chromeVisible"
      :bottom-offset="payload.list.length > 1 ? 66 : 0"
      pip-mode="exit-fullscreen"
      :sub-active="subActive"
      :sub-enabled="subEnabled"
      :sub-size="subSize"
      :sub-active-path="null"
      :sub-tracks="[]"
      @toggle-sub="subEnabled = !subEnabled"
      @sub-size="(s: number) => (subSize = s)"
      @sub-track="clearSubTrack"
      @exit-fullscreen="exitPip"
    />
    <div v-else class="pip-fallback" style="margin: auto">
      <div class="big">🎬</div>
      <p>
        {{ remuxError || "浏览器内核无法解码该格式（如 MKV / RMVB / AV1 等）" }}<br />
        请使用外部播放器打开
      </p>
    </div>
    <div v-if="hud" class="pip-hud">{{ hud }}</div>

    <!-- 上一个 / 下一个视频（队列循环） -->
    <button
      v-if="payload.list.length > 1"
      class="pip-nav prev"
      :class="{ hidden: !chromeVisible }"
      title="上一个视频（←）"
      @click="nav(-1)"
    >‹</button>
    <button
      v-if="payload.list.length > 1"
      class="pip-nav next"
      :class="{ hidden: !chromeVisible }"
      title="下一个视频（→）"
      @click="nav(1)"
    >›</button>

    <!-- 退出全屏：固定位于「下一个」按钮正下方、间距半个图标高度（22px），
         与上下一个按钮风格一致（44px 圆形半透明背景 + 白色线条图标） -->
    <button
      class="pip-nav fs"
      :class="{ hidden: !chromeVisible }"
      title="退出全屏（双击画面 / F 键 / Esc）"
      @click="exitPip"
      @dblclick.stop
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <!-- 「退出全屏」图标（向内收拢）：与「进入全屏」图标对称，明确表达"退出"语义 -->
        <path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" />
      </svg>
    </button>

    <!-- 缩略图条：底部居中、60×45px，可拖动横滑 + 点击跳转（与图片查看器一致） -->
    <div
      v-if="payload.list.length > 1"
      ref="stripEl"
      class="pip-strip"
      :class="{ hidden: !chromeVisible }"
      @dblclick.stop
      @wheel="onStripWheel"
      @mousedown.prevent="onStripDown"
      @mousemove="onStripMove"
      @mouseup="onStripUp"
      @mouseleave="onStripUp"
      @click.capture="onStripClickCapture"
    >
      <template v-for="(e, i) in payload.list" :key="e.path">
        <img
          v-if="thumbSrc(e)"
          :src="thumbSrc(e)"
          :class="{ cur: i === index }"
          loading="lazy"
          decoding="async"
          draggable="false"
          :title="e.name"
          @click="jumpTo(i)"
        />
        <div
          v-else
          class="thumb-ph"
          :class="{ cur: i === index }"
          :title="e.name"
          @click="jumpTo(i)"
        >🎬</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 1.0.2-r6：自定义控制栏为两行紧凑布局且可整体上移，缩略图条恢复贴底（12px），
   控制栏（queue>1 时 bottom=76px）与缩略条之间留有间隙，互不遮挡。 */
.pip-strip {
  bottom: 12px;
}
/* 1.0.2-r7 字幕 overlay：与主窗口同款样式（半透明底、居中、视频下部 13%） */
.pip-sub {
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
