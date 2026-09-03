<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { assetUrl, type Entry } from "../api";
import { closePipWindow, loadThumbs, openExternalWith, previewUrl, store, toggleMediaFullscreen, trashConfirm, trashPaths } from "../store";
import { useChrome, stripWheelScroll } from "../chrome";

// 关闭查看器时 store.modals.viewer 会先变 null，组件再卸载；这中间若有 watcher /
// 事件回调被触发，直接取 `!` 断言会抛空指针。这里退化成空队列，让读取点拿到
// undefined 而不是崩溃（组件随即被卸载，不会真的渲染空态）。
const viewer = computed(() => store.modals.viewer || { list: [] as Entry[], index: 0 });
const entry = computed<Entry>(
  () => viewer.value.list[viewer.value.index] || ({} as Entry)
);
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const rot = ref(0); // 旋转角度（0/90/180/270），切换图片时复位
// 控件伴随即隐：与视频播放器同一节奏
const { chromeVisible, wake, reveal, onLeave, dispose } = useChrome();

const stageEl = ref<HTMLElement | null>(null);
const imgEl = ref<HTMLImageElement | null>(null);
// 显式尺寸：fitW/fitH 始终记录图片「原始宽高×缩放系数」，旋转不改图片本身宽高比；
// 旋转后画布只需给图片一个旋转绘制空间（CSS transform 不拉伸）。
const fitW = ref(0);
const fitH = ref(0);

function computeFit() {
  const stage = stageEl.value;
  const img = imgEl.value;
  const nw = img?.naturalWidth || 0;
  const nh = img?.naturalHeight || 0;
  if (!stage || !nw || !nh) return;
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
  const availH = stage.clientHeight - parseFloat(cs.paddingTop || "0") - parseFloat(cs.paddingBottom || "0");
  // 防御：父级 display:none 或刚挂载时 availW/H 可能为 0，避免 NaN 写入 fitW/fitH
  if (availW <= 0 || availH <= 0) return;
  // 旋转 90°/270° 时：图片本身宽高不变，CSS transform rotate 围绕 transform-origin 旋转绘制区域，
  // 占用画布的水平/垂直空间会交换。按「交换后」的空间需求计算缩放 k，
  // 这样旋转后图片不会出现「被画布裁掉」或「撑大画布」。
  const drawW = rot.value % 180 === 90 ? nh : nw;
  const drawH = rot.value % 180 === 90 ? nw : nh;
  const k = Math.min((availW * 0.92) / drawW, (availH * 0.92) / drawH, 1);
  fitW.value = Math.round(nw * k);
  fitH.value = Math.round(nh * k);
}

// 1.0.1-r13 内存优化：大图查看改用 ≤2048px 降采样预览（原图可占数百 MB 内存），
// 先显示原图兜底，预览就绪后无缝替换；小图后端返回 null，保持原图。
const src = ref("");
let previewSeq = 0; // 防竞态：快速切换图片时过期预览请求不覆盖当前图
watch(
  () => entry.value.path,
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
// 缩略图条：优先用网格已生成的缩略图，其次封面，最后才回退原图（避免大批目录全量解码原图）
function thumbSrc(e: Entry): string {
  return store.thumbs[e.path] || (e.cover ? assetUrl(`${store.coversDir}/${e.cover}`) : assetUrl(e.path));
}

function nav(delta: number) {
  const n = viewer.value.list.length;
  if (n < 2) return;
  viewer.value.index = (viewer.value.index + delta + n) % n;
  reset();
  reveal();
}

const stripEl = ref<HTMLElement | null>(null);
function jump(i: number) {
  if (i === viewer.value.index) return;
  viewer.value.index = i;
  reset();
  reveal();
}
// 激活缩略图滚动到条带中部：直接赋值 scrollLeft（WKWebView 中 smooth scrollIntoView 不可靠）
function scrollStripActive() {
  const strip = stripEl.value;
  if (!strip) return;
  const cur = strip.querySelector("img.cur") as HTMLElement | null;
  if (!cur) return;
  strip.scrollLeft = cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2;
}

function reset() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
  rot.value = 0;
}

/**
 * 「适应窗口」：只把缩放与平移归位，**保留旋转角度**。
 * 旋转是用户主动设定的观看方向，点"适应窗口"只是想回到合适大小，
 * 不该顺手被掰正（此前直接复用 reset() 会连 rot 一起清零）。
 * 切换图片仍走 reset()（换图从头看，旋转复位）。
 */
function fitWindow() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
}

function rotate() {
  if (scale.value !== 1) {
    // 放大状态下旋转视觉跳变大且平移易出界：先回到适应窗口
    scale.value = 1;
    tx.value = 0;
    ty.value = 0;
  }
  // 角度累加不取模：若 270 → 0（取模），CSS transform 过渡会按差值 -270°
  // 逆时针转 270°（"倒转回正"）；累加后 270 → 360 差值恒为 +90°，
  // 过渡始终沿顺时针最短路径，视觉方向正确。rotate(360deg) 与 0° 等价，
  // 判断横竖用 rot % 180 依然成立。
  rot.value = rot.value + 90;
  wake();
}

/**
 * 以鼠标位置为中心的缩放：
 *   1. 记录鼠标相对 stage 的坐标 (mx, my)
 *   2. 缩放前，鼠标位置对应的「图片本地坐标」是 (mx - cx - tx) / scale, (my - cy - ty) / scale
 *   3. 缩放后，调整 tx/ty 使得同一图片本地坐标仍在鼠标位置
 *   ⇒ newTx = mx - cx - imageX * newScale, newTy = my - cy - imageY * newScale
 * 注：旋转状态下鼠标-图像局部坐标系的换算不再准确，缩放中心会略有偏移（不修）。
 */
function onWheel(e: WheelEvent) {
  if ((e.target as HTMLElement)?.closest?.(".img-strip")) return; // 悬停缩略图条时滚轮交给条带横滚
  e.preventDefault();
  const stage = stageEl.value;
  if (!stage) return;
  const oldScale = scale.value;
  const newScale = Math.min(6, Math.max(0.2, oldScale * (e.deltaY < 0 ? 1.12 : 0.89)));
  if (newScale === oldScale) return;
  // 鼠标在 stage 内的坐标
  const rect = stage.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // stage 中心（图片未平移/缩放前所在位置；translate 平移以中心为基准）
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  // 鼠标相对图片中心的图像本地坐标
  const imgX = (mx - cx - tx.value) / oldScale;
  const imgY = (my - cy - ty.value) / oldScale;
  // 缩放后保持同一本地坐标仍在鼠标位置
  tx.value = mx - cx - imgX * newScale;
  ty.value = my - cy - imgY * newScale;
  scale.value = newScale;
  wake();
}

let panning: { x: number; y: number } | null = null;
function onDown(e: MouseEvent) {
  panning = { x: e.clientX - tx.value, y: e.clientY - ty.value };
  wake();
}
function onMove(e: MouseEvent) {
  if (panning) {
    tx.value = e.clientX - panning.x;
    ty.value = e.clientY - panning.y;
  }
}
function onUp() {
  panning = null;
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
// 父级 stage 的 onWheel 会用 .img-strip 早退让行，这里在条带上先消费掉滚轮。
function onStripWheel(e: WheelEvent) {
  if (stripWheelScroll(e, stripEl.value)) wake();
}
// 在 strip 上拦截 click：当本次按下发生过拖动，不让点击穿透到 img 触发 jump
function onStripClickCapture(e: MouseEvent) {
  if (stripMoved) {
    e.stopPropagation();
    e.preventDefault();
  }
}

function closeViewer() {
  if (store.pipLabel) closePipWindow(); // 同步关闭独立全屏窗口
  store.modals.viewer = null;
}

/**
 * 进入独立全屏窗口：先把主窗口当前的旋转/缩放/平移写入 store.pipSeed，
 * openPipFromCurrentModal 会随初始 payload 传给 PiP 窗口 ——
 * 全屏窗口一打开即共用主窗口的画面变换，退出时又按 set_pip_state 回传恢复，
 * 做到全屏/非全屏双向同步（此前只回传不传递，进全屏会丢旋转状态）。
 */
function goFullscreen() {
  store.pipSeed = { rot: rot.value, scale: scale.value, tx: tx.value, ty: ty.value };
  toggleMediaFullscreen();
}

/**
 * 控件双击防误触（bugfix）：画布的 dblclick 用于「双击图片进入全屏」，但连续快速点击
 * 上一/下一/旋转等控件时会被误判成双击而触发全屏——原因是 dblclick 并不要求两次 click
 * 落在同一元素上：只要两次点击的 target 不同（控件显隐动画位移、或节点被 Vue 替换），
 * 浏览器就会在二者的**最近公共祖先**（画布）上派发 dblclick。
 * 双重拦截：① target 命中控件元素；② 600ms 内有过控件点击（覆盖 target 落到画布的情况）。
 */
const CTL_GUARD_MS = 600;
let ctlClickAt = 0;
function onStageClickCapture(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, .img-strip")) ctlClickAt = Date.now();
}
function onStageDblClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, .img-strip")) return; // 点在控件上
  if (Date.now() - ctlClickAt < CTL_GUARD_MS) return; // 刚点过控件
  goFullscreen();
}

/**
 * 退出独立全屏窗口：按回传的 index / 旋转 / 缩放 / 平移恢复主窗口画面。
 * 主窗口的查看器一直保持挂载（只是隐藏），所以这里只是把变换写回去，
 * 图片不会重新解码，也不会丢掉在全屏窗口里翻到的那一页。
 */
function applyPipResume() {
  if (!store.modals.viewer) return;
  const st = store.pipResult;
  if (!st) return;
  if (st.index >= 0 && st.index < viewer.value.list.length && st.index !== viewer.value.index) {
    viewer.value.index = st.index;
  }
  rot.value = Math.round(st.rot) || 0;
  scale.value = st.scale > 0 ? st.scale : 1;
  tx.value = Number.isFinite(st.tx) ? st.tx : 0;
  ty.value = Number.isFinite(st.ty) ? st.ty : 0;
  nextTick(() => {
    computeFit();
    scrollStripActive();
  });
}

function onKey(e: KeyboardEvent) {
  // 确认弹窗（如删除确认）打开时，Esc 只关闭确认层，不连带关闭查看器
  if (store.confirm) return;
  if (store.pipActive) return; // 全屏交互全在独立窗口，主窗口快捷键让位
  if (e.key === "Escape") {
    // 独立全屏窗口存在时 Esc 优先关闭它；否则关闭查看器
    if (store.pipLabel) closePipWindow();
    else closeViewer();
  } else if ((e.key === "f" || e.key === "F") && !e.repeat) {
    // F 键触发独立全屏窗口（与视频播放器一致）
    goFullscreen();
  } else if (e.key === "r" || e.key === "R") {
    if (!e.repeat) rotate();
  } else if (e.key === "ArrowRight") nav(1);
  else if (e.key === "ArrowLeft") nav(-1);
}

// 旋转 / 窗口缩放后重新计算适配
watch(rot, computeFit);
// 图片切换：**不清零** fitW/fitH —— 清零会让 img 瞬间回到原始像素尺寸
//（高分辨率图会"先突然放大再回正"）。保留旧尺寸作为过渡，新图
// @load 触发 computeFit 后立即换成新图的适配尺寸，肉眼几乎无感。
watch(
  () => viewer.value.index,
  () => {
    nextTick(scrollStripActive);
  }
);
// 退出独立全屏窗口 → 按回传状态恢复当前页与画面变换
watch(
  () => store.pipActive,
  (on) => {
    if (!on) nextTick(applyPipResume);
  }
);

onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("resize", computeFit);
  loadThumbs(viewer.value.list); // 批量补齐缩略图（网格可能只加载了当前目录）
  nextTick(scrollStripActive);
  // 打开即启动隐藏计时：否则打开后鼠标不动时上一/下一等控件会一直挂着
  wake();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
  window.removeEventListener("resize", computeFit);
  dispose();
});
</script>

<template>
  <div class="player-mask" @mousemove="wake()" @mouseleave="onLeave">
    <!-- 顶部信息栏：文件名、文件操作（适应窗口 / 删除 / 用默认看图软件打开 / 关闭）
         与上一/下一、旋转、全屏按钮、缩略图条同一节奏：静止即隐，一动即现 -->
    <div class="player-head" :class="{ 'nav-hidden': !chromeVisible }">
      <div class="t">{{ entry.name }}</div>
      <button class="btn" @click="fitWindow" v-if="scale !== 1 || rot % 360 !== 0">适应窗口</button>
      <button
        class="btn danger"
        @click="trashConfirm('删除图片', `确定将「${entry.name}」移入回收站吗？可在回收站中恢复。`, () => { trashPaths([entry.path]); closeViewer(); })"
      >
        删除
      </button>
      <button class="btn" @click="openExternalWith(entry.path, 'image')">用默认看图软件打开</button>
      <button class="btn" @click="closeViewer()">关闭</button>
    </div>
    <div
      ref="stageEl"
      class="img-stage"
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
      <!-- 进入 PiP 独立窗口（占满整屏）：位置与视频播放器一致（下一个按钮正下方），
           跟随控件显隐；图标风格与视频播放器完全一致。点击后主窗口 modal 隐藏，
           图片画面在独立 OS 窗口中显示；关闭独立窗口后主窗口 modal 恢复。 -->
      <button
        class="fs-btn"
        :class="{ 'nav-hidden': !chromeVisible }"
        title="在新窗口中查看（双击图片 / F 键切换）"
        @click="goFullscreen()"
        @dblclick.stop
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
        </svg>
      </button>
      <!-- 旋转按钮：固定在全屏按钮正下方（间距 22px = 半个按钮高度），
           与全屏按钮完全同风格（44px 圆形半透明底 + 白色线条图标），
           跟随控件一同显隐；保留 R 键快捷键。 -->
      <button
        class="fs-btn rot-btn"
        :class="{ 'nav-hidden': !chromeVisible }"
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
      <button
        v-if="viewer.list.length > 1"
        class="img-nav prev"
        :class="{ 'nav-hidden': !chromeVisible }"
        @dblclick.stop
        @click="nav(-1)"
      >‹</button>
      <button
        v-if="viewer.list.length > 1"
        class="img-nav next"
        :class="{ 'nav-hidden': !chromeVisible }"
        @dblclick.stop
        @click="nav(1)"
      >›</button>
      <!-- 底部缩略图条：60×45px（不遮挡主图）；支持鼠标拖动横向滑动 + 点击跳转 -->
      <div
        v-if="viewer.list.length > 1"
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
        <img
          v-for="(e, i) in viewer.list"
          :key="e.path"
          :src="thumbSrc(e)"
          :class="{ cur: i === viewer.index }"
          loading="lazy"
          decoding="async"
          draggable="false"
          :title="e.name"
          @click="jump(i)"
        />
      </div>
      <!-- 操作提示：移到查看器左下角，竖排显示（每行一项），文字左对齐；
           与其余控件同一节奏显隐（静止即隐，一动即现） -->
      <div
        class="img-count"
        :class="{ 'count-up': viewer.list.length > 1, 'nav-hidden': !chromeVisible }"
        v-if="viewer.list.length > 1"
      >
        <div>{{ viewer.index + 1 }} / {{ viewer.list.length }}</div>
        <div>滚轮缩放</div>
        <div>拖动平移</div>
        <div>R 旋转</div>
        <div>双击满屏</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 旋转按钮：固定在全屏按钮正下方（间距 22px = 半个按钮高度）。
   全屏按钮 top = 50% + 44px（即「下一个」按钮底边以下 22px），
   旋转按钮 top = 50% + 44px(全屏按钮 top) + 44px(全屏按钮高) + 22px(间距) = 50% + 110px。
   样式（44px 圆形半透明底 + 白色线条图标）继承自全局 .fs-btn，此处只覆盖 top。 */
.fs-btn.rot-btn {
  top: calc(50% + 110px);
}
</style>