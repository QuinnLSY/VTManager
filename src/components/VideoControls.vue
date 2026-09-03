<template>
  <div
    class="vc-bar"
    :class="{ 'vc-hidden': !visible }"
    :style="{ bottom: 10 + (bottomOffset ?? 0) + 'px' }"
    @dblclick.stop
    @click.stop
    @mousedown.stop
  >
    <!-- 悬停帧预览卡片：跟随鼠标、夹紧边界；精灵图未就绪时仅显示时间 -->
    <div
      v-if="hoverT >= 0"
      class="vc-preview"
      :class="{ scrubbing }"
      :style="{ left: previewLeft + 'px' }"
    >
      <div v-if="sheetReady" class="vc-frame" :style="frameStyle"></div>
      <div class="vc-time">{{ fmt(hoverT) }}</div>
    </div>

    <!-- 单行控制栏（1.0.2-r8）：进度条与播放/快退/快进/倍速/音量等主控件同一水平线、整体居中 -->
    <div class="vc-row">
      <button class="vc-btn" :title="playing ? '暂停（空格）' : '播放（空格）'" @click="togglePlay">
        <svg v-if="!playing" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="currentColor">
          <rect x="6.5" y="5" width="4" height="14" rx="1" />
          <rect x="13.5" y="5" width="4" height="14" rx="1" />
        </svg>
      </button>

      <button class="vc-btn" title="快退 10 秒（J）" @click="seekBy(-10)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 8H6.5V3.5" />
          <path d="M6.7 8.2A7.5 7.5 0 1 1 4.8 14" />
        </svg>
        <span class="vc-badge">10</span>
      </button>

      <!-- 进度条：行内弹性（与主控件水平居中），最大宽度限制避免过长 -->
      <div
        ref="barEl"
        class="vc-track"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
        @pointerleave="onLeave"
      >
        <div class="vc-rail">
          <div class="vc-buffered" :style="{ width: bufferedPct + '%' }"></div>
          <div class="vc-played" :style="{ width: playedPct + '%' }">
            <i class="vc-dot"></i>
          </div>
          <div v-if="hoverT >= 0" class="vc-cursor" :style="{ left: hoverPct + '%' }"></div>
        </div>
      </div>

      <button class="vc-btn" title="快进 10 秒（L）" @click="seekBy(10)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 8h4.5V3.5" />
          <path d="M17.3 8.2A7.5 7.5 0 1 0 19.2 14" />
        </svg>
        <span class="vc-badge">10</span>
      </button>

      <span class="vc-clock">{{ fmt(cur) }} <i>/</i> {{ fmt(dur) }}</span>

      <!-- 倍速：预设 0.25 / 0.5 / 0.75 / 1 / 1.5 / 2 + 自定义滑动条 2.0–6.0（步长 0.25） -->
      <div ref="rateWrapEl" class="vc-menu-wrap">
        <button
          class="vc-btn wide"
          :class="{ on: rate !== 1 }"
          title="播放速度（[ / ] 调节）"
          @click="rateOpen = !rateOpen"
        >
          <span class="vc-rate-text">{{ rateLabel }}</span>
        </button>
        <div v-if="rateOpen" class="vc-menu" @click.stop>
          <div
            v-for="r in PRESET_RATES"
            :key="r"
            class="vc-menu-item"
            :class="{ on: rate === r }"
            @click="setRate(r)"
          >
            {{ rateText(r) }}<em v-if="r === 1">正常</em>
          </div>
          <div class="vc-menu-sep"></div>
          <div class="vc-menu-title">自定义（{{ CUSTOM_RATE_MIN }}.0 – {{ CUSTOM_RATE_MAX }}.0，拖动滑块）</div>
          <div class="vc-custom-rate">
            <input
              class="vc-rate-slider"
              type="range"
              :min="CUSTOM_RATE_MIN"
              :max="CUSTOM_RATE_MAX"
              :step="CUSTOM_RATE_STEP"
              :value="sliderRate"
              title="自定义倍速"
              @input="onCustomRate"
              @keydown.stop
              @change="rateSliderBlur"
            />
            <span class="vc-rate-val">{{ sliderLabel }}</span>
          </div>
        </div>
      </div>

      <!-- 1.0.2-r7 字幕（CC）：同目录轨道 + 选择文件 + 显示开关 + 字号；主窗口额外提供截图目录设置 -->
      <div ref="subWrapEl" class="vc-menu-wrap">
        <button
          class="vc-btn cc"
          :class="{ on: subActive && subEnabled }"
          :title="subTitle"
          @click="subOpen = !subOpen"
        >
          <span class="vc-cc-text">CC</span>
          <i v-if="subActive" class="vc-cc-dot" :class="{ off: !subEnabled }"></i>
        </button>
        <div v-if="subOpen" class="vc-menu vc-sub-menu" @click.stop>
          <template v-if="subTracks && subTracks.length">
            <div class="vc-menu-title">同目录字幕</div>
            <div
              v-for="t in subTracks"
              :key="t.path"
              class="vc-menu-item"
              :class="{ on: t.path === subActivePath }"
              @click="pickTrack(t.path)"
            >
              <span class="vc-sub-name">{{ t.name }}</span>
              <em v-if="subBusy && t.path === subActivePath">加载中…</em>
              <em v-else-if="t.path === subActivePath">✓</em>
            </div>
            <div class="vc-menu-sep"></div>
          </template>
          <div class="vc-menu-item" @click="pickSubFile()">选择字幕文件…</div>
          <div v-if="subActive" class="vc-menu-item" @click="closeSub()">关闭字幕</div>
          <div class="vc-menu-sep"></div>
          <div class="vc-menu-title">显示</div>
          <div class="vc-menu-item" @click="emit('toggle-sub')">
            <span>字幕显示：{{ subEnabled ? "开" : "关" }}</span>
            <em>点击{{ subEnabled ? "关闭" : "开启" }}</em>
          </div>
          <div class="vc-menu-title">字号</div>
          <div class="vc-chips">
            <span
              v-for="s in SUB_SIZES"
              :key="s"
              class="vc-chip"
              :class="{ on: subSize === s }"
              @click="emit('sub-size', s)"
              >{{ s.toFixed(1) }}×</span
            >
          </div>
          <!-- 截图保存目录：仅主窗口播放器（全屏独立窗口不提供截图入口） -->
          <template v-if="pipMode !== 'exit-fullscreen'">
            <div class="vc-menu-sep"></div>
            <div class="vc-menu-item" @click="pickCaptureDir()">截图保存目录…</div>
          </template>
        </div>
      </div>

      <!-- 1.0.2-r7 截图：当前帧 → 原分辨率 PNG（仅主窗口播放器；全屏窗口由系统级截图代替） -->
      <button
        v-if="pipMode !== 'exit-fullscreen'"
        class="vc-btn"
        title="截图当前帧（S 键）"
        @click="emit('capture')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 8a2 2 0 0 1 2-2h1.6l1.4-1.8A1 1 0 0 1 8.8 3.8h6.4a1 1 0 0 1 .8.4L17.4 6H19a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z" />
          <circle cx="12" cy="13.2" r="3.6" />
          <path d="M17.6 8.2h.01" stroke-linecap="round" />
        </svg>
      </button>

      <!-- 画中画（全屏窗口内为「退出全屏」） -->
      <button class="vc-btn" :title="pipTitle" @click="onPipClick">
        <svg v-if="pipMode === 'exit-fullscreen'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
          <rect x="12" y="12" width="8" height="6" rx="1.2" fill="currentColor" stroke="none" />
        </svg>
      </button>

      <button class="vc-btn small" :title="muted ? '取消静音（M）' : '静音（M）'" @click="toggleMute">
        <svg v-if="muted || volume === 0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5 6 9H3v6h3l5 4V5z" />
          <path d="m16 9 5 6M21 9l-5 6" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5 6 9H3v6h3l5 4V5z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18.4 5.6a9 9 0 0 1 0 12.8" />
        </svg>
      </button>
      <input
        ref="volEl"
        class="vc-vol"
        type="range"
        min="0"
        max="1"
        step="0.05"
        :value="volume"
        title="音量"
        @input="onVolume"
        @keydown.stop
        @change="volEl?.blur()"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 自定义视频控制栏（1.0.2-r5 引入，r6 补齐播放器能力，r8 单行居中布局 + 倍速扩展）。
 * 原生时间轴无法挂鼠标事件，悬停帧预览必须自绘时间轴。
 *
 * 布局（r8）：单行——进度条与播放/快退/快进/倍速/音量等主控件同一水平线、整体居中；
 * 进度条为行内弹性条（有最大宽度限制），不再占独立一行。
 *
 * 功能：播放/暂停、快退/快进 10 秒、倍速（0.25/0.5/0.75/1/1.5/2 + 自定义滑动条
 * 2.0–6.0 步长 0.25）、画中画、静音 + 音量、缓冲/播放进度、拖动 seek、
 * 悬停实时帧预览（后端精灵图缓存）、字幕（CC）+ 截图。
 * 主窗口播放器与全屏独立窗口共用本组件。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { api, assetUrl, type ScrubSheetStatus, type SubtitleTrack } from "../api";

const props = defineProps<{
  video: HTMLVideoElement | null;
  /** 当前视频路径（精灵图按 (path+mtime) 缓存定位） */
  path: string;
  /** 控件栏显隐（与播放器整体 chrome 同步） */
  visible: boolean;
  /** 底部上移量（px）：队列 >1 时缩略图条占据底部，控制栏需让位 */
  bottomOffset?: number;
  /**
   * 画中画按钮语义：
   * - native（默认）：调浏览器 Picture-in-Picture（主窗口播放器）
   * - exit-fullscreen：全屏独立窗口内没有再画中画的意义，改为「退出全屏」
   */
  pipMode?: "native" | "exit-fullscreen";
  /** 1.0.2-r7 字幕：是否已加载字幕（cues 非空） */
  subActive?: boolean;
  /** 字幕显示开关 */
  subEnabled?: boolean;
  /** 字号系数（0.8 / 1 / 1.2 / 1.5） */
  subSize?: number;
  /** 同目录探测到的字幕轨道 */
  subTracks?: SubtitleTrack[];
  /** 当前加载轨道路径（用于菜单高亮；null = 未加载） */
  subActivePath?: string | null;
  /** 字幕读取/解析进行中 */
  subBusy?: boolean;
}>();

const emit = defineEmits<{
  (e: "exit-fullscreen"): void;
  (e: "toggle-sub"): void;
  (e: "sub-size", size: number): void;
  (e: "sub-track", path: string): void;
  (e: "sub-pick"): void;
  (e: "capture"): void;
  (e: "capture-dir"): void;
}>();

const playing = ref(false);
const cur = ref(0);
const dur = ref(0);
const bufferedPct = ref(0);
const muted = ref(false);
const volume = ref(1);
const barEl = ref<HTMLElement | null>(null);
const volEl = ref<HTMLInputElement | null>(null);

// ---------- 倍速 ----------
/** 预设档位（1.0.2-r8 新增 0.25 / 0.75） */
const PRESET_RATES = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;
/** 自定义区间（水平滑动条）：2.0 – 6.0，步长 0.25（最大倍速 1.0.2-r8 由 5 提至 6） */
const CUSTOM_RATE_MIN = 2;
const CUSTOM_RATE_MAX = 6;
const CUSTOM_RATE_STEP = 0.25;
const rate = ref(1);
const rateOpen = ref(false);
const rateWrapEl = ref<HTMLElement | null>(null);

/** 数字 → 显示文本（去尾零）：1 → "1×"、0.25 → "0.25×"、2.5 → "2.5×" */
function rateText(r: number): string {
  return `${r.toFixed(2).replace(/\.?0+$/, "")}×`;
}
const rateLabel = computed(() => rateText(rate.value));
/** 滑动条取值：当前倍速落在自定义区间内则跟随，否则取区间最小值 */
const sliderRate = computed(() =>
  rate.value >= CUSTOM_RATE_MIN && rate.value <= CUSTOM_RATE_MAX ? rate.value : CUSTOM_RATE_MIN
);
const sliderLabel = computed(() =>
  rate.value >= CUSTOM_RATE_MIN && rate.value <= CUSTOM_RATE_MAX
    ? rateText(rate.value)
    : `当前 ${rateText(rate.value)}`
);

function setRate(r: number) {
  rate.value = r;
  rateOpen.value = false;
  if (props.video) props.video.playbackRate = r;
}
/** 滑动条拖动（实时生效，保持菜单打开便于微调） */
function onCustomRate(e: Event) {
  const n = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(n) && n > 0) {
    rate.value = n;
    if (props.video) props.video.playbackRate = n;
  }
}
/** 拖动结束释放焦点：避免后续空格键触发滑动条而非播放/暂停 */
function rateSliderBlur() {
  (document.activeElement as HTMLInputElement | null)?.blur?.();
}
/** 按步长在 [0.25, 6] 内微调（供 [ / ] 快捷键使用；r8 步长 0.25、上限 6） */
function stepRate(delta: number) {
  const next = Math.min(
    CUSTOM_RATE_MAX,
    Math.max(0.25, Math.round((rate.value + delta) * 4) / 4)
  );
  setRate(next);
}

// ---------- 字幕（1.0.2-r7） ----------
const subWrapEl = ref<HTMLElement | null>(null);
const subOpen = ref(false);
/** 字号档位 */
const SUB_SIZES = [0.8, 1, 1.2, 1.5];

const activeTrackName = computed(() => {
  const p = props.subActivePath;
  if (!p) return "";
  return props.subTracks?.find((t) => t.path === p)?.name || "";
});

const subTitle = computed(() => {
  if (!props.subActive) return "字幕（无可用字幕）";
  if (!props.subEnabled) return `字幕已关闭（${activeTrackName.value || "已加载"}）`;
  return `字幕：${activeTrackName.value || "已加载"}（C 键开关）`;
});

// 菜单项操作后自动收起菜单（显示开关/字号保持打开，便于连续调节）
function pickTrack(path: string) {
  subOpen.value = false;
  emit("sub-track", path);
}
function pickSubFile() {
  subOpen.value = false;
  emit("sub-pick");
}
function closeSub() {
  subOpen.value = false;
  emit("sub-track", "");
}
function pickCaptureDir() {
  subOpen.value = false;
  emit("capture-dir");
}

// 菜单打开时点外部关闭
function onDocClick(e: MouseEvent) {
  if (rateWrapEl.value?.contains(e.target as Node)) return;
  if (subWrapEl.value?.contains(e.target as Node)) return;
  rateOpen.value = false;
  subOpen.value = false;
}
watch([rateOpen, subOpen], ([r, s]) => {
  if (r || s) document.addEventListener("click", onDocClick, true);
  else document.removeEventListener("click", onDocClick, true);
});

// ---------- 画中画 ----------
const pipActive = ref(false);
const pipTitle = computed(() => {
  if (props.pipMode === "exit-fullscreen") return "退出全屏（Esc / 双击画面）";
  return pipActive.value ? "退出画中画" : "画中画（浮窗播放）";
});

async function onPipClick() {
  if (props.pipMode === "exit-fullscreen") {
    emit("exit-fullscreen");
    return;
  }
  const v = props.video as (HTMLVideoElement & {
    webkitSetPresentationMode?: (m: string) => void;
    webkitPresentationMode?: string;
    requestPictureInPicture?: () => Promise<void>;
  }) | null;
  if (!v) return;
  try {
    if (pipActive.value) {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else v.webkitSetPresentationMode?.("inline");
      return;
    }
    // WKWebView（macOS）走 webkit 私有 API，Chromium 走标准 API
    if (typeof v.webkitSetPresentationMode === "function") v.webkitSetPresentationMode("picture-in-picture");
    else if (typeof v.requestPictureInPicture === "function") await v.requestPictureInPicture();
  } catch {
    /* 浏览器不支持时静默忽略 */
  }
}
function syncPip() {
  const v = props.video as (HTMLVideoElement & { webkitPresentationMode?: string }) | null;
  pipActive.value =
    !!v && (document.pictureInPictureElement === v || v.webkitPresentationMode === "picture-in-picture");
}

// ---------- 精灵图状态 ----------
const sheet = ref<ScrubSheetStatus | null>(null);
let pollTimer: number | undefined;
let pollStart = 0;

const sheetReady = computed(
  () => sheet.value?.status === "ready" && !!sheet.value.path && (sheet.value.interval ?? 0) > 0
);
const meta = computed(() =>
  sheet.value && sheetReady.value
    ? {
        tiles: sheet.value.tiles!,
        cols: sheet.value.cols!,
        rows: sheet.value.rows!,
        interval: sheet.value.interval!,
      }
    : null
);

function stopPoll() {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function fetchSheet(duration: number) {
  stopPoll();
  sheet.value = null;
  if (!props.path || !(duration > 0)) return;
  const tick = async () => {
    try {
      const s = await api.scrubSheet(props.path, duration);
      sheet.value = s;
      if (s.status === "generating") {
        // 超过 3 分钟放弃轮询（生成线程仍在后台跑完并落缓存）
        if (Date.now() - pollStart > 180_000) stopPoll();
      } else {
        stopPoll();
      }
    } catch {
      stopPoll(); // mock/异常环境静默降级为仅时间标签
    }
  };
  pollStart = Date.now();
  tick();
  pollTimer = window.setInterval(tick, 700);
}

// duration 就绪后触发精灵图获取；路径变化时重置
watch(
  () => [props.path, dur.value] as const,
  ([p], [oldP]) => {
    if (!p) return;
    if (p !== oldP) {
      sheet.value = null;
      cur.value = 0;
      bufferedPct.value = 0;
    }
    if (dur.value > 0) fetchSheet(dur.value);
  }
);

// ---------- video 事件绑定（元素可能随切换被替换） ----------
function bind(v: HTMLVideoElement | null, old?: HTMLVideoElement | null) {
  if (old) {
    old.removeEventListener("timeupdate", syncTime);
    old.removeEventListener("progress", syncBuffered);
    old.removeEventListener("durationchange", syncDur);
    old.removeEventListener("play", syncPlay);
    old.removeEventListener("pause", syncPlay);
    old.removeEventListener("volumechange", syncVolume);
    old.removeEventListener("ratechange", syncRate);
    old.removeEventListener("enterpictureinpicture", syncPip);
    old.removeEventListener("leavepictureinpicture", syncPip);
    old.removeEventListener("webkitpresentationmodechanged", syncPip);
  }
  if (!v) return;
  v.addEventListener("timeupdate", syncTime);
  v.addEventListener("progress", syncBuffered);
  v.addEventListener("durationchange", syncDur);
  v.addEventListener("play", syncPlay);
  v.addEventListener("pause", syncPlay);
  v.addEventListener("volumechange", syncVolume);
  v.addEventListener("ratechange", syncRate);
  v.addEventListener("enterpictureinpicture", syncPip);
  v.addEventListener("leavepictureinpicture", syncPip);
  v.addEventListener("webkitpresentationmodechanged", syncPip);
  syncDur();
  syncTime();
  syncPlay();
  syncVolume();
  syncPip();
  // 控件状态是「跨条目保持」的偏好：倍速/音量在切换视频后继续沿用
  v.playbackRate = rate.value;
  syncRate();
}

watch(
  () => props.video,
  (v, old) => bind(v, old)
);

function syncTime() {
  if (props.video) cur.value = props.video.currentTime || 0;
}
function syncDur() {
  const d = props.video?.duration;
  if (d && Number.isFinite(d)) dur.value = d;
}
function syncPlay() {
  playing.value = !!props.video && !props.video.paused && !props.video.ended;
}
function syncVolume() {
  const v = props.video;
  if (!v) return;
  volume.value = v.muted ? 0 : v.volume;
  muted.value = v.muted;
}
function syncRate() {
  const r = props.video?.playbackRate;
  // r8：保留 0.25 精度（此前 ×10 取整会把 0.25/0.75 吞成 0.3/0.8）
  if (r && Number.isFinite(r) && r > 0) rate.value = Math.round(r * 100) / 100;
}
function syncBuffered() {
  const v = props.video;
  if (!v || !(dur.value > 0)) return;
  // 取覆盖当前播放位置（或最远）的缓冲段，画近似缓冲条
  let end = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.end(i) > end) end = v.buffered.end(i);
  }
  bufferedPct.value = Math.min(100, (end / dur.value) * 100);
}

function togglePlay() {
  const v = props.video;
  if (!v) return;
  if (v.paused || v.ended) v.play().catch(() => {});
  else v.pause();
}
function toggleMute() {
  const v = props.video;
  if (!v) return;
  v.muted = !v.muted;
}
function onVolume(e: Event) {
  const v = props.video;
  if (!v) return;
  const n = Number((e.target as HTMLInputElement).value);
  v.muted = n === 0;
  v.volume = n;
}
/** 快退 / 快进（秒），夹紧在 [0, duration] */
function seekBy(delta: number) {
  const v = props.video;
  if (!v || !(dur.value > 0)) return;
  v.currentTime = Math.min(dur.value, Math.max(0, v.currentTime + delta));
  syncTime();
}

// ---------- 时间轴交互 ----------
const hoverT = ref(-1); // -1 = 不显示
const hoverX = ref(0);
const scrubbing = ref(false);

const playedPct = computed(() => (dur.value > 0 ? (cur.value / dur.value) * 100 : 0));
const hoverPct = computed(() => (dur.value > 0 ? (hoverT.value / dur.value) * 100 : 0));

/** 时间 → 贴片下标 */
const tileIndex = computed(() => {
  const m = meta.value;
  if (!m || !(m.interval > 0)) return -1;
  return Math.min(m.tiles - 1, Math.max(0, Math.floor(hoverT.value / m.interval)));
});

/** 贴片显示 240×135（1.5 倍放大），网格按此缩放定位 */
const TILE_DW = 240;
const TILE_DH = 135;
const frameStyle = computed(() => {
  const m = meta.value;
  const i = tileIndex.value;
  if (!m || i < 0 || !sheet.value?.path) return {};
  const col = i % m.cols;
  const row = Math.floor(i / m.cols);
  return {
    backgroundImage: `url("${assetUrl(sheet.value.path)}")`,
    backgroundSize: `${m.cols * TILE_DW}px ${m.rows * TILE_DH}px`,
    backgroundPosition: `${-col * TILE_DW}px ${-row * TILE_DH}px`,
  };
});

/**
 * 预览卡片水平位置：跟随鼠标但夹紧在控制栏两端内。
 * 进度条在行内弹性伸缩（随窗口宽度变化），因此基于 offsetLeft 实时计算，
 * 卡片跟随鼠标并夹紧在控制栏左右边界内。
 */
const PREVIEW_W = 240;
const previewLeft = computed(() => {
  const bar = barEl.value?.offsetParent as HTMLElement | null;
  const track = barEl.value;
  if (!bar || !track) return 0;
  const w = bar.clientWidth;
  const x = track.offsetLeft + hoverX.value;
  return Math.min(Math.max(x, PREVIEW_W / 2 + 4), Math.max(PREVIEW_W / 2 + 4, w - PREVIEW_W / 2 - 4));
});

function evToTime(e: PointerEvent): { t: number; x: number } {
  const bar = barEl.value!;
  const r = bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  return { t: ratio * (dur.value || 0), x: e.clientX - r.left };
}

function onMove(e: PointerEvent) {
  const { t, x } = evToTime(e);
  hoverT.value = t;
  hoverX.value = x;
  if (scrubbing.value && props.video && dur.value > 0) {
    props.video.currentTime = t; // 拖动实时 seek
  }
}

function onDown(e: PointerEvent) {
  if (!props.video || !(dur.value > 0)) return;
  scrubbing.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  const { t } = evToTime(e);
  hoverT.value = t;
  props.video.currentTime = t;
}

function onUp() {
  scrubbing.value = false;
}

function onLeave() {
  if (!scrubbing.value) hoverT.value = -1;
}

onBeforeUnmount(() => {
  stopPoll();
  document.removeEventListener("click", onDocClick, true);
});
// ---------- 时间格式化（≥1h 显示 h:mm:ss） ----------
function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 供父组件（快捷键）调用
defineExpose({ togglePlay, seekBy, stepRate, setRate });
</script>

<style scoped>
.vc-bar {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 14px 10px;
  background: rgba(8, 18, 30, 0.62);
  backdrop-filter: blur(10px);
  border-radius: 12px;
  z-index: 5;
  transition: opacity 0.35s ease;
  user-select: none;
}
.vc-bar.vc-hidden {
  opacity: 0;
  pointer-events: none;
}

.vc-row {
  display: flex;
  align-items: center;
  justify-content: center; /* 1.0.2-r8：进度条与主控件整体水平居中 */
  gap: 8px;
}
.vc-gap {
  display: none; /* r8 单行布局不再需要弹性空隙 */
}

.vc-btn {
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #e8f1fa;
  cursor: pointer;
  transition: background 0.15s;
}
.vc-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.vc-btn.on {
  color: #7cc0ff;
}
.vc-btn.wide {
  width: auto;
  min-width: 44px;
  padding: 0 8px;
}
.vc-btn svg {
  width: 20px;
  height: 20px;
}
.vc-btn.small svg {
  width: 17px;
  height: 17px;
}
/* 字幕按钮：CC 文字 + 状态圆点 */
.vc-btn.cc {
  font-weight: 700;
}
.vc-cc-text {
  font-size: 12.5px;
  letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
}
.vc-cc-dot {
  position: absolute;
  right: 5px;
  top: 6px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #4f9cf0;
}
.vc-cc-dot.off {
  background: #6b7f93;
}
/* 字幕菜单：比倍速菜单稍宽，轨道名可截断 */
.vc-sub-menu {
  width: 230px;
}
.vc-sub-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 8px;
}
/* 快进/快退按钮右下角的秒数角标 */
.vc-badge {
  position: absolute;
  right: -1px;
  bottom: -2px;
  padding: 0 2px;
  min-width: 14px;
  font-size: 8.5px;
  line-height: 11px;
  font-weight: 700;
  text-align: center;
  border-radius: 4px;
  background: rgba(8, 18, 30, 0.92);
  color: #e8f1fa;
}
.vc-rate-text {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.vc-clock {
  flex-shrink: 0;
  margin-left: 2px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: #b9cfe3;
  white-space: nowrap;
}
.vc-clock i {
  font-style: normal;
  opacity: 0.5;
  margin: 0 2px;
}

/* 倍速弹出菜单（向上弹出，避免被控制栏自身的圆角裁掉） */
.vc-menu-wrap {
  position: relative;
  flex-shrink: 0;
}
.vc-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  width: 190px;
  padding: 6px;
  border-radius: 10px;
  background: rgba(12, 22, 34, 0.96);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.12);
  z-index: 8;
}
.vc-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 12.5px;
  color: #e8f1fa;
  cursor: pointer;
  white-space: nowrap;
}
.vc-menu-item:hover {
  background: rgba(255, 255, 255, 0.1);
}
.vc-menu-item.on {
  background: rgba(79, 156, 240, 0.24);
  color: #9bd0ff;
}
.vc-menu-item em {
  font-style: normal;
  font-size: 10.5px;
  opacity: 0.6;
}
.vc-menu-sep {
  height: 1px;
  margin: 5px 4px;
  background: rgba(255, 255, 255, 0.12);
}
.vc-menu-title {
  padding: 2px 10px 6px;
  font-size: 10.5px;
  color: #8fa8bf;
}
.vc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 6px 4px;
}
.vc-chip {
  padding: 4px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #d6e5f3;
  cursor: pointer;
}
.vc-chip:hover {
  background: rgba(255, 255, 255, 0.16);
}
.vc-chip.on {
  background: rgba(79, 156, 240, 0.3);
  color: #9bd0ff;
}

/* 自定义倍速（1.0.2-r8）：水平滑动条 + 当前值 */
.vc-custom-rate {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px 8px;
}
.vc-rate-slider {
  flex: 1;
  min-width: 0;
  accent-color: #4f9cf0;
  cursor: pointer;
}
.vc-rate-val {
  flex-shrink: 0;
  min-width: 52px;
  text-align: right;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: #9bd0ff;
}

/* 时间轴（1.0.2-r8 起为行内弹性条，与主控件同一水平线居中；最大宽度限制避免过长） */
.vc-track {
  flex: 1 1 240px;
  max-width: 640px;
  min-width: 140px;
  padding: 7px 0; /* 扩大命中区 */
  cursor: pointer;
  touch-action: none;
}
.vc-rail {
  position: relative;
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.18);
  transition: height 0.12s ease;
}
.vc-track:hover .vc-rail {
  height: 7px;
}
.vc-buffered {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.28);
}
.vc-played {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
  background: #4f9cf0;
}
.vc-dot {
  position: absolute;
  right: -5px;
  top: 50%;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #fff;
  transform: translateY(-50%);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 0.15s;
}
.vc-track:hover .vc-dot {
  opacity: 1;
}
.vc-cursor {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 1.5px;
  background: rgba(255, 255, 255, 0.85);
}

/* 悬停帧预览卡片 */
.vc-preview {
  position: absolute;
  bottom: calc(100% + 12px);
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  z-index: 6;
}
.vc-frame {
  width: 240px;
  height: 135px;
  border-radius: 8px;
  background-color: #000;
  background-repeat: no-repeat;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.14);
}
.vc-preview.scrubbing .vc-frame {
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55), 0 0 0 2px rgba(79, 156, 240, 0.9);
}
.vc-time {
  margin-top: 5px;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(8, 18, 30, 0.85);
  color: #e8f1fa;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 音量条 */
.vc-vol {
  flex-shrink: 0;
  width: 64px;
  accent-color: #4f9cf0;
  cursor: pointer;
}
</style>
