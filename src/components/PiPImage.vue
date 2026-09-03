<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { assetUrl, type PipMedia, type PipPayload } from "../api";
import { previewUrl } from "../store";
import { stripWheelScroll } from "../chrome";

const props = defineProps<{
  entry: PipMedia;
  payload: PipPayload;
  index: number;
  chromeVisible: boolean;
  /** 主窗口进入全屏时的画面变换快照：一打开即沿用主窗口当前的旋转/缩放/平移 */
  initState?: { rot: number; scale: number; tx: number; ty: number };
}>();
const emit = defineEmits<{
  nav: [delta: number];
  state: [{ rot: number; scale: number; tx: number; ty: number }];
  exit: [];
  wake: [];
}>();

/** 把当前画面变换回传给父组件（主窗口退出全屏后据此恢复旋转/缩放/平移） */
function pushTransform() {
  emit("state", {
    rot: rot.value,
    scale: scale.value,
    tx: tx.value,
    ty: ty.value,
  });
}

// 初始值优先取主窗口进入全屏时的快照（全屏/非全屏同步共用画面变换）；
// 无快照（老版本后端 / 直接打开）时回退默认未变换
const init = props.initState;
const scale = ref(init?.scale && init.scale > 0 ? init.scale : 1);
const tx = ref(init?.tx ?? 0);
const ty = ref(init?.ty ?? 0);
const rot = ref(init?.rot ?? 0);
const stageEl = ref<HTMLElement | null>(null);
const imgEl = ref<HTMLImageElement | null>(null);
const stripEl = ref<HTMLElement | null>(null);

// 缩略图按图片本身比例自适应：
// fitW/fitH 记录图片原始适应尺寸；旋转 90°/270° 时按交换后的宽高计算，保证旋转不拉伸
const fitW = ref(0);
const fitH = ref(0);

function computeFit() {
  const stage = stageEl.value;
  const img = imgEl.value;
  const nw = img?.naturalWidth || 0;
  const nh = img?.naturalHeight || 0;
  if (!stage || !nw || !nh) return;
  const cs = getComputedStyle(stage);
  const padL = parseFloat(cs.paddingLeft || "0");
  const padR = parseFloat(cs.paddingRight || "0");
  const padT = parseFloat(cs.paddingTop || "0");
  const padB = parseFloat(cs.paddingBottom || "0");
  const availW = stage.clientWidth - padL - padR;
  const availH = stage.clientHeight - padT - padB;
  // 旋转后的实际占用宽高（图片本体宽高不变，旋转 90° 时绘制区域旋转）
  const drawW = rot.value % 180 === 90 ? nh : nw;
  const drawH = rot.value % 180 === 90 ? nw : nh;
  // 防御：父级 display:none 或刚挂载时 availW/H 可能为 0，避免 NaN 写入 fitW/fitH
  if (availW <= 0 || availH <= 0) return;
  const k = Math.min((availW * 0.92) / drawW, (availH * 0.92) / drawH, 1);
  fitW.value = Math.round(nw * k);
  fitH.value = Math.round(nh * k);
}

// 1.0.1-r13 内存优化：与主窗口查看器一致，大图改用 ≤2048px 降采样预览
const src = ref("");
let previewSeq = 0;
watch(
  () => props.entry.path,
  (p) => {
    if (!p) {
      src.value = "";
      return;
    }
    src.value = assetUrl(p);
    const seq = ++previewSeq;
    previewUrl(p).then((pv) => {
      if (pv && seq === previewSeq) src.value = pv;
    });
  },
  { immediate: true }
);
function thumbSrc(e: PipMedia): string {
  if (e.cover) return assetUrl(`${props.payload.covers_dir}/${e.cover}`);
  return assetUrl(e.path);
}

function nav(delta: number) {
  const n = props.payload.list.length;
  if (n < 2) return;
  // 通过 props.payload.index 是直接修改 reactive 对象；
  // 同时 emit 让父组件的 index ref 同步（用于 computed entry）
  const next = (props.payload.index + delta + n) % n;
  props.payload.index = next;
  emit("nav", 0);
  reset();
  emit("wake");
  nextTick(scrollStripActive);
}

function jumpTo(i: number) {
  const n = props.payload.list.length;
  if (n < 2) return;
  // 取最短方向：正向走 vs 反向走
  const cur = props.payload.index;
  let delta = (i - cur + n) % n;
  if (delta > n / 2) delta -= n;
  if (delta === 0) return;
  const next = (cur + delta + n) % n;
  props.payload.index = next;
  emit("nav", 0);
  reset();
  emit("wake");
  nextTick(scrollStripActive);
}

function reset() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  rot.value = 0;
  pushTransform();
}

function rotate() {
  if (scale.value !== 1) {
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
  }
  // 角度累加不取模（与主窗口 ImageViewer 一致）：
  // 270 → 360 保证 CSS 过渡沿顺时针最短路径回正，而非逆时针倒转 270°。
  rot.value = rot.value + 90;
  pushTransform();
  emit("wake");
  nextTick(computeFit);
}

/**
 * 以鼠标位置为中心的缩放（与主窗口 ImageViewer 同一逻辑）
 */
function onWheel(e: WheelEvent) {
  if ((e.target as HTMLElement)?.closest?.(".pip-strip")) return;
  e.preventDefault();
  const stage = stageEl.value;
  if (!stage) return;
  const oldScale = scale.value;
  const newScale = Math.min(6, Math.max(0.2, oldScale * (e.deltaY < 0 ? 1.12 : 0.89)));
  if (newScale === oldScale) return;
  const rect = stage.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const imgX = (mx - cx - tx.value) / oldScale;
  const imgY = (my - cy - ty.value) / oldScale;
  tx.value = mx - cx - imgX * newScale;
  ty.value = my - cy - imgY * newScale;
  scale.value = newScale;
  pushTransform();
  emit("wake");
}

let panning: { x: number; y: number } | null = null;
function onDown(e: MouseEvent) {
  panning = { x: e.clientX - tx.value, y: e.clientY - ty.value };
  emit("wake");
}
function onMove(e: MouseEvent) {
  if (panning) {
    tx.value = e.clientX - panning.x;
    ty.value = e.clientY - panning.y;
  }
}
function onUp() {
  if (panning) {
    panning = null;
    pushTransform();
  }
}

function scrollStripActive() {
  const strip = stripEl.value;
  if (!strip) return;
  const cur = strip.querySelector("img.cur") as HTMLElement | null;
  if (!cur) return;
  strip.scrollLeft = cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2;
}

// 缩略图条横向拖动：捕获鼠标水平拖动距离 → 转换为 scrollLeft。
// 配合移动阈值区分「拖动」与「点击缩略图」：拖动超过 4px 时不视为点击。
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
// 缩略图条滚轮：悬停条带转动滚轮即前后浏览（纵向滚轮转横向滚动，不缩放主图）；
// 父级 stage 的 onWheel 会用 .pip-strip 早退让行，这里在条带上先消费掉滚轮。
function onStripWheel(e: WheelEvent) {
  if (stripWheelScroll(e, stripEl.value)) emit("wake");
}
function onStripClickCapture(e: MouseEvent) {
  if (stripMoved) {
    e.stopPropagation();
    e.preventDefault();
  }
}

// 退出全屏：先由父组件（PiPRoot）落盘当前 index/变换再关窗 →
// 主窗口通过 pip-closed + take_pip_state 取回节点并继续查看。
// 独立窗口一打开就占满整屏；按钮 / 双击 / F 键 / Esc 全部统一为「退出全屏」。
function exitPip() {
  pushTransform();
  emit("exit");
}

/**
 * 控件双击防误触（bugfix）：画布的 dblclick 用于「双击图片退出全屏」，但连续快速点击
 * 上一/下一/旋转等控件时会被误判成双击而直接退出全屏——dblclick 不要求两次 click 落在
 * 同一元素：target 一旦不同（控件显隐动画位移、节点被替换），浏览器就会在二者的最近
 * 公共祖先（画布）上派发 dblclick。
 * 双重拦截：① target 命中控件元素；② 600ms 内有过控件点击。
 */
const CTL_GUARD_MS = 600;
let ctlClickAt = 0;
function onStageClickCapture(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, .pip-strip, .pip-count")) ctlClickAt = Date.now();
}
function onStageDblClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, .pip-strip, .pip-count")) return;
  if (Date.now() - ctlClickAt < CTL_GUARD_MS) return;
  exitPip();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    exitPip();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "r" || e.key === "R") {
    if (!e.repeat) rotate();
    return;
  }
  if (e.key === "f" || e.key === "F") {
    if (!e.repeat) exitPip();
    return;
  }
  if (e.key === "ArrowRight") nav(1);
  else if (e.key === "ArrowLeft") nav(-1);
}

watch(rot, computeFit);
watch(
  () => props.entry.path,
  () => {
    // 不清零 fitW/fitH（否则 img 闪回原始像素尺寸，先放大再回正）；
    // 此时新图尚未解码，naturalWidth 还是旧图的值，也不能立即 computeFit。
    // 交给 <img @load="computeFit"> 在新图解码完成后计算适配尺寸。
    nextTick(scrollStripActive);
  }
);

onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("resize", computeFit);
  nextTick(() => {
    computeFit();
    scrollStripActive();
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
  window.removeEventListener("resize", computeFit);
});
</script>

<template>
  <div
    ref="stageEl"
    class="pip-stage"
    @wheel="onWheel"
    @click.capture="onStageClickCapture"
    @dblclick="onStageDblClick"
  >
    <img
      ref="imgEl"
      :src="src"
      :style="{
        width: fitW ? fitW + 'px' : undefined,
        height: fitH ? fitH + 'px' : undefined,
        transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${scale})`,
        cursor: scale > 1 ? 'grab' : 'default',
      }"
      draggable="false"
      @load="computeFit"
      @mousedown.prevent="onDown"
    />

    <!-- 上一个 / 下一个图片 -->
    <button
      v-if="payload.list.length > 1"
      class="pip-nav prev"
      :class="{ hidden: !chromeVisible }"
      title="上一个图片（←）"
      @click="nav(-1)"
      @dblclick.stop
    >‹</button>
    <button
      v-if="payload.list.length > 1"
      class="pip-nav next"
      :class="{ hidden: !chromeVisible }"
      title="下一个图片（→）"
      @click="nav(1)"
      @dblclick.stop
    >›</button>

    <!-- 进入/退出全屏：固定位于「下一个」按钮正下方、间距半个图标高度（22px），
         与视频播放器位置一致；图标风格与视频播放器一致 -->
    <button
      class="pip-nav fs"
      :class="{ hidden: !chromeVisible }"
      title="退出 PiP（双击图片 / F 键）"
      @click="exitPip"
      @dblclick.stop
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <!-- 「退出全屏」图标（向内收拢） -->
        <path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" />
      </svg>
    </button>

    <!-- 旋转按钮：固定在全屏按钮正下方（间距 22px = 半个按钮高度），
         与全屏按钮完全同风格（44px 圆形半透明底 + 白色线条图标），
         跟随控件一同显隐；保留 R 键快捷键 -->
    <button
      class="pip-nav fs rot"
      :class="{ hidden: !chromeVisible }"
      title="旋转 90°（R）"
      @click="rotate"
      @dblclick.stop
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <!-- 方形画面 + 顺时针旋转箭头：主体是方形（代表图片），
             避免用圆形箭头被误认成"刷新" -->
        <rect x="3.5" y="9.5" width="11" height="11" rx="2" />
        <path d="M13.5 4a8 8 0 0 1 6.5 7" />
        <path d="M17 9.2l3 1.8 1.8-3" />
      </svg>
    </button>

    <!-- 缩略图条：底部居中、60×45px（不遮挡主图）、可拖动横向滑动 -->
    <div
      v-if="payload.list.length > 1"
      ref="stripEl"
      class="pip-strip"
      :class="{ hidden: !chromeVisible }"
      @wheel="onStripWheel"
      @mousedown.prevent="onStripDown"
      @mousemove="onStripMove"
      @mouseup="onStripUp"
      @mouseleave="onStripUp"
      @click.capture="onStripClickCapture"
    >
      <img
        v-for="(e, i) in payload.list"
        :key="e.path"
        :src="thumbSrc(e)"
        :class="{ cur: i === payload.index }"
        loading="lazy"
        decoding="async"
        draggable="false"
        :title="e.name"
        @click="jumpTo(i)"
      />
    </div>

    <div
      v-if="payload.list.length > 1"
      class="pip-count"
      :class="{ up: payload.list.length > 1, hidden: !chromeVisible }"
    >
      <div>{{ payload.index + 1 }} / {{ payload.list.length }}</div>
      <div>滚轮缩放</div>
      <div>拖动平移</div>
      <div>R 旋转</div>
      <div>双击退出 PiP</div>
    </div>
  </div>
</template>